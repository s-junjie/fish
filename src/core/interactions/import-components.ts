import {
  DesignDocument,
  DesignElement,
  ComponentElement,
  InstanceElement,
  AssetRef,
  Paint,
  getActivePage,
  updateActivePageElements
} from "../dsl/types";
import { paintLayers } from "../dsl/image-fill";
import { normalizeDesignDocument } from "../dsl/normalize";
import { createId } from "../id";
import { isContainer, flattenElements } from "../geometry/tree-ops";

const DOC_SCRIPT_RE = /<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i;

/**
 * FISH has no team library — a file is the whole world. Cross-document reuse is
 * a plain file read instead: no account, no sync, no network.
 */
export function parseFishDocument(text: string): DesignDocument | null {
  const match = text.match(DOC_SCRIPT_RE);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim()) as DesignDocument;
  } catch {
    return null;
  }
}

export function collectForeignComponents(doc: DesignDocument): ComponentElement[] {
  const pages =
    doc.pages && doc.pages.length > 0 ? doc.pages : [{ children: getActivePage(doc).children || [] }];
  const out: ComponentElement[] = [];
  for (const page of pages) {
    for (const el of flattenElements(page.children || [])) {
      if (el.type === "component") out.push(el as ComponentElement);
    }
  }
  return out;
}

function remapSubtree(el: DesignElement, idMap: Map<string, string>): DesignElement {
  const next: DesignElement = { ...el, id: idMap.get(el.id) || el.id };
  if (next.type === "instance") {
    const inst = next as InstanceElement;
    next.componentId = idMap.get(inst.componentId) || inst.componentId;
  }
  const onPath = (next as any).onPath;
  if (onPath && typeof onPath.pathId === "string") {
    (next as any).onPath = { ...onPath, pathId: idMap.get(onPath.pathId) || onPath.pathId };
  }
  if (isContainer(next) && next.children) {
    return { ...next, children: next.children.map((c) => remapSubtree(c, idMap)) };
  }
  return next;
}

export interface ComponentImportResult {
  doc: DesignDocument;
  names: string[];
  error?: "not-a-fish-file" | "no-components";
}

/**
 * Copies every component of a source document into the target. Ids are reminted
 * because ids are only unique per document — a colliding id would make an
 * existing instance silently resolve to the imported master.
 */
export function importComponentsFromDocument(
  target: DesignDocument,
  source: DesignDocument
): ComponentImportResult {
  // The source is a file we did not write. Run it through the same normalizer
  // the load path uses, so legacy forms (a `type:"image"` element, `group`, a
  // single `fill`) arrive canonical before anything below reads them — an
  // un-migrated image element would otherwise import with no bitmap at all.
  const sourceComponents = collectForeignComponents(normalizeDesignDocument(source).document);
  if (sourceComponents.length === 0) return { doc: target, names: [], error: "no-components" };

  const idMap = new Map<string, string>();
  for (const comp of sourceComponents) {
    idMap.set(comp.id, createId("comp"));
    for (const child of flattenElements(comp.children || [])) {
      idMap.set(child.id, createId("el"));
    }
  }

  const imported = sourceComponents.map((comp) =>
    remapSubtree(comp, idMap) as ComponentElement
  );

  // Images inside the components point at the source file's assets; those bytes
  // have to travel with them or the copy renders empty. An image is a fill, so
  // the reference is scanned on the layers rather than on the element.
  const existing = new Set((target.assets || []).map((a) => a.id));
  const assetMap = new Map<string, string>();
  const copied: AssetRef[] = [];
  for (const comp of imported) {
    for (const el of flattenElements([comp])) {
      for (const paint of paintLayers(el as any)) {
        if (paint.type !== "image") continue;
        const assetId = paint.assetId;
        if (!assetId || assetMap.has(assetId) || existing.has(assetId)) continue;
        const ref = (source.assets || []).find((a) => a.id === assetId);
        if (!ref) continue;
        const nextId = existing.has(assetId) ? createId("asset") : assetId;
        assetMap.set(assetId, nextId);
        copied.push({ ...ref, id: nextId });
      }
    }
  }
  if (assetMap.size > 0) {
    for (const comp of imported) {
      for (const el of flattenElements([comp])) {
        const layers = (el as { fills?: Paint[] }).fills;
        if (!layers) continue;
        let touched = false;
        const next = layers.map((p) => {
          if (p.type !== "image") return p;
          const remapped = assetMap.get(p.assetId);
          if (!remapped || remapped === p.assetId) return p;
          touched = true;
          return { ...p, assetId: remapped };
        });
        // Replace rather than mutate: the cloned subtree still shares the layer
        // array with the source document.
        if (touched) (el as { fills?: Paint[] }).fills = next;
      }
    }
  }

  const page = getActivePage(target);
  const nextDoc = updateActivePageElements(target, [...page.children, ...imported]);
  return {
    doc: {
      ...nextDoc,
      assets: [...(nextDoc.assets || []), ...copied],
      updatedAt: new Date().toISOString()
    },
    names: imported.map((c) => c.name || c.id)
  };
}
