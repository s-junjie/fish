import { useEffect, useRef } from "preact/hooks";
import { getActivePage } from "../../core/dsl/types";
import { ComponentSetElement, DesignDocument, DesignElement, InstanceElement } from "../../core/dsl/types";
import { flattenElements } from "../../core/geometry/tree-ops";
import {
  createInstanceFromComponent,
  hasAnythingToReset,
  removeInstanceOverrides,
  resetInstance
} from "../../core/interactions/component-ops";
import {
  addVariant,
  addVariantProperty,
  combineAsVariants,
  setComponentSetCollapsed
} from "../../core/interactions/component-variants";
import { promotionTargets, promoteSelectionToComponents } from "../../core/interactions/component-batch";
import { findComponentSet, findMasterComponent, groupComponentSets } from "../../core/interactions/component-inventory";
import { resolveInstanceSelection, isStoredNode } from "../../core/interactions/instance-resolve";
import { VARIANT_LABELS } from "../inspector/variant-labels";
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
    /** The selection as stored elements — a resolved clone cannot be promoted. */
    const storedSelection = (): DesignElement[] => {
      const ids = live.current.selectedIds;
      return flattenElements(getActivePage(docRef.current).children || []).filter((el) => ids.has(el.id));
    };
    const batchTargets = () => promotionTargets(getActivePage(docRef.current).children || [], storedSelection());
    const selectedComponents = () => storedSelection().filter((el) => el.type === "component");
    const childSelection = () => {
      const el = primary();
      return el ? resolveInstanceSelection(docRef.current, el.id) : null;
    };
    const childHasOverrides = () => {
      const sel = childSelection();
      return Boolean(
        sel?.overridable && (sel.instance.overrides || []).some((o) => o.targetId === sel.masterNodeId)
      );
    };

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
      }),

      /** "Create multiple components" — the inspector's batch bar, on right-click. */
      registerEditorCommand("createComponents", {
        run: () => {
          const res = promoteSelectionToComponents(docRef.current, batchTargets());
          if (!res) return;
          commitSnapshot(res.doc);
          setSelectedIds(new Set(res.created));
          if (res.hoisted) showHint(t("component.hoistedMaster"));
        },
        enabled: () => batchTargets().length > 0
      }),

      /** "Combine as variants" — two or more components into one set. */
      registerEditorCommand("combineAsVariants", {
        run: () => {
          const res = combineAsVariants(
            docRef.current,
            selectedComponents().map((el) => el.id),
            VARIANT_LABELS
          );
          if (!res) return;
          commitSnapshot(res.doc);
          setSelectedIds(new Set([res.setId]));
        },
        enabled: () => selectedComponents().length >= 2
      }),

      /**
       * "Add variant" on the definition itself.
       *
       * A lone main component becomes a set with its first axis — that is what
       * the command means before there is a matrix to add a column to — and a
       * member gains a sibling in its set otherwise.
       */
      registerEditorCommand("addVariant", {
        run: () => {
          const el = primary();
          if (!el) return;
          // The canvas offers this on a SET's own box, where the answer is "one
          // more member of the default cell" — the clicked thing is a container,
          // not a component that can be a source.
          if (el.type === "componentSet") {
            const set = groupComponentSets(docRef.current).sets.find(
              (s) => s.setId === (el as ComponentSetElement).id
            );
            if (!set) return;
            const res = addVariant(docRef.current, set.defaultMember.id, VARIANT_LABELS, set.properties[0]?.property);
            if (!res.doc) return;
            commitSnapshot(res.doc);
            if (res.variant) setSelectedIds(new Set([res.variant.id]));
            return;
          }
          if (el.type !== "component") return;
          const set = findComponentSet(docRef.current, el.id);
          if (!set) {
            const made = addVariantProperty(docRef.current, el.id, VARIANT_LABELS);
            if (!made.set) return;
            commitSnapshot(made.doc);
            setSelectedIds(new Set([made.set.id]));
            return;
          }
          const res = addVariant(docRef.current, el.id, VARIANT_LABELS, set.properties[0]?.property);
          if (!res.doc) return;
          commitSnapshot(res.doc);
          if (res.variant) setSelectedIds(new Set([res.variant.id]));
        },
        enabled: () => {
          const type = primary()?.type;
          return type === "component" || type === "componentSet";
        }
      }),

      /**
       * Reset ONE layer's changes inside an instance, rather than the whole
       * instance. The panel offers the same thing as a tag on each overridden
       * property; from the canvas this is the only route to it.
       */
      registerEditorCommand("resetNodeOverrides", {
        run: () => {
          const sel = childSelection();
          if (!sel) return;
          const next = removeInstanceOverrides(docRef.current, sel.instanceId, sel.masterNodeId);
          if (next) commitSnapshot(next);
        },
        enabled: childHasOverrides
      })
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [commitSnapshot, docRef, locateComponent, setSelectedIds, showHint]);
}
