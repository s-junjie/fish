import { useCallback, useEffect, useMemo, useRef } from "preact/hooks";
import {
  DesignDocument,
  DesignElement,
  FrameElement,
  TextElement,
  getActivePage,
  updateActivePageElements
} from "../../core/dsl/types";
import { createId } from "../../core/id";
import { elementAABB } from "../../core/geometry/element-bounds";
import { editableIds, setElementsLocked } from "../../core/geometry/lock";
import {
  findElementById,
  dissolveFrame,
  flattenElements,
  isContainer,
  mapElements,
  reparentSelectionIntoFrame
} from "../../core/geometry/tree-ops";
import { flattenElement } from "../../core/geometry/path-ops";
import { collectTopMostSelected } from "../../core/interactions/clipboard";
import { dissolveComponentSet } from "../../core/interactions/component-set-tree";
import { buildWrapFrame } from "../../core/interactions/wrap";
import { alignElements, AlignmentType } from "../../core/interactions/alignment";
import { performBooleanOperation, BooleanOp } from "../../core/geometry/boolean-ops";
import { overrideDerivedNodes } from "../../core/interactions/instance-overrides";
import { hasStoredSelection, isStoredNode } from "../../core/interactions/instance-resolve";
import { relayoutDocumentTree } from "../../core/compile";
import { registerEditorCommand } from "../commands/editor-commands";
import { outlineText as buildTextOutline } from "../canvas/outline-text";
import { hasLocalFonts, supportsLocalFonts } from "../../core/fonts/local-font-access";
import type { OutlineFontFailure } from "../canvas/outline-font-source";
import { t } from "../../i18n";

const OUTLINE_FAILURE_KEY: Record<OutlineFontFailure, string> = {
  "no-api": "contextMenu.outlineTextNoAccess",
  denied: "contextMenu.outlineTextNoAccess",
  empty: "contextMenu.outlineTextNoFonts",
  "no-face": "contextMenu.outlineTextNoFont",
  unreadable: "contextMenu.outlineTextUnreadable"
};

/** One sentence the user can act on, with the family that failed. */
function outlineFailureMessage(
  failure: { failure: OutlineFontFailure; detail: string } | null
): string {
  if (!failure) return t("contextMenu.outlineTextUnavailable");
  return `${t(OUTLINE_FAILURE_KEY[failure.failure])}: ${failure.detail}`;
}

export interface UseStructuralCommandsOptions {
  docRef: { current: DesignDocument };
  commitSnapshot: (doc: DesignDocument) => void;
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  /** The selection as this render resolved it, instances included. */
  selectedElements: DesignElement[];
  /** The part of the selection that exists in the tree as a real node. */
  realSelected: DesignElement[];
  showHint: (msg: string) => void;
  startPathEdit: (el: DesignElement) => void;
}

/**
 * Every command that restructures the selection: group, wrap, ungroup, flatten,
 * boolean, align, lock and Edit Path.
 *
 * The zero-argument ones are registered by name rather than handed to the two
 * surfaces that call them. That is not bookkeeping: a keyboard handler closes
 * over whatever it captured when it registered, so a handler held as a prop runs
 * against the selection of an earlier render — and `Cmd+G` would frame the boxes
 * the elements had before the last undo. A registered command is looked up at the
 * moment it runs and reads the live document through the ref below.
 *
 * The ones that take an argument (which boolean operation, which alignment, which
 * wrap mode) are returned instead: they are a parameterised channel, not a named
 * command, and the registry only holds zero-argument entries.
 */
export function useStructuralCommands({
  docRef,
  commitSnapshot,
  selectedIds,
  setSelectedIds,
  selectedElements,
  realSelected,
  showHint,
  startPathEdit
}: UseStructuralCommandsOptions) {
  // Read at call time, never captured: these are the values that make a command
  // act on the wrong selection when they go stale.
  const live = useRef({ selectedIds, selectedElements, realSelected });
  live.current = { selectedIds, selectedElements, realSelected };

  const editableSelection = useCallback(
    () => editableIds(getActivePage(docRef.current).children, live.current.selectedIds),
    [docRef]
  );

  /** True when the selection holds nothing this command may touch, hint included. */
  const refuseLocked = useCallback((): boolean => {
    const { selectedIds: ids } = live.current;
    if (editableSelection().size > 0) return false;
    if (ids.size > 0) showHint(t("component.derivedChildLocked"));
    return true;
  }, [editableSelection, showHint]);

  // Replace `wrapped` with `frame` in the tree, nesting the frame inside the
  // wrapped elements' common parent (so grouping inside a frame stays in place)
  // and re-basing the children into the frame's local space.
  const replaceSelectionWithFrame = useCallback(
    (frame: FrameElement, wrapped: DesignElement[]) => {
      const cur = getActivePage(docRef.current);
      const nextElements = reparentSelectionIntoFrame(cur.children, wrapped, frame);
      commitSnapshot(updateActivePageElements(docRef.current, nextElements));
      setSelectedIds(new Set([frame.id]));
    },
    [commitSnapshot, docRef, setSelectedIds]
  );

  /**
   * What Group would wrap: the selected layers the tree stores and a lock does not
   * hold, in selection order.
   *
   * Structural commands act on the editable part of the selection, and a layer
   * inside an instance is not part of it: it is painted but never stored, so
   * `reparentSelectionIntoFrame` had nothing to take out of the tree and put the
   * clone into the new frame anyway — an uneditable ghost of a layer that was
   * still on screen twice. Shared with the command's own `enabled` predicate so
   * the row cannot offer a group the run would decline.
   */
  const groupableElements = useCallback(
    () =>
      live.current.selectedElements.filter(
        (el) => !el.locked && isStoredNode(docRef.current, el.id)
      ),
    [docRef]
  );

  const group = useCallback(
    (asFrame: boolean) => {
      const groupable = groupableElements();
      if (groupable.length === 0) return;
      const minX = Math.min(...groupable.map((e) => elementAABB(e).x));
      const minY = Math.min(...groupable.map((e) => elementAABB(e).y));
      const maxX = Math.max(...groupable.map((e) => elementAABB(e).x + elementAABB(e).width));
      const maxY = Math.max(...groupable.map((e) => elementAABB(e).y + elementAABB(e).height));

      const newFrame: FrameElement = {
        id: createId("frame"),
        type: "frame",
        name: "Frame",
        x: minX,
        y: minY,
        width: Math.max(10, maxX - minX),
        height: Math.max(10, maxY - minY),
        children: [...groupable],
        fills: asFrame ? [{ type: "solid", color: "#FFFFFF" }] : [],
        clipContent: asFrame
      };

      replaceSelectionWithFrame(newFrame, groupable);
    },
    [groupableElements, replaceSelectionWithFrame]
  );

  const ungroup = useCallback(() => {
    const selection = live.current.selectedElements;
    if (selection.length !== 1) return;
    const target = selection[0];
    if (!isContainer(target)) return;
    // A resolved clone is not in the tree, so `dissolveFrame` finds nothing to
    // dissolve and the commit below would be an undo step that changed nothing.
    if (!isStoredNode(docRef.current, target.id)) return;
    // A set dissolves rather than dissolves-as-a-frame: the members have to lose
    // `setId` and `variant` too, or they would still group in the assets panel and
    // Ungroup would read as having done nothing. `dissolveFrame` also releases to
    // canvas-absolute coordinates, which is only right for a top-level frame.
    if (target.type === "componentSet") {
      const dissolved = dissolveComponentSet(docRef.current, target.id);
      if (!dissolved) return;
      commitSnapshot(dissolved);
      setSelectedIds(new Set((target.children || []).map((c) => c.id)));
      return;
    }
    const { elements: nextElements, releasedIds } = dissolveFrame(getActivePage(docRef.current).children, target.id);
    commitSnapshot(updateActivePageElements(docRef.current, nextElements));
    setSelectedIds(new Set(releasedIds));
  }, [commitSnapshot, docRef, setSelectedIds]);

  /**
   * What Wrap would frame: the editable part of the selection that the tree stores.
   * Shared with the command's `enabled` predicate, because "more than one selected
   * id" is not the same question — the tree walk drops every layer inside an
   * instance, so two of those reported themselves wrappable and wrapped nothing.
   */
  const wrapTargets = useCallback(() => {
    const elements = getActivePage(docRef.current).children;
    return collectTopMostSelected(elements, editableIds(elements, live.current.selectedIds));
  }, [docRef]);

  const wrap = useCallback(
    (mode: "flex" | "grid") => {
      const top = wrapTargets();
      if (top.length < 2) return;
      const frame = buildWrapFrame(top, { mode });
      if (!frame) return;
      replaceSelectionWithFrame(frame, top);
    },
    [replaceSelectionWithFrame, wrapTargets]
  );

  const flatten = useCallback(() => {
    if (refuseLocked()) return;
    const cur = getActivePage(docRef.current);
    const ids = editableIds(cur.children, live.current.selectedIds);
    commitSnapshot(
      updateActivePageElements(
        docRef.current,
        mapElements(cur.children, (el) => (ids.has(el.id) ? flattenElement(el) : el))
      )
    );
  }, [commitSnapshot, docRef, refuseLocked]);

  /**
   * Replace each selected text layer with the paths its glyphs draw, one path per
   * glyph, inside a frame.
   *
   * Asynchronous, because the font file has to be fetched and parsed. That is
   * also why a layer whose font cannot be read is left untouched: the whole
   * point is that the result is the real outline, and an approximation would be
   * a silent downgrade the user only notices when they drag an anchor.
   *
   * The frame is what keeps this a one-for-one replacement. `mapElements` below
   * swaps a layer in place, so a command that emitted N top-level paths would
   * leave the tree with a text slot and no way to fill it.
   */
  const outlineText = useCallback(() => {
    if (refuseLocked()) return;
    const cur = getActivePage(docRef.current);
    const ids = editableIds(cur.children, live.current.selectedIds);
    const targets = live.current.selectedElements.filter(
      (el): el is TextElement => el.type === "text" && ids.has(el.id) && !el.onPath?.pathId
    );
    if (targets.length === 0) return;
    if (!hasLocalFonts()) showHint(t("contextMenu.outlineTextReading"));

    void (async () => {
      const replacements = new Map<string, FrameElement>();
      let failure: { failure: OutlineFontFailure; detail: string } | null = null;
      for (const el of targets) {
        const result = await buildTextOutline(el);
        if (result.ok) replacements.set(el.id, result.node);
        else if (!failure) failure = { failure: result.failure, detail: result.detail };
      }
      if (replacements.size === 0) {
        const message = outlineFailureMessage(failure);
        // The toast is one line; the four failure modes have four different
        // fixes, so the full reason also goes somewhere it can be read.
        console.warn("[outlineText]", message, failure);
        showHint(message);
        return;
      }
      const page = getActivePage(docRef.current);
      commitSnapshot(
        updateActivePageElements(
          docRef.current,
          mapElements(page.children, (el) => replacements.get(el.id) ?? el)
        )
      );
      // The selection follows the REPLACEMENTS, not the ids that were replaced:
      // the frame is a new layer, so the text's id no longer resolves and
      // selecting the old keys would leave the user holding nothing.
      setSelectedIds(new Set([...replacements.values()].map((node) => node.id)));
    })();
  }, [commitSnapshot, docRef, refuseLocked, setSelectedIds, showHint]);

  /**
   * Lock everything unless every selected layer is already locked, in which case
   * unlock. A locked layer stays selectable in the Layers Panel, so that second
   * half is reachable — and so is a layer inside an instance, whose lock is an
   * override on the instance rather than an entry in the tree.
   */
  const toggleLock = useCallback(() => {
    const { selectedIds: ids, selectedElements } = live.current;
    if (ids.size === 0) return;
    // Decided on the nodes the canvas painted, never on the tree: a resolved clone
    // is absent from `elements`, so `editableIds` answered "something editable is
    // unlocked" for a layer the user had already locked from the panel's padlock,
    // and the second Lock click locked it again instead of releasing it.
    const locked = !selectedElements.every((el) => el.locked === true);
    // Same route as the padlock (`useLayerRowActions`): the layers an instance
    // projects take an override, and `setElementsLocked` then holds for the stored
    // ones — it simply matches no id of the clones.
    const derived = overrideDerivedNodes(docRef.current, ids, (el) => ({ ...el, locked }));
    const base = derived ? derived.doc : docRef.current;
    commitSnapshot(
      updateActivePageElements(base, setElementsLocked(getActivePage(base).children, ids, locked))
    );
  }, [commitSnapshot, docRef]);

  /**
   * Hide the whole selection unless every selected layer is already hidden, in
   * which case show it — the same any-on/toggle-off rhythm as `toggleLock`.
   * Visibility feeds auto-layout, so the tree is re-laid-out rather than having
   * a flag flipped on it (see docs/LESSONS_LEARNED.md). A derived node (a layer
   * inside an instance) is written as an override on its instance.
   */
  const toggleVisibility = useCallback(() => {
    const ids = live.current.selectedIds;
    if (ids.size === 0) return;

    const cur = getActivePage(docRef.current);
    const selectedEls = flattenElements(cur.children).filter((el) => ids.has(el.id));
    if (selectedEls.length === 0) return;
    // Hide when anything is visible; otherwise show.
    const nextVis = !selectedEls.some((el) => el.visible !== false);

    // Derived nodes become overrides; real nodes go into the tree, then the
    // whole selection's tree relayouts so auto-layout stacks close their gaps.
    const derived = overrideDerivedNodes(docRef.current, ids, (el) => ({ ...el, visible: nextVis }));
    const baseDoc = derived ? derived.doc : docRef.current;
    const nextElements = mapElements(
      getActivePage(baseDoc).children,
      (el) => (ids.has(el.id) ? { ...el, visible: nextVis } : el)
    );
    commitSnapshot(updateActivePageElements(baseDoc, relayoutDocumentTree(nextElements)));
  }, [commitSnapshot, docRef]);

  /** Right-click → Edit Path. The section it opens only exists in edit mode. */
  const editPath = useCallback(() => {
    const primary = live.current.realSelected[0];
    if (primary) startPathEdit(primary);
  }, [startPathEdit]);

  const align = useCallback(
    (type: AlignmentType) => {
      const cur = getActivePage(docRef.current);
      const all = cur.children;
      const editable = editableIds(all, live.current.selectedIds);
      const selected = flattenElements(all).filter((el) => editable.has(el.id));
      if (selected.length === 0) {
        refuseLocked();
        return;
      }
      const aligned = alignElements(selected, type, {
        allElements: all,
        canvasWidth: cur.canvas.width,
        canvasHeight: cur.canvas.height
      });
      const alignedById = new Map(aligned.map((el) => [el.id, el]));
      commitSnapshot(
        updateActivePageElements(docRef.current, mapElements(all, (el) => alignedById.get(el.id) ?? el))
      );
    },
    [commitSnapshot, docRef, refuseLocked]
  );

  const boolean = useCallback(
    (op: BooleanOp) => {
      if (refuseLocked()) return;
      const { doc: newDoc, newElementId } = performBooleanOperation(
        docRef.current,
        editableSelection(),
        op
      );
      if (newElementId) {
        commitSnapshot(newDoc);
        setSelectedIds(new Set([newElementId]));
      }
    },
    [commitSnapshot, docRef, editableSelection, refuseLocked, setSelectedIds]
  );

  useEffect(() => {
    const offs = [
      registerEditorCommand("group", {
        run: () => group(false),
        enabled: () => groupableElements().length > 0
      }),
      registerEditorCommand("groupAsFrame", {
        run: () => group(true),
        enabled: () => groupableElements().length > 0
      }),
      registerEditorCommand("ungroup", {
        run: ungroup,
        enabled: () => {
          const sel = live.current.selectedElements;
          return sel.length === 1 && isContainer(sel[0]) && isStoredNode(docRef.current, sel[0].id);
        }
      }),
      registerEditorCommand("wrapFlex", { run: () => wrap("flex"), enabled: () => wrapTargets().length > 1 }),
      registerEditorCommand("wrapGrid", { run: () => wrap("grid"), enabled: () => wrapTargets().length > 1 }),
      registerEditorCommand("flatten", {
        run: flatten,
        // `editableSelection` alone cannot say no: it keeps an id with no element
        // behind it (see `editableIds`), so a layer inside an instance looked like
        // something to flatten and the run committed an empty edit.
        enabled: () =>
          hasStoredSelection(docRef.current, live.current.selectedIds) && editableSelection().size > 0
      }),
      registerEditorCommand("outlineText", {
        run: outlineText,
        enabled: () =>
          supportsLocalFonts() &&
          live.current.selectedElements.some(
            (el) =>
              el.type === "text" &&
              !(el as TextElement).onPath?.pathId &&
              isStoredNode(docRef.current, el.id)
          )
      }),
      registerEditorCommand("toggleLockSelection", {
        run: toggleLock,
        enabled: () => live.current.selectedIds.size > 0
      }),
      registerEditorCommand("editPath", { run: editPath, enabled: () => live.current.realSelected.length > 0 })
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [group, ungroup, wrap, flatten, outlineText, toggleLock, editPath, docRef, groupableElements, editableSelection, wrapTargets]);

  return useMemo(
    () => ({ group, groupAsFrame: () => group(true), ungroup, wrap, flatten, toggleLock, toggleVisibility, editPath, align, boolean }),
    [group, ungroup, wrap, flatten, toggleLock, toggleVisibility, editPath, align, boolean]
  );
}
