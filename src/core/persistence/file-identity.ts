import { getFileName } from "./file-paths";

export const FILE_ID_META_RE = /<meta\s+name=["']fish:fileId["']\s+content=["']([^"']+)["']/i;

/**
 * The `<meta name="fish:fileId">` carried by the shell of the open file.
 *
 * DOM only, deliberately: scanning `outerHTML` would also match the literal
 * `fish:fileId` sitting inside the inlined bundle's own source code, and the id
 * would come back as that literal — the same value for every file, which is
 * precisely what this identity exists to prevent.
 */
export function readFileIdFromShell(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const meta = document.querySelector?.('meta[name="fish:fileId"]');
  return meta?.getAttribute("content") ?? undefined;
}

/** The `fish:fileId` stamp carried by an HTML string, for a file not yet adopted. */
export function fileIdFromHtml(html: string): string | undefined {
  return FILE_ID_META_RE.exec(html)?.[1];
}

/**
 * Identity of the file this tab is editing, independent of what is inside it.
 *
 * Local recovery and version history are keyed on this rather than on the
 * document's `docId`: `docId` is read out of the document body, so a file that
 * fails to parse yields no `docId` and its snapshots become unreachable — the
 * backup vanishes precisely when it is the only way back. The shell survives
 * truncation of the document block, so the meta stays readable.
 */
export function getFileId(): string {
  const fromShell = readFileIdFromShell();
  if (fromShell) return fromShell;
  const name = getFileName();
  return name ? `byname_${name}` : "unknown-file";
}

export function adoptFileId(fileId: string): void {
  if (typeof document === "undefined" || !document.head) return;
  const existing = document.querySelector?.('meta[name="fish:fileId"]');
  if (existing) {
    existing.setAttribute("content", fileId);
    return;
  }
  const meta = document.createElement("meta");
  meta.setAttribute("name", "fish:fileId");
  meta.setAttribute("content", fileId);
  document.head.appendChild(meta);
}

