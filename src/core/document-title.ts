/**
 * One title, two consumers: the tab strip the user reads right now, and the
 * `<title>` stamped into every shell `serializeSelf` writes.
 *
 * They cannot be derived separately. A title set only on the live document is
 * gone the moment the file is closed, because the browser then reads the title
 * the *file* carries — so a save that renamed nothing left every saved file
 * claiming to be the app itself, and the tab showed a different name than the
 * file it was editing.
 */

/** The product's name, not a translatable string: this is stamped into files. */
const BRAND = "FISH";

/** Both spellings of a FISH document on disk. */
const DOCUMENT_EXTENSION_RE = /\.(?:fish\.)?html?$/i;

/** Only an html file is a document. Under the dev bundle route the pathname is
 *  a route (`/__fish_bundle__`), and a tab titled after a dev server's URL says
 *  less than a tab titled after the document. */
const HTML_EXTENSION_RE = /\.html?$/i;

const TITLE_RE = /<title(?:\s[^>]*)?>[\s\S]*?<\/title>/i;
const HEAD_RE = /<head[^>]*>/i;

/**
 * What this file's tab should say: `name — FISH`.
 *
 * `undefined` when neither the file nor the document knows a name, which is the
 * one case where the shell's own title is left standing — an untitled file with
 * no document name has nothing to say, and inventing a name for it would be a
 * lie the user cannot see through.
 */
export function documentTitleFor(fileName?: string | null, docName?: string | null): string | undefined {
  const subject = documentStem(fileName, docName);
  return subject ? `${subject} — ${BRAND}` : undefined;
}

/**
 * The subject both the tab title and the exported sidecar are named after: the
 * file's stem when this tab has a file, the document's own name otherwise.
 *
 * The file wins because it is the name the user sees and the name auto-save
 * writes to — a sidecar called after the DSL's `name` field lands beside
 * `poster.fish.html` as `fish-—-poster.fish.json` and reads as a different
 * document.
 */
export function documentStem(fileName?: string | null, docName?: string | null): string {
  const fromFile = (fileName ?? "").trim();
  const stem = HTML_EXTENSION_RE.test(fromFile) ? fromFile.replace(DOCUMENT_EXTENSION_RE, "").trim() : "";
  return stem || (docName ?? "").trim();
}

/**
 * Put the derived title on the live document.
 *
 * Assigns only on a change: this runs off the document's own history channel,
 * which fires on every completed edit, and a tab whose title is rewritten on
 * each of them makes the tab strip flicker for no reason.
 */
export function applyDocumentTitle(fileName?: string | null, docName?: string | null): void {
  if (typeof document === "undefined") return;
  const next = documentTitleFor(fileName, docName);
  if (!next || document.title === next) return;
  document.title = next;
}

/** `&` and `<` only: everything else a file name may hold is text in a title. */
function escapeTitleText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/**
 * Give a shell the given title.
 *
 * Scoped to the head on purpose: an SVG in the body carries its own `<title>`,
 * and the thumbnail preview is full of them — rewriting the first one found in
 * the document would rename a layer in the saved file's own preview.
 */
export function stampDocumentTitle(html: string, title: string): string {
  const head = HEAD_RE.exec(html);
  if (!head) return html;
  const headEnd = html.toLowerCase().indexOf("</head>", head.index);
  const scope = html.slice(head.index, headEnd === -1 ? undefined : headEnd);
  const match = TITLE_RE.exec(scope);
  const text = `<title>${escapeTitleText(title)}</title>`;
  if (!match) {
    const after = head.index + head[0].length;
    return `${html.slice(0, after)}\n  ${text}${html.slice(after)}`;
  }
  const at = head.index + match.index;
  return `${html.slice(0, at)}${text}${html.slice(at + match[0].length)}`;
}