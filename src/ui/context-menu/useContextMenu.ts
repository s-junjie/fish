import { useCallback, useMemo, useState } from "preact/hooks";
import { DesignDocument, DesignElement, getActivePage, updateActivePageElements } from "../../core/dsl/types";
import { isContainer, mapElements } from "../../core/geometry/tree-ops";
import { editableIds, setElementsLocked } from "../../core/geometry/lock";
import { isConvertibleToPath } from "../../core/geometry/path-convert";
import { reorderZIndex } from "../../core/interactions/alignment";
import { canCreateComponentHere } from "../../core/interactions/component-inventory";
import { findNodeById } from "../../core/interactions/component-swap";
import { overrideDerivedNodes } from "../../core/interactions/instance-overrides";
import { hasStoredSelection, isStoredNode } from "../../core/interactions/instance-resolve";
import { editorCommandEnabled, runEditorCommand } from "../commands/editor-commands";
import { beginImageCrop } from "../hooks/image-crop-edit";
import { t } from "../../i18n";
import type { ContextMenuEntry } from "./ContextMenu";

interface ContextMenuState {
  x: number;
  y: number;
  customEntries?: ContextMenuEntry[];
}

interface UseContextMenuOptions {
  docRef: { current: DesignDocument };
  commitSnapshot: (doc: DesignDocument) => void;
  selectedIds: Set<string>;
  onRenamePage?: (pageId: string) => void;
  onDuplicatePage?: (pageId: string) => void;
  onDeletePage?: (pageId: string) => void;
  /** Where a refused command explains itself — crop has three ways to refuse. */
  onHint?: (message: string) => void;
}

/**
 * The right-click menu: where it opens, what it lists, and the two commands it
 * owns outright (z-order, lock) — the rest are looked up in the command registry,
 * so the keyboard and the menu cannot disagree about what Copy does or whether
 * it is available.
 */
export function useContextMenu(options: UseContextMenuOptions) {
  const {
    docRef,
    commitSnapshot,
    selectedIds,
    onRenamePage,
    onDuplicatePage,
    onDeletePage,
    onHint
  } = options;

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const close = useCallback(() => setMenu(null), []);

  /**
   * Right-click on the canvas. It opens the menu for the CURRENT selection and
   * never changes it: a context menu is a command surface over what is already
   * selected, and silently retargeting the selection under the pointer means the
   * commands act on a layer the user did not pick.
   */
  const openCanvasContextMenu = useCallback(
    (e: any) => {
      // The on-canvas text editor is a textarea inside the canvas: a right-click
      // there belongs to the text editor, not to the canvas.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) {
        return;
      }
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY });
    },
    []
  );

  /** Right-click on a Layers row: the same rule — the row never joins the selection. */
  const openLayerContextMenu = useCallback((e: any) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  /** Right-click on a Page item in the layer panel */
  const openPageContextMenu = useCallback(
    (e: MouseEvent, page: { id: string; name: string }) => {
      e.preventDefault();
      e.stopPropagation();
      const pageEntries: ContextMenuEntry[] = [
        {
          id: "rename-page",
          label: t("pages.rename"),
          onSelect: () => {
            close();
            onRenamePage?.(page.id);
          }
        },
        ...(onDuplicatePage
          ? [
              {
                id: "duplicate-page",
                label: t("pages.duplicate"),
                onSelect: () => {
                  close();
                  onDuplicatePage(page.id);
                }
              }
            ]
          : []),
        ...(onDeletePage
          ? [
              { separator: true as const },
              {
                id: "delete-page",
                label: t("pages.delete"),
                disabled: (docRef.current.pages?.length ?? 1) <= 1,
                title: (docRef.current.pages?.length ?? 1) <= 1 ? t("pages.cannotDeleteOnlyPage") : undefined,
                onSelect: () => {
                  close();
                  onDeletePage(page.id);
                }
              }
            ]
          : [])
      ];

      setMenu({
        x: e.clientX,
        y: e.clientY,
        customEntries: pageEntries
      });
    },
    [docRef, close, onRenamePage, onDuplicatePage, onDeletePage]
  );

  const setSelectionLock = useCallback(
    (locked: boolean) => {
      if (selectedIds.size === 0) return;
      /**
       * The same question the row's LABEL is drawn from, asked the same way: is
       * every selected layer already locked. Reading it through `editableIds` —
       * which keeps an id with no element behind it — answered "nothing here is
       * locked" for a layer inside an instance, so the menu's Unlock took the
       * explicit-write path below and that path has no entry in the tree to write.
       */
      const allLocked = [...selectedIds]
        .map((id) => findNodeById(docRef.current, id))
        .every((el) => el?.locked === true);
      // Reuse the shared toggle when it is in the opposite state: the inspector
      // padlock and Shift+Cmd+L already agree on what "toggle" means, and it owns
      // the undo step. A mixed selection needs the explicit write instead, because
      // a toggle cannot split it — and that write takes the instance route for the
      // layers an instance projects, the tree for the rest.
      if (allLocked !== locked && runEditorCommand("toggleLockSelection")) {
        return;
      }
      const derived = overrideDerivedNodes(docRef.current, selectedIds, (el) => ({ ...el, locked }));
      const base = derived ? derived.doc : docRef.current;
      commitSnapshot(
        updateActivePageElements(base, setElementsLocked(getActivePage(base).children, selectedIds, locked))
      );
    },
    [docRef, commitSnapshot, selectedIds]
  );

  const reorderSelection = useCallback(
    (action: "front" | "back") => {
      const ids = editableIds(getActivePage(docRef.current).children, selectedIds);
      if (ids.size === 0) return;
      const current = getActivePage(docRef.current).children;
      const next = reorderZIndex(current, ids, action);
      if (next === current) return;
      commitSnapshot(updateActivePageElements(docRef.current, next));
    },
    [docRef, commitSnapshot, selectedIds]
  );

  /**
   * The right-click twin of the inspector's mask toggle: set `isMask` on the
   * selection. A mask hides the siblings that follow it in the same parent, so
   * the command is offered for a single, stored layer — the same guard the crop
   * and group rows use, because a resolved clone has no id in the tree to write.
   *
   * Writes through `mapElements` so it reaches a layer nested in a frame, exactly
   * as the inspector's `onMutate` does — a flat `elements.map` skips every
   * child of a container and the toggle silently does nothing for frame contents.
   */
  const toggleMaskOnSelection = useCallback(() => {
    const ids = editableIds(getActivePage(docRef.current).children, selectedIds);
    if (ids.size === 0) return;
    const doc = docRef.current;
    const selected = [...selectedIds]
      .map((id) => findNodeById(doc, id))
      .filter((el): el is DesignElement => Boolean(el));
    if (selected.length === 0) return;
    const nextIsMask = !(selected[0].isMask ?? false);
    const target = new Set(ids);
    const updatedElements = mapElements(getActivePage(doc).children, (el) =>
      target.has(el.id) ? { ...el, isMask: nextIsMask } : el
    );
    commitSnapshot(updateActivePageElements(doc, updatedElements));
  }, [docRef, commitSnapshot, selectedIds]);

  const entries = useMemo<ContextMenuEntry[]>(() => {
    if (!menu) return [];
    if (menu.customEntries) return menu.customEntries;

    /** A row backed by a registered command: one implementation, two entry points. */
    const registered = (id: string, hint: string): ContextMenuEntry => ({
      id,
      label: t(`contextMenu.${id}`),
      hint,
      disabled: !editorCommandEnabled(id),
      onSelect: () => runEditorCommand(id)
    });

    const doc = docRef.current;
    /**
     * The selection as the rest of the editor resolves it, layers inside an
     * instance included.
     *
     * A resolved clone is painted but never stored, so `findElementById` — the
     * lookup this used to do — answered "nothing is selected" for a layer the user
     * had just clicked inside an instance, and the menu collapsed to the two rows
     * that do not read the selection at all. The rows that DO read it (Copy, Copy
     * properties, Copy as PNG) were reachable from the keyboard the whole time.
     */
    const selected = [...selectedIds]
      .map((id) => findNodeById(doc, id))
      .filter((el): el is DesignElement => Boolean(el));
    const hasSelection = selected.length > 0;
    const single = selected.length === 1 ? selected[0] : null;
    /**
     * Whether the document tree holds any of this selection.
     *
     * The commands that write back by id and have NO instance route — restack,
     * group, crop — have nowhere to put an edit addressed at a resolved clone, so
     * they grey out rather than close the menu and change nothing. Lock is not one
     * of them: it and Delete both become overrides on the instance.
     */
    const hasStored = hasStoredSelection(doc, selectedIds);

    // Nothing selected: the menu is a paste target and nothing else, so it offers
    // nothing that would act on a selection the user cannot see.
    if (!hasSelection) {
      return [registered("paste", "⌘V"), { separator: true }, registered("pasteStyle", "⌥⌘V")];
    }
    const allLocked = hasSelection && selected.every((el) => el.locked === true);

    // The top-most bitmap row — the same one the canvas double-click picks. It is
    // the image the user is looking at; the rows under it are covered by it.
    const cropPaintIndex = single
      ? (single.fills ?? []).reduce((top, f, i) => (f.type === "image" ? i : top), -1)
      : -1;

    const list: ContextMenuEntry[] = [
      registered("cut", "⌘X"),
      registered("copy", "⌘C"),
      registered("paste", "⌘V"),
      registered("duplicate", "⌘D"),
      registered("copyAsPng", "⇧⌘C"),
      { separator: true },
      registered("copyStyle", "⌥⌘C"),
      registered("pasteStyle", "⌥⌘V"),
      { separator: true },
      // Group / ungroup are offered from here because the keyboard covers them but
      // the mouse does not: a structural edit is exactly the one a user reaches
      // for via right-click. Ungroup needs a single container, or there is nothing
      // whose "contents" the phrase could mean.
      {
        id: "group",
        label: t("contextMenu.group"),
        hint: "⌘G",
        disabled: !hasStored || !editorCommandEnabled("group"),
        onSelect: () => {
          close();
          runEditorCommand("group");
        }
      },
      {
        id: "ungroup",
        label: t("contextMenu.ungroup"),
        hint: "⇧⌘G",
        disabled: !single || !hasStored || !isContainer(single) || !editorCommandEnabled("ungroup"),
        onSelect: () => {
          close();
          runEditorCommand("ungroup");
        }
      },
      // Flatten is offered only when it would do something: a text layer or a
      // frame has no curve in it, and a greyed-out row is just noise.
      ...(selected.some((el) => el.type === "path" || isConvertibleToPath(el))
        ? [
            {
              id: "flatten",
              label: t("contextMenu.flatten"),
              hint: "⌘E",
              disabled: !editorCommandEnabled("flatten"),
              onSelect: () => {
                close();
                runEditorCommand("flatten");
              }
            }
          ]
        : []),
      // Figma's ⇧⌘O. On-path text is excluded: its glyphs are placed along a
      // curve, which this does not do yet.
      ...(single?.type === "text" && !single.onPath ? [registered("outlineText", "⇧⌘O")] : []),
      // Figma parity: the same thing the canvas double-click reaches, for the hand
      // that is already on the right button. Offered only for a lone layer that
      // paints a bitmap — a framing is a statement about ONE image row, and a
      // multi-selection has no one row for it to be about.
      ...(cropPaintIndex >= 0 && single
        ? [
            {
              id: "cropImage",
              label: t("contextMenu.cropImage"),
              disabled: single.locked === true || !isStoredNode(doc, single.id),
              onSelect: () => {
                close();
                void beginImageCrop({
                  docRef,
                  commitSnapshot,
                  target: { elId: single.id, paintIndex: cropPaintIndex },
                  hint: onHint
                });
              }
            }
          ]
        : []),
      {
        id: "bringToFront",
        label: t("contextMenu.bringToFront"),
        hint: "]",
        disabled: !hasStored,
        onSelect: () => reorderSelection("front")
      },
      {
        id: "sendToBack",
        label: t("contextMenu.sendToBack"),
        hint: "[",
        disabled: !hasStored,
        onSelect: () => reorderSelection("back")
      }
    ];

    // The right-click twin of the inspector's mask toggle. Offered for a single,
    // stored layer: a mask hides the siblings that follow it in the same parent,
    // so the command has one layer to be about, and a resolved clone has no id in
    // the tree to write (the crop row is gated the same way).
    if (single) {
      list.push({ separator: true });
      list.push({
        id: "toggleMask",
        label: t(single.isMask ? "mask.remove" : "mask.use"),
        title: !hasStored ? t("contextMenu.maskLockedHint") : undefined,
        disabled: !hasStored,
        onSelect: () => {
          close();
          toggleMaskOnSelection();
        }
      });
    }

    if (single && single.type === "frame") {
      const isCurrentThumb = doc.thumbnailNodeId === single.id || (single as any).isThumbnail === true;
      list.push({
        id: "toggleThumbnail",
        label: t(isCurrentThumb ? "contextMenu.restoreDefaultThumbnail" : "contextMenu.setAsThumbnail"),
        disabled: !hasStored,
        onSelect: () => {
          close();
          const currentDoc = docRef.current;
          if (isCurrentThumb) {
            const nextDoc = { ...currentDoc };
            delete nextDoc.thumbnailNodeId;
            commitSnapshot(nextDoc);
          } else {
            commitSnapshot({
              ...currentDoc,
              thumbnailNodeId: single.id
            });
          }
        }
      });
    }


    if (single && canCreateComponentHere(getActivePage(doc).children, single)) {
      list.push(registered("createComponent", "⌥⌘K"));
    }
    // The inspector's Vector section only exists in edit mode, so this and Enter
    // are the two ways in. Offered for a lone path: "edit" on a multi-selection
    // has no single thing to apply to.
    if (single?.type === "path") {
      list.push({
        id: "editPath",
        label: t("contextMenu.editPath"),
        hint: "⏎",
        disabled: !editorCommandEnabled("editPath"),
        onSelect: () => {
          close();
          runEditorCommand("editPath");
        }
      });
    }
    // Component actions used to exist only in the right-hand panel, so placing an
    // instance of a definition, tracing an instance back to its master, or undoing
    // an instance's changes all meant finding the panel first.
    if (single?.type === "component") {
      list.push(registered("createInstance", ""));
    }
    if (single?.type === "instance") {
      // No swap entry: picking a target needs a list, and a flat menu cannot hold
      // one. Swapping lives in the panel's picker and in the canvas gesture —
      // dropping a component card straight onto the instance.
      list.push(registered("resetInstanceChanges", ""));
      list.push(registered("goToMainComponent", ""));
      list.push(registered("detachInstance", "⌥⌘B"));
    } else if (single && editorCommandEnabled("goToMainComponent")) {
      // A layer INSIDE an instance resolves to the same master, which is the
      // common case: the user has double-clicked in and wants the definition.
      list.push(registered("goToMainComponent", ""));
    }
    if (single) list.push({ separator: true });
    list.push({
      id: "lock",
      label: t(allLocked ? "contextMenu.unlock" : "contextMenu.lock"),
      hint: "⇧⌘L",
      disabled: !hasSelection,
      onSelect: () => setSelectionLock(!allLocked)
    });
    list.push(registered("delete", "⌫"));
    return list;
    // `single` is derived inside the memo from `selectedIds`, so it is not a dep.
  }, [menu, docRef, commitSnapshot, selectedIds, reorderSelection, setSelectionLock, onHint]);

  return {
    contextMenu: menu,
    contextMenuEntries: entries,
    closeContextMenu: close,
    openCanvasContextMenu,
    openLayerContextMenu,
    openPageContextMenu
  };
}
