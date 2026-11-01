/**
 * Which of the three shells a document opens in.
 *
 * `canvas` is the old bare embed (`?view=canvas`), kept because a screenshot rig
 * and the chrome extension both depend on it. `viewer` is the phone reader. The
 * decision is made ONCE, at page load, and never re-evaluated on resize: a mode
 * that changes under a rotation is a mode nobody can learn, and the editor's
 * hook order is fixed for the life of the load — swapping shells at runtime
 * would change how many hooks run in one component instance.
 */

export type ViewMode = "editor" | "viewer" | "canvas";

/**
 * Below this width a phone-shaped surface cannot hold the editor's chrome: the
 * layer panel's own minimum (200) plus the inspector (288) already exceeds it,
 * so both panels open covers the canvas entirely. Above it, a tablet in
 * landscape still gets the editor.
 */
export const VIEWER_MAX_WIDTH = 820;

export interface ViewModeInput {
  /** `location.search`, leading `?` optional. */
  search: string;
  width: number;
  coarsePointer: boolean;
  /** The file itself says it may only be read (see `core/persistence/file-policy`). */
  readOnly?: boolean;
}

export function resolveViewMode({ search, width, coarsePointer, readOnly = false }: ViewModeInput): ViewMode {
  const requested = new URLSearchParams(search).get("view");
  // `canvas` is a view of the document in both directions, so it stays legal on
  // a read-only file — an embed is the one shell that never had an editor.
  if (requested === "canvas") return "canvas";
  // A read-only file has no editor to open: `?view=editor` must not be able to
  // arm one, and the device rule is not consulted at all, because it only ever
  // answered "does this device get the reader instead of the editor". Here there
  // is nothing to choose between — the same reader ships on a 27-inch display.
  if (readOnly) return "viewer";
  if (requested === "viewer" || requested === "editor") return requested;
  // A touch device that is also narrow. Width alone would send a desktop user
  // who dragged their window narrow into the reader, which reads as the editor
  // having broken.
  return coarsePointer && width <= VIEWER_MAX_WIDTH ? "viewer" : "editor";
}

/**
 * The address that opens the same document in the editor.
 *
 * A reload, not a state flip: the two shells mount different hook trees, and the
 * document is untouched while reading, so there is nothing a reload can lose.
 */
export function editorHref(search: string, href: string): string {
  const params = new URLSearchParams(search);
  params.set("view", "editor");
  const query = params.toString();
  return `${href.split(/[?#]/)[0]}${query ? `?${query}` : ""}`;
}

export function currentViewMode(readOnly = false): ViewMode {
  return resolveViewMode({
    search: typeof window === "undefined" ? "" : window.location.search,
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    coarsePointer:
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(pointer: coarse)").matches
        : false,
    readOnly
  });
}
