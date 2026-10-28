/**
 * A per-render query index over the open document: masters, styles, assets and
 * the reverse edges between them, so resolving an instance never scans the tree.
 *
 * It sits beside the renderer rather than in `core/` because it is the render
 * path's object — it falls back to `heldMaster`, the session memory of a master
 * that was just cut, and no `core/` module imports it. `core/registry/` used to
 * hold it, which read as the bottom of the layering when it is the top.
 */
import {
  AssetRef,
  ComponentElement,
  DesignDocument,
  DesignElement,
  DesignStyle,
  InstanceElement
} from "../../core/dsl/types";
import { getActivePage } from "../../core/dsl/types";
import { paintLayers } from "../../core/dsl/image-fill";
import { findMasterComponent } from "../../core/interactions/component-inventory";
import { heldMaster } from "../../core/interactions/detached-masters";

export interface ReferenceRegistry {
  components: Map<string, ComponentElement>;
  designStyles: Map<string, DesignStyle>;
  assets: Map<string, AssetRef>;
  variables: Map<string, unknown>;
  reverseReferences: Map<string, Set<string>>;

  getComponent(id: string): ComponentElement | undefined;
  getAsset(id: string): AssetRef | undefined;
  getStyle(id: string): DesignStyle | undefined;
  getStyles(): DesignStyle[];
  getDependents(targetId: string): Set<string>;
}

/**
 * One registry per document commit.
 *
 * The index is a pure function of the document, and it is built by three
 * callers — the element renderer, `<defs>`, and every thumbnail — from the same
 * or from different element arrays. Keyed on the rendered array instead, a
 * viewport re-render rebuilt it while the document had not moved at all: two
 * full-document walks per frame. A commit replaces the document object, so the
 * cache cannot outlive the tree it indexes.
 */
const registryCache = new WeakMap<DesignDocument, ReferenceRegistry>();

export function buildReferenceRegistry(doc: DesignDocument): ReferenceRegistry {
  const cached = registryCache.get(doc);
  if (cached) return cached;
  const built = buildRegistry(doc);
  registryCache.set(doc, built);
  return built;
}

function buildRegistry(doc: DesignDocument): ReferenceRegistry {
  const components = new Map<string, ComponentElement>();
  const designStyles = new Map<string, DesignStyle>();
  const assets = new Map<string, AssetRef>();
  const variables = new Map<string, unknown>();
  const reverseReferences = new Map<string, Set<string>>();

  const addReverseRef = (targetId: string, sourceElementId: string) => {
    let set = reverseReferences.get(targetId);
    if (!set) {
      set = new Set();
      reverseReferences.set(targetId, set);
    }
    set.add(sourceElementId);
  };

  if (doc.styles && Array.isArray(doc.styles)) {
    for (const s of doc.styles) {
      if (s && s.id) {
        designStyles.set(s.id, s);
      }
    }
  }

  if (doc.assets && Array.isArray(doc.assets)) {
    for (const asset of doc.assets) {
      if (asset && asset.id) {
        assets.set(asset.id, asset);
      }
    }
  }

  const walkElement = (el: DesignElement) => {
    if (el.type === "component") {
      components.set(el.id, el as ComponentElement);
    }

    if (el.type === "instance") {
      const inst = el as InstanceElement;
      if (inst.componentId) {
        addReverseRef(inst.componentId, inst.id);
      }
    }

    if (el.fillStyleId) {
      addReverseRef(el.fillStyleId, el.id);
    }
    if (el.strokeStyleId) {
      addReverseRef(el.strokeStyleId, el.id);
    }
    if (el.effectStyleId) {
      addReverseRef(el.effectStyleId, el.id);
    }
    if ((el as any).textStyleId) {
      addReverseRef((el as any).textStyleId, el.id);
    }

    // An image fill references a document asset, which counts as a reverse
    // reference the same way a style binding does.
    for (const paint of paintLayers(el as any)) {
      if (paint.type === "image" && paint.assetId) {
        addReverseRef(paint.assetId, el.id);
      }
    }

    if ("children" in el && Array.isArray((el as any).children)) {
      for (const child of (el as any).children) {
        walkElement(child);
      }
    }
  };

  const pages = doc.pages && doc.pages.length > 0 ? doc.pages : [{ id: "p1", name: "Page 1", canvas: doc.canvas, children: getActivePage(doc).children || [] }];
  for (const page of pages) {
    if (Array.isArray(page.children)) {
      for (const el of page.children) {
        walkElement(el);
      }
    }
  }

  return {
    components,
    designStyles,
    assets,
    variables,
    reverseReferences,

    getComponent(id: string) {
      return components.get(id);
    },
    getAsset(id: string) {
      return assets.get(id);
    },
    getStyle(id: string) {
      return designStyles.get(id);
    },
    getStyles() {
      return Array.from(designStyles.values());
    },
    getDependents(targetId: string) {
      return reverseReferences.get(targetId) ?? new Set();
    }
  };
}

/**
 * The master an instance paints from, with the session tolerance: a definition the
 * document no longer holds (just cut, just deleted) is still in memory, and an
 * instance that would otherwise empty itself renders from it instead. The document
 * always wins, so a pasted-back master needs no cleanup — see
 * `core/interactions/detached-masters.ts`.
 */
export function findMasterComponentFast(
  doc: DesignDocument,
  componentId: string,
  registry?: ReferenceRegistry
): ComponentElement | null {
  if (registry) {
    return registry.getComponent(componentId) ?? heldMaster(componentId);
  }
  return findMasterComponent(doc, componentId) ?? heldMaster(componentId);
}
