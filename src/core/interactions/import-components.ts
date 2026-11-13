import {
  ComponentElement,
  ComponentSetElement,
  DesignDocument,
  DesignElement,
  InstanceElement
} from "../dsl/types";
import { STYLE_BINDING_FIELDS } from "../dsl/constants";
import { getActivePage, updateActivePageElements } from "../dsl/document-ops";
import { createId } from "../id";
import { isContainer, flattenElements } from "../geometry/tree-ops";
import { documentFromHtml, readDocument } from "../persistence/container";
import { collectReferencedStyles, collectReferencedTokens } from "./clipboard-payload";
import { syncDualStorage } from "./style-ops";

export type ImportedComponentRoot = ComponentElement | ComponentSetElement;

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function mintFreeId(taken: Set<string>, prefix: string): string {
  let id = createId(prefix);
  while (taken.has(id)) id = createId(prefix);
  taken.add(id);
  return id;
}

function mapTargetPath(target: string, idMap: Map<string, string>): string {
  if (!target.includes("/")) return idMap.get(target) ?? target;
  return target
    .split("/")
    .map((step) => idMap.get(step) ?? step)
    .join("/");
}

/**
 * FISH has no team library — a file is the whole world. Cross-document reuse is
 * a plain file read instead: no account, no sync, no network.
 */
export function parseFishDocument(text: string): DesignDocument | null {
  return documentFromHtml(text) ?? null;
}

function collectRootsFromList(list: readonly DesignElement[], out: ImportedComponentRoot[]): void {
  for (const el of list) {
    // A componentSet carries its variant components as direct children, so it
    // travels whole instead of being broken into ungrouped components.
    if (el.type === "componentSet" || el.type === "component") {
      out.push(el as ImportedComponentRoot);
      continue;
    }
    if (isContainer(el) && el.children) {
      collectRootsFromList(el.children, out);
    }
  }
}

export function collectForeignComponents(doc: DesignDocument): ImportedComponentRoot[] {
  const pages =
    doc.pages && doc.pages.length > 0 ? doc.pages : [{ children: getActivePage(doc).children || [] }];
  const out: ImportedComponentRoot[] = [];
  for (const page of pages) {
    collectRootsFromList(page.children || [], out);
  }
  return out;
}

function remapSubtree(
  el: DesignElement,
  idMap: Map<string, string>,
  legacySetIdMap: Map<string, string>,
  styleIdMap: Map<string, string>
): DesignElement {
  const next: DesignElement = { ...el, id: idMap.get(el.id) ?? el.id };
  const loose = next as unknown as Record<string, unknown>;

  if (next.type === "instance") {
    const inst = next as InstanceElement;
    inst.componentId = idMap.get(inst.componentId) ?? inst.componentId;
    if (Array.isArray(inst.overrides)) {
      inst.overrides = inst.overrides.map((o) => {
        const targetId = mapTargetPath(o.targetId, idMap);
        let value = o.value;
        if (
          (o.property === "fillStyleId" ||
            o.property === "strokeStyleId" ||
            o.property === "textStyleId" ||
            o.property === "effectStyleId") &&
          typeof o.value === "string" &&
          styleIdMap.has(o.value)
        ) {
          value = styleIdMap.get(o.value)!;
        }
        return targetId === o.targetId && value === o.value ? o : { ...o, targetId, value };
      });
    }
  }

  if (next.type === "component" && typeof loose.setId === "string") {
    loose.setId = idMap.get(loose.setId) ?? legacySetIdMap.get(loose.setId) ?? loose.setId;
  }

  const onPath = loose.onPath as { pathId?: string } | undefined;
  if (onPath && typeof onPath.pathId === "string") {
    loose.onPath = { ...onPath, pathId: idMap.get(onPath.pathId) ?? onPath.pathId };
  }

  for (const key of STYLE_BINDING_FIELDS) {
    const bound = loose[key];
    if (typeof bound === "string" && styleIdMap.has(bound)) {
      loose[key] = styleIdMap.get(bound);
    }
  }

  if (isContainer(next) && next.children) {
    return {
      ...next,
      children: next.children.map((c) => remapSubtree(c, idMap, legacySetIdMap, styleIdMap))
    };
  }
  return next;
}

export interface ComponentImportResult {
  doc: DesignDocument;
  names: string[];
  error?: "not-a-fish-file" | "no-components";
}

/**
 * Copies every component (and component set) of a source document into the
 * target without importing source images/assets. Ids are reminted collision-free
 * because ids are only unique per document — a colliding id would make an
 * existing instance silently resolve to the imported master.
 */
export function importComponentsFromDocument(
  target: DesignDocument,
  source: DesignDocument
): ComponentImportResult {
  const normalizedSource = readDocument(source);
  const sourceComponents = collectForeignComponents(normalizedSource);
  if (sourceComponents.length === 0) return { doc: target, names: [], error: "no-components" };

  const takenElements = new Set<string>();
  for (const page of target.pages || []) {
    for (const el of flattenElements(page.children || [])) takenElements.add(el.id);
  }
  for (const el of flattenElements(getActivePage(target).children || [])) takenElements.add(el.id);

  const takenStyles = new Set((target.styles || []).map((s) => s.id));

  const idMap = new Map<string, string>();
  const mintTreeIds = (el: DesignElement): void => {
    if (!idMap.has(el.id)) {
      const prefix = el.type === "componentSet" ? "cset" : el.type === "component" ? "comp" : "el";
      idMap.set(el.id, mintFreeId(takenElements, prefix));
    }
    if (isContainer(el)) {
      for (const child of el.children || []) mintTreeIds(child);
    }
  };
  for (const root of sourceComponents) mintTreeIds(root);

  const legacySetIdMap = new Map<string, string>();
  for (const root of sourceComponents) {
    for (const el of flattenElements([root])) {
      if (el.type === "component" && el.setId && !idMap.has(el.setId) && !legacySetIdMap.has(el.setId)) {
        legacySetIdMap.set(el.setId, mintFreeId(takenElements, "cset"));
      }
    }
  }

  const referencedStyles = collectReferencedStyles(normalizedSource.styles, sourceComponents);
  const styleIdMap = new Map<string, string>();
  for (const style of referencedStyles) {
    styleIdMap.set(style.id, mintFreeId(takenStyles, "style"));
  }
  const remintedStyles = referencedStyles.map((s) =>
    deepClone({ ...s, id: styleIdMap.get(s.id) ?? s.id })
  );

  const existingTokenIds = new Set((target.tokens || []).map((t) => t.id));
  const copiedTokens = collectReferencedTokens(normalizedSource.tokens, sourceComponents)
    .filter((t) => !existingTokenIds.has(t.id))
    .map((t) => deepClone(t));

  const mergedStyles = [...(target.styles || []), ...remintedStyles];
  const mergedTokens = [...(target.tokens || []), ...copiedTokens];
  const tables = { tokens: mergedTokens, styles: mergedStyles };

  const imported = sourceComponents.map((root) =>
    syncDualStorage(
      remapSubtree(deepClone(root), idMap, legacySetIdMap, styleIdMap),
      tables
    ) as ImportedComponentRoot
  );

  const page = getActivePage(target);
  const nextDoc = updateActivePageElements(target, [...page.children, ...imported]);
  return {
    doc: {
      ...nextDoc,
      ...(mergedStyles.length > 0 || target.styles ? { styles: mergedStyles } : {}),
      ...(mergedTokens.length > 0 ? { tokens: mergedTokens } : {}),
      updatedAt: new Date().toISOString()
    },
    names: imported.map((c) => c.name || c.id)
  };
}
