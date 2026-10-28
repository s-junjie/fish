/**
 * The closing tag for `name`, searched case-insensitively WITHOUT lowercasing the
 * file.
 *
 * `html.toLowerCase().indexOf(...)` runs per element, and a saved document is
 * tens of megabytes: the walker copied the whole buffer once per `<script` it
 * found. A char scan allocates nothing, and it also sidesteps the trap that a
 * lowercased string is not always the same length as the original — every offset
 * here is used against the original.
 */
function indexOfClosingTag(html, name, from) {
  const needle = `</${name}`;
  const last = html.length - needle.length;
  for (let i = from; i <= last; i++) {
    if (html.charCodeAt(i) !== 60) continue;
    let match = true;
    for (let k = 1; k < needle.length; k++) {
      let code = html.charCodeAt(i + k);
      if (code >= 65 && code <= 90) code += 32;
      if (code !== needle.charCodeAt(k)) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * The `<script>` / `<style>` walker the shell scripts share.
 *
 * A regex over the raw bytes finds `<script` inside the document JSON, inside a
 * comment, or inside a base64 asset, and each hit looks like a plausible open
 * tag. Walking the markup instead means the body of an element is consumed as
 * one opaque run, so a `<script` two hundred kilobytes inside #design-doc cannot
 * be mistaken for the runtime bundle — and quoted attribute values are skipped
 * rather than ending the open tag at the first `>`.
 *
 * Yields each element with its source spans, so a caller can splice it out.
 */
export function* scanElements(html) {
  let pos = 0;
  while (pos < html.length) {
    const open = html.indexOf("<", pos);
    if (open < 0) return;
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      pos = end < 0 ? html.length : end + 3;
      continue;
    }
    const name = /^<(script|style)\b/i.exec(html.slice(open, open + 8));
    if (!name) {
      pos = open + 1;
      continue;
    }
    let cursor = open + name[0].length;
    let quote = null;
    for (; cursor < html.length; cursor++) {
      const ch = html[cursor];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    const attrText = html.slice(open + name[0].length, cursor);
    const close = indexOfClosingTag(html, name[1].toLowerCase(), cursor);
    if (close < 0) return;
    const bodyEnd = html.indexOf(">", close);
    if (bodyEnd < 0) return;
    yield {
      tag: name[1].toLowerCase(),
      attrs: attrText,
      attr: (key) => new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(attrText)?.[1] ?? "",
      id: /\bid\s*=\s*"([^"]*)"/.exec(attrText)?.[1] ?? "",
      start: open,
      end: bodyEnd + 1,
      // `close`, not the next `<`: bundle text is full of `<` from comparisons and
      // arrow-free minified templates, and cutting there would truncate the payload.
      text: html.slice(cursor + 1, close)
    };
    pos = bodyEnd + 1;
  }
}

/** The real `<script id="...">` in the file, not the copy of its markup inside the bundle. */
export function blockById(html, id) {
  return [...scanElements(html)].find((el) => el.tag === "script" && el.id === id);
}
