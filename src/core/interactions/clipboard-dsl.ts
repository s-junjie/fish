import { getActivePage } from "../dsl/types";
import type { DesignElement, DesignDocument } from "../dsl/types";
import { ELEMENT_TYPES } from "../dsl/schema-enums";
import { normalizeDesignDocument } from "../dsl/normalize/document";
import { normalizeElement } from "../dsl/normalize/element";
import { isPlainObject } from "../dsl/normalize/shared";
import { collectReferencedMasters } from "./clipboard-payload";
import { createId } from "../id";

const ELEMENT_TYPE_SET: ReadonlySet<string> = new Set(ELEMENT_TYPES);

export interface DslClipParseResult {
  elements: DesignElement[];
  masters?: DesignElement[];
  assets?: DesignDocument["assets"];
  styles?: DesignDocument["styles"];
  clipId: string;
}

function isLikelyElementObject(val: unknown): boolean {
  if (!isPlainObject(val)) return false;
  const obj = val as Record<string, unknown>;
  return typeof obj.type === "string" && ELEMENT_TYPE_SET.has(obj.type);
}

function normalizeElementList(rawList: unknown[]): DesignElement[] {
  const elements: DesignElement[] = [];
  const seenIds = new Set<string>();
  const repairs: any[] = [];

  rawList.forEach((raw, idx) => {
    const el = normalizeElement(raw, `/elements/${idx}`, idx, repairs, "el_", null, false, seenIds);
    if (el) elements.push(el);
  });

  return elements;
}

/**
 * Parses foreign text from clipboard to detect whether it is valid FISH DSL JSON:
 * 1. A full or partial DesignDocument ({ elements: [...] } or { pages: [...] } or schema)
 * 2. An array of DesignElements ([ { type: "frame", ... }, { type: "rect", ... } ])
 * 3. A single DesignElement ({ type: "frame", children: [...] } or { type: "path", ... })
 */
export function parseDslClipboardText(text: string): DslClipParseResult | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  // Case 1: An array of element objects
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return null;
    if (!parsed.some(isLikelyElementObject)) return null;

    const elements = normalizeElementList(parsed);
    if (elements.length === 0) return null;

    return {
      elements,
      clipId: createId("clip")
    };
  }

  if (!isPlainObject(parsed)) return null;

  const obj = parsed as Record<string, unknown>;

  // Case 2: Full or partial DesignDocument
  const hasDocSignals =
    typeof obj.$schema === "string" ||
    obj.docId !== undefined ||
    obj.version !== undefined ||
    Array.isArray(obj.pages) ||
    (Array.isArray(obj.elements) && (obj.canvas !== undefined || obj.name !== undefined || obj.id !== undefined));

  if (hasDocSignals) {
    try {
      const normalizedDoc = normalizeDesignDocument(obj).document;
      const docElements = getActivePage(normalizedDoc).children;

      if (docElements.length > 0) {
        const masters = collectReferencedMasters(normalizedDoc, docElements);
        return {
          elements: docElements,
          masters,
          assets: normalizedDoc.assets,
          styles: normalizedDoc.styles,
          clipId: createId("clip")
        };
      }
    } catch {
      // not a valid document
    }
  }

  // Case 2b: Plain object that has `elements: [...]` without other doc properties
  if (Array.isArray(obj.elements) && obj.elements.length > 0 && obj.elements.some(isLikelyElementObject)) {
    const elements = normalizeElementList(obj.elements);
    if (elements.length > 0) {
      return {
        elements,
        clipId: createId("clip")
      };
    }
  }

  // Case 3: A single DesignElement object
  if (isLikelyElementObject(obj)) {
    const seenIds = new Set<string>();
    const repairs: any[] = [];
    const el = normalizeElement(obj, "/element", 0, repairs, "el_", null, false, seenIds);
    if (el) {
      return {
        elements: [el],
        clipId: createId("clip")
      };
    }
  }

  return null;
}
