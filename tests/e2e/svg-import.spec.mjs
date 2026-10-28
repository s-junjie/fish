import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The SVG import door, driven as a person drives it.
//
// This is an e2e spec rather than a unit test because the whole conversion reads
// the LIVE DOM: `getCTM()` folds the `viewBox` scale and every ancestor
// transform, and `getComputedStyle` is what resolves `fill` to a colour. Neither
// exists in the vitest environment, so the importer has never had coverage — and
// the three things checked below are exactly the three that were wrong in
// silence:
//
//   1. a bare .svg file imports at all — an `<svg>` root is `display: inline`,
//      so the walk read it as inline content, produced nothing, and the import
//      failed with "Nothing in the document produced an element"
//   2. a gradient-filled shape keeps SOME ink — dropping the fill entirely left
//      `fills` unset, which is not "unpainted", it is invisible
//   3. a degenerate `<line>` and a malformed `<polygon>` are refused, not
//      silently turned into a different shape
//
// The fixture is written literally rather than generated so that what is checked
// is what a designer's export actually looks like — `<?xml` prologue, camelCase
// `<linearGradient>`, an `href`-inheriting gradient, and all of it.

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const pageErrors = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 24 24">
  <defs>
    <linearGradient id="ramp" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FF0000"/>
      <stop offset="1" stop-color="#0000FF"/>
    </linearGradient>
    <linearGradient id="inherited" href="#ramp"/>
  </defs>
  <rect x="1" y="1" width="22" height="22" rx="4" fill="url(#ramp)"/>
  <circle cx="12" cy="12" r="3" fill="url(#inherited)"/>
  <path d="M6 12 L10 16 L18 8" fill="none" stroke="url(#ramp)" stroke-width="2"/>
  <polygon points="16,4 20,4 18,8" fill="#00FF00"/>
  <line x1="2" y1="2" x2="2" y2="2" stroke="#000000" stroke-width="1"/>
  <polygon points="4,4 8,4 bad 8" fill="#0000FF"/>
</svg>`;

const fixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fish-svg-import-")), "icon.svg");
fs.writeFileSync(fixture, svg);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

// There is ONE door for both pictures and vectors: `.svg` is `image/*`, so the
// media picker's image input is what an SVG arrives through, and `useAssetInsertion`
// hands it to the vector importer before the image loader can see it. Located by
// name rather than by accept — the accept string is the part that churns, "this
// is the image door" is the part that does not.
const picker = page.locator('input[type=file][name="media-file-image"]');
const acceptAttr = (await picker.count()) === 1 ? await picker.getAttribute("accept") : null;
check(
  "the image picker's filter covers .svg",
  Boolean(acceptAttr) && /image\/\*|\.svg|image\/svg\+xml/.test(acceptAttr),
  `${await picker.count()} input(s), accept ${acceptAttr}`
);

await picker.setInputFiles(fixture);
try {
  await page.waitForFunction(
    () => (window.__fish.doc.pages || []).some((p) => (p.children || []).length > 0),
    { timeout: 45000 }
  );
} catch {
  /* the checks below report the empty document */
}

const readAll = () =>
  page.evaluate(() => {
    const out = [];
    const walk = (els) => {
      for (const e of els || []) {
        out.push({
          name: e.name,
          type: e.type,
          x: e.x,
          y: e.y,
          width: Math.round(e.width ?? 0),
          height: Math.round(e.height ?? 0),
          content: e.content ?? null,
          fontSize: e.style?.fontSize ?? null,
          fillColor: Array.isArray(e.fills) && e.fills[0] ? e.fills[0].color : null,
          fills: e.fills ?? null,
          strokes: e.strokes ?? null
        });
        walk(e.children);
      }
    };
    for (const p of window.__fish.doc.pages || []) walk(p.children);
    return out;
  });

const imported = await readAll();

const named = (fragment) => imported.filter((e) => String(e.name).includes(fragment));
const firstColor = (e) => (e && Array.isArray(e.fills) && e.fills[0] ? e.fills[0].color : null);
const strokeColor = (e) => (e && Array.isArray(e.strokes) && e.strokes[0] ? e.strokes[0].color : null);
const hasImageFill = (e) => Array.isArray(e.fills) && e.fills.some((f) => f && f.type === "image");

check("a bare .svg file produces elements", imported.length > 0, `${imported.length} element(s)`);
// The reason SVG is routed away from the image loader at all: as a picture it is
// one rect pointing at the file, which is not an icon anyone can edit.
check(
  "it comes in as layers, not as one rect wearing the file as an image fill",
  !imported.some(hasImageFill),
  `${imported.filter(hasImageFill).length} image fill(s)`
);
check(
  "a gradient-filled rect keeps some ink",
  firstColor(named("svg / rect")[0]) === "#FF0000",
  String(firstColor(named("svg / rect")[0]))
);
check(
  "a gradient reached through href keeps its stops",
  firstColor(named("svg / circle")[0]) === "#FF0000",
  String(firstColor(named("svg / circle")[0]))
);
check(
  "a gradient stroke falls back too",
  strokeColor(named("svg / path")[0]) === "#FF0000",
  String(strokeColor(named("svg / path")[0]))
);
check("a well-formed polygon still imports", named("svg / polygon").length === 1, `${named("svg / polygon").length}`);
check("a zero-length line is refused", !imported.some((e) => e.type === "path" && String(e.name).includes("line")));
check(
  "a malformed polygon is refused, not silently re-paired",
  !imported.some((e) => String(e.name).includes("polygon") && firstColor(e) === "#0000FF")
);
const root = imported[0];
check(
  "the import is the svg's own size, not the viewport's",
  root && root.width === 120 && root.height === 120,
  root ? `${root.width}x${root.height}` : "no root element"
);

// An icon authored as nothing but a viewBox. As a block with no width pinned
// it measured the host's full width — 1384 — and every shape came in ~57× too
// large, which is a far worse import than a failure.
const clearPage = () =>
  page.evaluate(() => {
    window.__FISH_BRIDGE__.applyDoc(
      window.__fish.normalize({
        pages: [{ id: "p1", name: "Page 1", canvas: { width: 1440, height: 900 }, children: [] }],
        activePageId: "p1"
      }).document
    );
  });

const boxOnly = path.join(path.dirname(fixture), "box-only.svg");
fs.writeFileSync(
  boxOnly,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" fill="#ff0000"/></svg>`
);
await clearPage();
await picker.setInputFiles(boxOnly);
try {
  await page.waitForFunction(
    () => (window.__fish.doc.pages || []).some((p) => (p.children || []).length > 0),
    { timeout: 45000 }
  );
} catch {
  /* the checks below report the empty document */
}
const boxed = await readAll();
check(
  "an svg with only a viewBox imports at the viewBox size",
  boxed[0] && boxed[0].width === 24 && boxed[0].height === 24,
  boxed[0] ? `${boxed[0].width}x${boxed[0].height}` : "no root element"
);

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

// ---------------------------------------------------------------------------
// Text, hand-written rather than exported — the shape an icon sheet or a
// designer's own file arrives in. Before this, every `<text>` was reported as an
// unsupported element and dropped, which also meant FISH could not read its OWN
// exports back: the exporter writes native `<text>`.
// ---------------------------------------------------------------------------

const textSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80">
  <defs>
    <linearGradient id="warm" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#FF0000"/>
      <stop offset="1" stop-color="#0000FF"/>
    </linearGradient>
  </defs>
  <text x="10" y="40" font-family="Inter, sans-serif" font-size="16" fill="#112233">Hello</text>
  <text x="10" y="70" font-family="Inter, sans-serif" font-size="16" fill="url(#warm)" dominant-baseline="hanging">Ink</text>
</svg>`;

const textFixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fish-svg-text-")), "label.svg");
fs.writeFileSync(textFixture, textSvg);

await page.evaluate(() => {
  const page = window.__fish.doc.pages.find((p) => p.id === window.__fish.doc.activePageId);
  window.__FISH_BRIDGE__.applyDoc(
    window.__fish.normalize({ pages: [{ ...page, children: [] }], activePageId: page.id }).document
  );
});
await picker.setInputFiles(textFixture);
try {
  await page.waitForFunction(
    () => (window.__fish.doc.pages || []).some((p) => (p.children || []).length > 0),
    { timeout: 20000 }
  );
} catch {
  /* the checks below report the empty document */
}

const texts = (await readAll()).filter((e) => e.type === "text");
check("a hand-written <text> becomes a text element", texts.length === 2, `${texts.length} text element(s)`);
const hello = texts.find((e) => e.content === "Hello");
check("its string and face come across", Boolean(hello) && hello.fontSize === 16, hello ? `${JSON.stringify(hello.content)} ${hello.fontSize}px` : "missing");
check("its fill comes across", hello && hello.fillColor === "#112233", hello ? String(hello.fillColor) : "missing");
check("its x comes across", hello && Math.abs(hello.x - 10) < 0.5, hello ? String(hello.x) : "missing");
// The box top is ONE baseline above the `y` the author wrote, and no further:
// `y` is the baseline, so the box sits above it by the ascent plus any leading —
// under one em at the line height a 16px face gets, and never at or below it.
check(
  "the box top sits above the author's baseline, and not by a line",
  hello && hello.y < 40 && hello.y > 40 - 1.5 * 16,
  hello ? `y ${hello.y} for baseline 40` : "missing"
);
const ink = texts.find((e) => e.content === "Ink");
check(
  "a gradient-filled <text> keeps some ink",
  ink && ink.fillColor === "#FF0000",
  ink ? String(ink.fillColor) : "missing"
);
check("no page errors after the text import", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
