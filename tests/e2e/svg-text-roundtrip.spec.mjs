import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// doc -> export -> import -> compare, the only check that closes the loop.
//
// Every other assertion about SVG text is a statement about one half of it. This
// one asks the question a user asks: "does exporting and re-importing my design
// give me my design back?" — and it is the check that failed silently for as long
// as the exporter wrote `y` as a line-box top with `dominant-baseline="hanging"`,
// because the importer faithfully read back the 0.26em lift the exporter had
// introduced. Fixing either half alone would have kept the other's error.
//
// Two things are compared and only one of them is exact:
//
//   - the BOX is not recoverable. An SVG records an anchor and a `<tspan>` per
//     line, not a rectangle, so a 400px-wide centred box comes back the width of
//     its text. `x`/`y` and the alignment ARE recoverable, and are asserted.
//   - the INK is exact. The clip is screenshotted twice with only one copy
//     painted, and the ink's centroid and per-row profile must match. That is
//     what "the text is where it was" actually means.
//
// The font's ascent comes back from `fontBoundingBoxAscent`, which Blink rounds to
// a whole pixel, so a one-pixel slack is expected at sizes where the real ascent
// is a half. Six sizes measured 0.0px of vertical difference; the slack is there
// for small text on other machines, not because anything is off here.

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const pageErrors = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

const CASES = [
  {
    id: "single",
    y: 60,
    content: "Hamburgefonstiv",
    style: { fontFamily: "Inter, sans-serif", fontSize: 24, color: "#111111" }
  },
  {
    id: "multi",
    y: 160,
    content: "first line\nsecond line",
    style: { fontFamily: "Inter, sans-serif", fontSize: 20, color: "#222222", lineHeight: 1.38 }
  },
  {
    id: "center",
    y: 280,
    content: "centred",
    style: { fontFamily: "Georgia, serif", fontSize: 28, color: "#333333", align: "center" }
  },
  {
    id: "right",
    y: 380,
    content: "right",
    style: { fontFamily: "Inter, sans-serif", fontSize: 18, color: "#444444", align: "right" }
  },
  {
    id: "italic",
    y: 460,
    content: "Italic",
    style: { fontFamily: "Inter, sans-serif", fontSize: 32, color: "#555555", fontWeight: 700, fontStyle: "italic" }
  },
  // An empty line is spelled `\u00A0` by the exporter, because an empty `<tspan>`
  // and a missing line are the same file. Read back as the empty line it was.
  {
    id: "blank",
    y: 580,
    content: "a\n\nb",
    style: { fontFamily: "Inter, sans-serif", fontSize: 22, color: "#666666" }
  }
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

const doc = {
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: 700, height: 700 },
      children: CASES.map((c) => ({
        id: c.id,
        type: "text",
        name: c.id,
        x: 80,
        y: c.y,
        width: 400,
        height: c.style.fontSize * 1.9,
        content: c.content,
        style: c.style,
        fills: [{ type: "solid", color: c.style.color }]
      }))
    }
  ],
  activePageId: "p1"
};

const svg = await page.evaluate(async (d) => {
  window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(d).document);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 400))));
  return window.__fish.exportCanvasSvg({ scale: 1 });
}, doc);

check("the export writes text as native <text>", /<text\b/.test(svg));
check("the export writes one line baseline per line", (svg.match(/<tspan\b/g) || []).length >= CASES.length);
// The lift this whole spec exists for: `hanging` put every run ~0.26em above the
// line box the canvas paints it in.
check("the export anchors text on the alphabetic baseline", !/dominant-baseline="hanging"/.test(svg));

const fixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fish-text-roundtrip-")), "design.svg");
fs.writeFileSync(fixture, svg);

// The media picker's image door is the one an .svg arrives through (`image/*`
// covers it); the importer takes it from there as layers.
await page.locator('input[type=file][name="media-file-image"]').setInputFiles(fixture);
try {
  await page.waitForFunction(
    (n) => (window.__fish.doc.pages || []).some((p) => (p.children || []).length > n),
    CASES.length,
    { timeout: 20000 }
  );
} catch {
  /* the reads below report the empty result */
}

const readAll = () =>
  page.evaluate(() => {
    const out = [];
    const walk = (els) => {
      for (const e of els || []) {
        if (e.type === "text") {
          out.push({
            id: e.id,
            content: e.content,
            x: Math.round(e.x * 100) / 100,
            y: Math.round(e.y * 100) / 100,
            width: Math.round(e.width * 100) / 100,
            fontFamily: e.style?.fontFamily,
            fontSize: e.style?.fontSize,
            fontWeight: e.style?.fontWeight,
            fontStyle: e.style?.fontStyle,
            align: e.style?.align ?? "left",
            fill: Array.isArray(e.fills) && e.fills[0] ? e.fills[0].color : null
          });
        }
        walk(e.children);
      }
    };
    for (const p of window.__fish.doc.pages || []) walk(p.children);
    return out;
  });

const all = await readAll();
const originals = all.filter((e) => CASES.some((c) => c.id === e.id));
const imported = all.filter((e) => !CASES.some((c) => c.id === e.id));

check("the import produces one text element per <text>", imported.length === CASES.length, `${imported.length} of ${CASES.length}`);

const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
/**
 * The edge the alignment pins, which is the one the SVG actually recorded.
 *
 * `x` itself is NOT recoverable for a centred or right-aligned run: the file holds
 * the anchor and the line, never the box, so a 400px-wide box comes back the width
 * of its text — and its `x` moves with it. What must not move is the anchor, and
 * that is what is compared. The ink check below is the same statement in pixels.
 */
const anchorOf = (e) =>
  e.align === "center" ? e.x + e.width / 2 : e.align === "right" ? e.x + e.width : e.x;

for (const c of CASES) {
  const o = originals.find((e) => e.id === c.id);
  const i = imported.find((e) => e.content === c.content);
  if (!o || !i) {
    check(`${c.id} survives the round trip`, false, o ? "nothing imported" : "original missing");
    continue;
  }
  const diffs = [];
  if (!near(anchorOf(o), anchorOf(i))) diffs.push(`anchor ${anchorOf(o)}->${anchorOf(i)}`);
  if (!near(o.y, i.y)) diffs.push(`y ${o.y}->${i.y}`);
  if (o.fontSize !== i.fontSize) diffs.push(`fontSize ${o.fontSize}->${i.fontSize}`);
  if (o.fontFamily !== i.fontFamily) diffs.push(`fontFamily ${o.fontFamily}->${i.fontFamily}`);
  if ((o.fontWeight ?? 400) !== (i.fontWeight ?? 400)) diffs.push(`weight ${o.fontWeight}->${i.fontWeight}`);
  if ((o.fontStyle ?? "normal") !== (i.fontStyle ?? "normal")) diffs.push(`style ${o.fontStyle}->${i.fontStyle}`);
  if (o.fill !== i.fill) diffs.push(`fill ${o.fill}->${i.fill}`);
  // The content has to come back byte for byte: the newlines and the blank line
  // are the whole reason the exporter writes `dy` per `<tspan>`.
  if (o.content !== i.content) diffs.push(`content ${JSON.stringify(o.content)}->${JSON.stringify(i.content)}`);
  check(`${c.id} comes back with its anchor, face and ink`, diffs.length === 0, diffs.join(", "));
}

const aligned = CASES.filter((c) => c.style.align === "center" || c.style.align === "right").map((c) => c.id);
for (const id of aligned) {
  const o = originals.find((e) => e.id === id);
  const i = imported.find((e) => e.content === o.content);
  check(`${id} keeps its alignment`, Boolean(i) && o.align === i.align, i ? `${o.align} vs ${i.align}` : "nothing imported");
}

// ---------------------------------------------------------------------------
// Ink. The box is not recoverable, so this is the assertion that says the text
// is where it was: the same clip, screenshotted with one copy painted at a time.
// ---------------------------------------------------------------------------

await page.evaluate(() => window.__FISH_BRIDGE__.selectElements([]));
await page.evaluate(() => new Promise((r) => setTimeout(r, 2500))); // let the import toast go

const visibleOnly = (id) =>
  page.evaluate((want) => {
    // `display: none` on everything but the target, and on nothing that CONTAINS
    // it — an imported text lives inside the frame's `<g>`, and hiding that hid
    // the text with it.
    const target = document.querySelector(`[data-element-id="${want}"]`);
    const keep = new Set();
    for (let n = target; n; n = n.parentElement) {
      const v = n.getAttribute ? n.getAttribute("data-element-id") : null;
      if (v) keep.add(v);
    }
    for (const g of document.querySelectorAll("[data-element-id]")) {
      g.style.display = keep.has(g.getAttribute("data-element-id")) ? "" : "none";
    }
  }, id);

const inkAt = async (clip) => {
  const buf = await page.screenshot({ clip });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let w = 0;
    let wy = 0;
    let wx = 0;
    const rows = [];
    for (let y = 0; y < cv.height; y++) {
      let row = 0;
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4;
        const ink = Math.max(0, 255 - (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]));
        w += ink;
        wy += ink * y;
        wx += ink * x;
        row += ink;
      }
      rows.push(Math.round(row));
    }
    return { x: wx / w, y: wy / w, mass: w / 255, rows };
  }, buf.toString("base64"));
};

for (const id of ["single", "multi", "center", "right", "blank"]) {
  const o = originals.find((e) => e.id === id);
  const i = imported.find((e) => e.content === o.content);
  if (!i) {
    check(`${id} paints its ink back where it was`, false, "nothing imported");
    continue;
  }
  const clip = await page.evaluate(
    (pair) => {
      const rect = (key) => document.querySelector(`[data-element-id="${key}"]`).getBoundingClientRect();
      const a = rect(pair[0]);
      const b = rect(pair[1]);
      const m = 8;
      const left = Math.min(a.left, b.left) - m;
      const top = Math.min(a.top, b.top) - m;
      return { x: left, y: top, width: Math.max(a.right, b.right) - left + m, height: Math.max(a.bottom, b.bottom) - top + m };
    },
    [id, i.id]
  );
  await visibleOnly(id);
  const a = await inkAt(clip);
  await visibleOnly(i.id);
  const b = await inkAt(clip);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const worstRow = a.rows.reduce((acc, n, y) => Math.max(acc, Math.abs(n - b.rows[y])), 0);
  check(
    `${id} paints its ink back where it was`,
    Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && worstRow <= 24,
    `dx ${dx.toFixed(2)} dy ${dy.toFixed(2)} worst row ${worstRow}/255`
  );
}

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
