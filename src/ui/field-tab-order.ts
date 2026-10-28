import { useEffect } from "preact/hooks";

/**
 * Field-only Tab routing.
 *
 * The inspector is dense with buttons, chevrons and swatches, so the browser's
 * native tab order drops the caret onto chrome every second or third stop. Any
 * element marked `data-field-tab-scope` instead walks only its text-entry
 * fields, wrapping at both ends. The listener lives on `document` in the capture
 * phase because the paint and style popovers portal into `document.body`, i.e.
 * outside the inspector subtree that hosts them.
 */

// One chain, not a list of `input:not(...)` selectors: a comma-separated second
// `input` selector would re-admit the very types the first one excluded.
const FIELD_SELECTOR =
  'input:not([type="hidden"]):not([type="file"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, [contenteditable="true"]';

const SCOPE_ATTR = "data-field-tab-scope";

function fieldList(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(FIELD_SELECTOR)).filter(
    (el) =>
      !(el as HTMLInputElement).disabled &&
      el.tabIndex !== -1 &&
      // Covers `display:none` ancestors (Tailwind `hidden`, unmounted branches).
      el.getClientRects().length > 0
  );
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Tab" || e.isComposing || (e as any).keyCode === 229) return;
  const from = e.target as HTMLElement | null;
  const scope = from?.closest?.(`[${SCOPE_ATTR}]`) as HTMLElement | null;
  if (!scope) return;
  const fields = fieldList(scope);
  const index = from ? fields.indexOf(from) : -1;
  if (index < 0) return;
  e.preventDefault();
  if (fields.length < 2) return;
  const next = fields[(index + (e.shiftKey ? -1 : 1) + fields.length) % fields.length];
  next.focus();
  // Tab is "go edit this value", so land with the old value selected.
  if (typeof (next as HTMLInputElement).select === "function") {
    (next as HTMLInputElement).select();
  }
}

let subscribers = 0;

/** Installs the router for as long as a field scope is mounted. */
export function useFieldTabOrder() {
  useEffect(() => {
    if (subscribers++ === 0) document.addEventListener("keydown", onKeyDown, true);
    return () => {
      if (--subscribers === 0) document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
}
