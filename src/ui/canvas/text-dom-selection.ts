/**
 * Helpers for measuring and manipulating character selection offsets
 * inside a contenteditable rich text DOM node.
 */

/** The zero-width space the editor appends so a trailing newline keeps a caret. */
export const TRAILING_SENTINEL = "\u200b";

const stripSentinels = (text: string): string => text.split(TRAILING_SENTINEL).join("");

/**
 * The character offset of a DOM point, counted from the start of `root`.
 *
 * `Range.toString()` concatenates the text nodes the range covers, which is the
 * same string `innerText` hands back for this editor — so an offset from here and
 * a length from there are in one coordinate space, and a range spanning several
 * runs needs no walk to resolve.
 */
function offsetOf(root: HTMLElement, container: Node, offset: number): number | null {
  try {
    const pre = document.createRange();
    pre.setStart(root, 0);
    pre.setEnd(container, offset);
    return stripSentinels(pre.toString()).length;
  } catch {
    return null;
  }
}

function offsetsBetween(
  root: HTMLElement,
  startContainer: Node,
  startOffset: number,
  endContainer: Node,
  endOffset: number
): { start: number; end: number } | null {
  const a = offsetOf(root, startContainer, startOffset);
  const b = offsetOf(root, endContainer, endOffset);
  if (a === null || b === null) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

export function getTextSelectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  return offsetsBetween(root, range.startContainer, range.startOffset, range.endContainer, range.endOffset);
}

/**
 * The characters an input event is ABOUT to replace, as offsets into the text on
 * screen right now.
 *
 * `beforeinput` fires before the DOM moves, so its target ranges are in the
 * pre-edit coordinates the span reconciler needs — and they are the only
 * authority on which characters an edit touches. Afterwards the two strings are
 * all that is left, and "type a character after the second `a` of `aaaa`" then
 * reads exactly like "type one at the end".
 *
 * Null when the browser offers no target ranges or they fall outside this editor;
 * the caller still has the derivable edit, and only the ambiguous cases lose.
 */
export function getInputTargetOffsets(
  root: HTMLElement,
  ranges: readonly StaticRange[] | undefined | null
): { start: number; end: number } | null {
  const range = ranges && ranges[0];
  if (!range) return null;
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  return offsetsBetween(root, range.startContainer, range.startOffset, range.endContainer, range.endOffset);
}

/**
 * The text the editable DOM holds, in the same coordinate space as
 * `getTextSelectionOffsets`.
 *
 * `innerText` is NOT that space. To keep a caret on an empty last line, the
 * browser inserts a `<br>` even when the text node already ends in `\n`, and
 * `innerText` counts both — so one Backspace at the end read back as a NEW line
 * break, and every later edit carried the extra one. Offsets come from
 * `Range.toString`, which reads text nodes only; reading the draft the same way
 * keeps a capture and the selection that describes it in one string.
 */
export function getEditableText(root: HTMLElement): string {
  const range = document.createRange();
  range.selectNodeContents(root);
  return range.toString();
}

export function setTextSelectionOffsets(root: HTMLElement, start: number, end: number): void {
  const sel = window.getSelection();
  if (!sel) return;

  let sNode: Node | null = null, sOff = 0, eNode: Node | null = null, eOff = 0, last: Node | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null, cur = 0;

  while ((node = walker.nextNode())) {
    last = node;
    const len = node.nodeValue?.length || 0;
    if (!sNode && cur + len >= start) { sNode = node; sOff = Math.max(0, start - cur); }
    if (!eNode && cur + len >= end) { eNode = node; eOff = Math.max(0, end - cur); break; }
    cur += len;
  }

  if (last) {
    if (!sNode) { sNode = last; sOff = last.nodeValue?.length || 0; }
    if (!eNode) { eNode = last; eOff = last.nodeValue?.length || 0; }
  }

  try {
    const range = document.createRange();
    if (sNode && eNode) {
      range.setStart(sNode, sOff);
      range.setEnd(eNode, eOff);
    } else {
      range.selectNodeContents(root);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {}
}
