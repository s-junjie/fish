/**
 * How much this app will take in one paste or import.
 *
 * A payload has no natural ceiling: a hand-written clipboard string can nest a
 * hundred thousand levels, and a Figma export can carry a hundred megabytes of
 * inline base64. Everything downstream of the door assumes a tree it can walk —
 * `remintFragment`, `flattenElements`, `relayoutDocumentTree`, `deepClone` — and
 * every one of them is recursive, so "too big" arrives as a stack overflow or as
 * a main thread that stops responding with no way to say why.
 *
 * So the refusal happens HERE, on the size of the thing being handed over, and
 * it names the limit it broke. The numbers are generous on purpose: they must
 * never refuse work that a real designer does. Elements and depth are the ones
 * that actually bite; the byte ceilings only exist to reject a payload that is
 * not a document at all.
 */

import { t } from "../../i18n";

/** One paste, in UTF-16 code units — the cheap stand-in for its size. */
export const MAX_CLIPBOARD_CHARS = 64_000_000;

/** One imported file, in bytes. A real Figma export is ~100 MB with images inline. */
export const MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024;

/** The same ceiling the Figma walker applies, so the two doors agree. */
export const MAX_IMPORTED_ELEMENTS = 20_000;

/** Containers within containers. Real designs stay in the low tens. */
export const MAX_ELEMENT_DEPTH = 128;

/** Rounded up so a refusal never reads as "0 MB". */
function megabytes(n: number): number {
  return Math.max(1, Math.round(n / 1_000_000));
}

/** One sentence for the toast, in the one place the limits are spelled. */
export function describeImportRefusal(refusal: ImportRefusal): string {
  switch (refusal.kind) {
    case "too-large":
      return t("importLimits.tooLarge", {
        size: megabytes(refusal.actual),
        limit: megabytes(refusal.limit)
      });
    case "too-many-elements":
      return t("importLimits.tooManyElements", { limit: refusal.limit });
    case "too-deep":
      return t("importLimits.tooDeep", { limit: refusal.limit });
  }
}

export type ImportRefusal =
  | { kind: "too-large"; limit: number; actual: number }
  | { kind: "too-many-elements"; limit: number; actual: number }
  | { kind: "too-deep"; limit: number; actual: number };

/** `null` when the text is within budget, so a caller can `if (refusal)`. */
export function refuseClipboardText(text: string): ImportRefusal | null {
  if (text.length <= MAX_CLIPBOARD_CHARS) return null;
  return { kind: "too-large", limit: MAX_CLIPBOARD_CHARS, actual: text.length };
}

export function refuseFile(sizeBytes: number): ImportRefusal | null {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= MAX_IMPORT_FILE_BYTES) return null;
  return { kind: "too-large", limit: MAX_IMPORT_FILE_BYTES, actual: sizeBytes };
}

/**
 * Count and depth of an element tree, refused as soon as either limit is passed.
 *
 * Iterative with an explicit stack, and NOT recursive: this runs on the payload
 * that is about to overflow a recursive walk, so being recursive here would be
 * the same bug with one more function in front of it. `seen` also means a
 * self-referencing payload (which `JSON.parse` cannot produce but an in-memory
 * caller can) terminates instead of looping.
 *
 * `children` is the only edge that counts. A frame's `fills`, a text's `spans`
 * and a component's `overrides` are property values: they multiply work but not
 * depth, and counting them as layers would refuse documents that are fine.
 */
export function refuseElementTree(roots: readonly unknown[]): ImportRefusal | null {
  const seen = new Set<unknown>();
  const stack: Array<{ node: unknown; depth: number }> = roots.map((node) => ({ node, depth: 1 }));
  let count = 0;

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    count += 1;
    if (count > MAX_IMPORTED_ELEMENTS) {
      return { kind: "too-many-elements", limit: MAX_IMPORTED_ELEMENTS, actual: count };
    }
    if (depth > MAX_ELEMENT_DEPTH) {
      return { kind: "too-deep", limit: MAX_ELEMENT_DEPTH, actual: depth };
    }
    const children = (node as { children?: unknown }).children;
    if (Array.isArray(children)) {
      for (const child of children) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return null;
}
