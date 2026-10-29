// How common each layout form is in the corpus. Which import gap is worth
// closing is a question about FREQUENCY, and a frequency nobody can re-derive is
// an opinion — the §10.1 table used to be hand-counted, and two people counting
// the same thing with two patterns got two different answers. This is the second
// attempt at that number being a fact: `npm run html:corpus` prints it again.
//
// Usage: node scripts/html-import-corpus.mjs [dir]

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "demo/design-directions";
const files = readdirSync(dir).filter((f) => f.endsWith(".html")).sort();

/** `@media (max-width: 900px)` is a query, not an element's own boundary. */
const withoutMediaQueries = (src) => src.replace(/@media[^{]*\{/g, "{");

const trackForms = { mixedPxFr: 0, autoFit: 0, equalFr: 0, fixedPx: 0 };
const filesWith = { mixedPxFr: new Set(), autoFit: new Set(), equalFr: new Set(), maxWidth: new Set(), minHeightZero: new Set() };
const declarations = { maxWidth: 0, minHeightZero: 0 };

for (const file of files) {
  const src = withoutMediaQueries(readFileSync(path.join(dir, file), "utf8"));

  // One `grid-template-columns` declaration, classified once by whether its
  // tracks can follow a resize: `auto-fit` derives the count, a mixed px/fr list
  // has proportions to redistribute, an all-fr list is already `columns: N`.
  for (const m of src.matchAll(/grid-template-columns\s*:\s*([^;}]+)/g)) {
    const value = m[1];
    if (/repeat\(\s*auto-(fit|fill)/i.test(value)) {
      trackForms.autoFit++;
      filesWith.autoFit.add(file);
    } else if (/\d+fr/.test(value) && /\d+px/.test(value)) {
      trackForms.mixedPxFr++;
      filesWith.mixedPxFr.add(file);
    } else if (/\d+fr/.test(value)) {
      trackForms.equalFr++;
      filesWith.equalFr.add(file);
    } else {
      trackForms.fixedPx++;
    }
  }

  for (const m of src.matchAll(/\bmax-width\s*:\s*\d+(?:\.\d+)?px/g)) {
    declarations.maxWidth++;
    filesWith.maxWidth.add(file);
  }
  for (const m of src.matchAll(/\bmin-height\s*:\s*0(?:px)?\s*[;}]/g)) {
    declarations.minHeightZero++;
    filesWith.minHeightZero.add(file);
  }
}

const row = (form, hit, decls, note) => `| \`${form}\` | ${hit.size} / ${files.length} | ${decls} | ${note} |`;

console.log(`\n${files.length} files in ${dir}/\n`);
console.log("| form | file | declaration | verdict |");
console.log("| --- | --- | --- | --- |");
console.log(row("grid-template-columns: 290px 1fr 300px", filesWith.mixedPxFr, trackForms.mixedPxFr, "mixed px/fr: when width changes, the split ratio is undefined; lost on import"));
console.log(row("repeat(auto-fit, minmax(360px, 1fr))", filesWith.autoFit, trackForms.autoFit, "column count depends on width; resolved away in computed values"));
console.log(row("repeat(N, 1fr)", filesWith.equalFr, trackForms.equalFr, "equal width, already covered by `columns: N`"));
console.log(row("max-width: <px>", filesWith.maxWidth, declarations.maxWidth, "width-limiting idiom; engine does not clamp"));
console.log(row("min-height: 0", filesWith.minHeightZero, declarations.minHeightZero, "flex auto-min-size workaround; no-op for the engine"));
console.log(`\n(note: ${trackForms.fixedPx} pure-px grid-template-columns rows import losslessly)\n`);
