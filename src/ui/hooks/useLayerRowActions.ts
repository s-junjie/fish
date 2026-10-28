import { useCallback } from "preact/hooks";
import { DesignDocument, getActivePage, updateActivePageElements } from "../../core/dsl/types";
import { mapElements } from "../../core/geometry/tree-ops";
import { setElementLocked } from "../../core/geometry/lock";
import { overrideDerivedNodes } from "../../core/interactions/instance-overrides";
import { relayoutDocumentTree } from "../../core/compile";
import { applyLayerDrop, LayerDropPosition } from "../layers/layer-reorder";
import { t } from "../../i18n";

interface LayerRowActionsOptions {
  docRef: { current: DesignDocument };
  commitSnapshot: (doc: DesignDocument) => void;
  showHint: (message: string) => void;
  endRename: () => void;
}

/**
 * What a row in the layer panel can do to the document.
 *
 * Every one of these has to answer the same question first — is the id a real
 * stored element or a node resolved out of a component? — because a derived node
 * is painted but never stored, and writing to it has to become an override on
 * its instance instead. `overrideDerivedNodes` is that question, asked once here
 * rather than four times at four call sites.
 */
export function useLayerRowActions({
  docRef,
  commitSnapshot,
  showHint,
  endRename
}: LayerRowActionsOptions) {
  const reorder = useCallback(
    (sourceIds: string[], targetId: string, position: LayerDropPosition) => {
      const result = applyLayerDrop(getActivePage(docRef.current).children, sourceIds, targetId, position);
      if ("refused" in result) {
        // A locked target already says so with its padlock; the structural
        // refusals are the ones that need words, because nothing on screen
        // explains why the drop was not allowed.
        if (result.refused === "instance-in-own-master") showHint(t("component.selfNestingInstance"));
        else if (result.refused === "component-in-component") showHint(t("component.nestedMaster"));
        else if (result.refused === "variant-out-of-set") showHint(t("component.variantOutOfSet"));
        return;
      }
      commitSnapshot(updateActivePageElements(docRef.current, result.elements));
    },
    [docRef, commitSnapshot, showHint]
  );

  const toggleVisibility = useCallback(
    (id: string, nextVis: boolean) => {
      const derived = overrideDerivedNodes(
        docRef.current,
        [id],
        (el) => ({ ...el, visible: nextVis })
      );
      if (derived) {
        commitSnapshot(derived.doc);
        return;
      }
      const cur = getActivePage(docRef.current);
      const nextElements = mapElements(cur.children, (item) =>
        item.id === id ? { ...item, visible: nextVis } : item
      );
      // Visibility feeds auto-layout, so the tree is re-laid-out rather than
      // just having a flag flipped on it.
      commitSnapshot(updateActivePageElements(docRef.current, relayoutDocumentTree(nextElements)));
    },
    [docRef, commitSnapshot]
  );

  const toggleLock = useCallback(
    (id: string, nextLocked: boolean) => {
      const derived = overrideDerivedNodes(
        docRef.current,
        [id],
        (el) => ({ ...el, locked: nextLocked })
      );
      if (derived) {
        commitSnapshot(derived.doc);
        return;
      }
      const cur = getActivePage(docRef.current);
      const nextElements = setElementLocked(cur.children, id, nextLocked);
      commitSnapshot(updateActivePageElements(docRef.current, nextElements));
    },
    [docRef, commitSnapshot]
  );

  const commitRename = useCallback(
    (id: string, newName: string) => {
      const cur = getActivePage(docRef.current);
      const nextElements = mapElements(cur.children, (item) =>
        item.id === id ? { ...item, name: newName } : item
      );
      commitSnapshot(updateActivePageElements(docRef.current, nextElements));
      endRename();
    },
    [docRef, commitSnapshot, endRename]
  );

  return { reorder, toggleVisibility, toggleLock, commitRename };
}
