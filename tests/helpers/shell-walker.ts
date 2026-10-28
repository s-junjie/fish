/**
 * The markup walker every shell test shares.
 *
 * Real elements only: the uncompressed bundle spells `<script` inside JS
 * strings (and the compressed one cannot, because b86 has no `<` in its
 * alphabet), so a byte-level `/<script/g` count finds decoys the build never
 * emitted and reports a file that would have been truncated by its own
 * contents. Anything that asks "how many script elements does this file have"
 * has to walk it the way a parser would — attribute quoting included — or it
 * is measuring JavaScript source.
 */
export interface ShellElement {
  id: string;
  attrs: string;
  text: string;
}

export function elements(html: string, tag: string): ShellElement[] {
  const found: ShellElement[] = [];
  const open = new RegExp(`<${tag}\\b`, "gi");
  for (let m = open.exec(html); m; m = open.exec(html)) {
    let cursor = m.index + tag.length + 1;
    let quote: string | null = null;
    for (; cursor < html.length; cursor++) {
      const ch = html[cursor];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    const attrs = html.slice(m.index + tag.length + 1, cursor);
    const close = html.toLowerCase().indexOf(`</${tag}`, cursor);
    if (close < 0) break;
    const end = html.indexOf(">", close);
    found.push({
      id: /\bid\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? "",
      attrs,
      text: html.slice(cursor + 1, close)
    });
    open.lastIndex = end + 1;
  }
  return found;
}

/** One plaintext data block: the id a frozen updater keys off. */
export function block(html: string, id: string): ShellElement | undefined {
  return elements(html, "script").find((el) => el.id === id);
}

/** The count of `</tag` markers, which is what actually ends an element. */
export function closers(html: string, tag: string): number {
  return (html.match(new RegExp(`</${tag}`, "gi")) ?? []).length;
}
