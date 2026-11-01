/**
 * Whether a saved `.fish.html` may be edited at all.
 *
 * A statement about the FILE, not about the session: `?view=` is a request and
 * a narrow touch screen is a guess, but "this copy is for reading" has to
 * survive being mailed to someone whose window is 1440px wide. So it is stamped
 * into the shell, which is the only part of a single-file document that travels
 * with it.
 *
 * Read from the live DOM, never scanned out of HTML text: the inlined bundle
 * carries this tag's literal spelling in its own source, and a text search
 * would answer "read-only" for every file. Same trap, same answer as
 * `file-identity.ts`.
 *
 * It is a lock on the application, not on the bytes: the document block is in
 * the same file, and anyone who edits the markup can lift the flag. It stops a
 * reviewer from saving over a review copy; it is not a rights management system.
 */
export const POLICY_META_NAME = "fish:policy";
export const READ_ONLY_POLICY = "read-only";

const POLICY_META_RE = /[ \t]*<meta\s+name=["']fish:policy["'][^>]*>\s*/gi;

export function readOnlyFromShell(): boolean {
  if (typeof document === "undefined") return false;
  const meta = document.querySelector?.(`meta[name="${POLICY_META_NAME}"]`);
  return meta?.getAttribute("content") === READ_ONLY_POLICY;
}

/**
 * Put the policy into a shell, or take it out again.
 *
 * Idempotent by construction — the meta is stripped before it is written, so a
 * save of a shell that already carries one cannot end up with two answers.
 * `readOnly: false` is not a no-op: it is how an editor save clears a flag it
 * is about to make untrue.
 */
export function stampFilePolicy(html: string, readOnly: boolean): string {
  const stripped = html.replace(POLICY_META_RE, "");
  if (!readOnly) return stripped;
  const tag = `<meta name="${POLICY_META_NAME}" content="${READ_ONLY_POLICY}">`;
  if (/<\/head>/i.test(stripped)) return stripped.replace(/<\/head>/i, `  ${tag}\n</head>`);
  if (/<head[^>]*>/i.test(stripped)) return stripped.replace(/<head[^>]*>/i, (m) => `${m}\n  ${tag}`);
  return `${tag}\n${stripped}`;
}
