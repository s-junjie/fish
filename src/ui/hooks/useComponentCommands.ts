import { useEffect, useRef } from "preact/hooks";
import { getActivePage } from "../../core/dsl/types";
import { ComponentSetElement, DesignDocument, DesignElement, InstanceElement } from "../../core/dsl/types";
import { flattenElements } from "../../core/geometry/tree-ops";
import {
  createInstanceFromComponent,
  hasAnythingToReset,
  resetInstance
} from "../../core/interactions/component-ops";
import { setComponentSetCollapsed } from "../../core/interactions/component-variants";
import { findMasterComponent } from "../../core/interactions/component-inventory";
import { resolveInstanceSelection, isStoredNode } from "../../core/interactions/instance-resolve";
import { registerEditorCommand } from "../commands/editor-commands";
import { t } from "../../i18n";

export interface UseComponentCommandsOptions {
  docRef: { current: DesignDocument };
  commitSnapshot: (doc: DesignDocument) => void;
  setSelectedIds: (ids: Set<string>) => void;
  selectedIds: Set<string>;
  primarySelected: DesignElement | null | undefined;
  /** Switches pages when the master lives elsewhere, then selects and frames it. */
  locateComponent: (componentId: string) => void;
  showHint: (message: string) => void;
}

/**
 * The component actions a right-click should offer, as registered commands.
 *
 * They live here rather than in `ComponentSection` because the panel is not the
 * only way in any more: a definition can be instantiated and an instance can be
 * reset or traced back to its master without the inspector being open, and both
 * surfaces run the same function (AGENTS.md: one implementation, two entry
 * points). Registered, not passed down, so the menu reads the live selection
 * instead of whatever the handler captured when it was created.
 */
export function useComponentCommands({
  docRef,
  commitSnapshot,
  setSelectedIds,
  selectedIds,
  primarySelected,
  locateComponent,
  showHint
}: UseComponentCommandsOptions) {
  const live = useRef({ selectedIds, primarySelected });
  live.current = { selectedIds, primarySelected };

  /** The master an instance — or a layer inside one — is a projection of. */
  const masterIdOf = (el: DesignElement | null | undefined): string | null => {
    if (!el) return null;
    if (el.type === "instance") return (el as InstanceElement).componentId || null;
    return resolveInstanceSelection(docRef.current, el.id)?.instance.componentId || null;
  };

  useEffect(() => {
    const primary = () => live.current.primarySelected;
    const instance = (): InstanceElement | null =>
      primary()?.type === "instance" ? (primary() as InstanceElement) : null;

    const offs = [
      registerEditorCommand("createInstance", {
        run: () => {
          const el = primary();
          if (!el || el.type !== "component") return;
          const { doc: nextDoc, instance } = createInstanceFromComponent(docRef.current, el.id);
          if (!instance) return;
          commitSnapshot(nextDoc);
          setSelectedIds(new Set([instance.id]));
        },
        enabled: () => primary()?.type === "component"
      }),

      registerEditorCommand("goToMainComponent", {
        run: () => {
          const id = masterIdOf(primary());
          if (id) locateComponent(id);
        },
        enabled: () => Boolean(masterIdOf(primary()))
      }),

      registerEditorCommand("resetInstanceChanges", {
        run: () => {
          const inst = instance();
          if (!inst) return;
          const next = resetInstance(docRef.current, inst.id);
          if (next) commitSnapshot(next);
          else showHint(t("component.resetNothing"));
        },
        enabled: () => {
          const inst = instance();
          // An instance projected inside another one is a resolved clone: the tree
          // has no record of it to reset, and the run would have reported "nothing
          // to reset" about a layer the user cannot reset at all.
          if (!inst || !isStoredNode(docRef.current, inst.id)) return false;
          // The master is part of the question, not a detail of the answer: a
          // fresh instance copies the master's `sizing`, and only a value that
          // DIFFERS from it counts as something the user changed.
          return hasAnythingToReset(inst, findMasterComponent(docRef.current, inst.componentId) ?? undefined);
        }
      }),

      /**
       * Figma's collapse, from the twisty drawn on a set's title.
       *
       * Takes the set id rather than reading the selection: the twisty belongs to
       * the set it was painted for, and a click that selects on mousedown would
       * otherwise toggle whatever was selected before.
       */
      registerEditorCommand("toggleComponentSetCollapse", {
        run: (setId: string) => {
          if (typeof setId !== "string") return;
          const el = flattenElements(getActivePage(docRef.current).children).find((e) => e.id === setId);
          const next = setComponentSetCollapsed(
            docRef.current,
            setId,
            el?.type !== "componentSet" ? false : !(el as ComponentSetElement).collapsed
          );
          if (next) commitSnapshot(next);
        },
        enabled: () => true
      })
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [commitSnapshot, docRef, locateComponent, setSelectedIds, showHint]);
}
