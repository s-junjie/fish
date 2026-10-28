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
console.log("| 形态 | 文件 | 声明 | 结论 |");
console.log("| --- | --- | --- | --- |");
console.log(row("grid-template-columns: 290px 1fr 300px", filesWith.mixedPxFr, trackForms.mixedPxFr, "混合 px/fr：改宽度时按什么比例分，导入丢失"));
console.log(row("repeat(auto-fit, minmax(360px, 1fr))", filesWith.autoFit, trackForms.autoFit, "列数是宽度的函数，计算值里已被解析掉"));
console.log(row("repeat(N, 1fr)", filesWith.equalFr, trackForms.equalFr, "等宽，已由 `columns: N` 覆盖"));
console.log(row("max-width: <px>", filesWith.maxWidth, declarations.maxWidth, "限宽惯用法，引擎不 clamp"));
console.log(row("min-height: 0", filesWith.minHeightZero, declarations.minHeightZero, "flex 自动最小尺寸的变通，对引擎是空操作"));
console.log(`\n（另：纯 px 的 grid-template-columns ${trackForms.fixedPx} 条，导入无损）\n`);
