import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// A frosted panel has to survive the export, and the only way to know it did is
// to look at the pixels: the panel is a `<div style="backdrop-filter">` inside a
// `<foreignObject>`, and an `<img>`-loaded SVG paints nothing in there. So this
// spec measures contrast across a stripe pattern with and without the panel over
// it, rather than asserting on markup that a broken export would still produce.
//
// A background of 10px black/white stripes is the probe: blurring averages three
// periods, so the peak-to-trough across a scanline collapses. The panel's own fill
// is left off, because an opaque fill hides the backdrop and the test would pass
// against a panel that blurred nothing.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const pageErrors = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

const W = 400;
const H = 300;
const PANEL = { x: 200, y: 40, width: 120, height: 100 };
const SCAN_Y = 90;
// A frame clips its content, and the clip lands on an unkeyed `<g>` that the
// layer split copies into every layer intact. A frosted panel inside one is the
// shape every real design has, and it is the case a too-eager "this group cannot
// be split" rule silently drops.
const CARD = { x: 20, y: 180, width: 130, height: 90 };
const NESTED = { x: 30, y: 195, width: 110, height: 60 };
const NESTED_SCAN_Y = 225;

const stripes = Array.from({ length: W / 10 }, (_, i) => ({
  id: `stripe_${i}`,
  type: "rect",
  x: i * 10,
  y: 0,
  width: 10,
  height: H,
  fills: [{ type: "solid", color: i % 2 === 0 ? "#000000" : "#FFFFFF" }]
}));

const candidate = {
  fonts: [{ family: "Testface", weight: 400, src: "data:font/woff2;base64,d09GMgABAAAA" }],
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: W, height: H },
      children: [
        ...stripes,
        {
          id: "frost",
          type: "rect",
          name: "Frosted",
          x: PANEL.x,
          y: PANEL.y,
          width: PANEL.width,
          height: PANEL.height,
          effects: [{ type: "backdrop-blur", blur: 24, enabled: true }]
        },
        {
          id: "card",
          type: "frame",
          name: "Card",
          x: CARD.x,
          y: CARD.y,
          width: CARD.width,
          height: CARD.height,
          clipContent: true,
          fillEnabled: false,
          children: [
            {
              id: "nested",
              type: "rect",
              name: "Nested frosted",
              x: NESTED.x - CARD.x,
              y: NESTED.y - CARD.y,
              width: NESTED.width,
              height: NESTED.height,
              effects: [{ type: "backdrop-blur", blur: 18, enabled: true }]
            }
          ]
        },
        {
          id: "label",
          type: "text",
          name: "Label",
          x: 12,
          y: 12,
          width: 160,
          height: 24,
          content: "one run",
          style: { fontFamily: "Testface, monospace", fontSize: 20, color: "#808080" }
        },
        {
          id: "banner",
          type: "rect",
          name: "Banner",
          x: 300,
          y: 220,
          width: 80,
          height: 60,
          fills: [
            { type: "linear-gradient", from: "#FF0000", to: "#0000FF", angle: 45 }
          ]
        }
      ]
    }
  ],
  activePageId: "p1"
};

const out = await page.evaluate(
  async ({ doc, panel, scanY, nested, nestedScanY }) => {
    const normalized = window.__fish.normalize(doc);
    window.__FISH_BRIDGE__.applyDoc(normalized.document);
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))
    );

    // Rasterize a data URL and read one scanline out of it, so the assertion is
    // about the shipped pixels rather than about intent.
    const readRow = async (dataUrl, fromX, toX, y) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = dataUrl;
      });
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const row = ctx.getImageData(fromX, y, toX - fromX, 1).data;
      const lum = [];
      for (let i = 0; i < row.length; i += 4) {
        lum.push(0.2126 * row[i] + 0.7152 * row[i + 1] + 0.0722 * row[i + 2]);
      }
      return lum;
    };
    const spread = (xs) => Math.round(Math.max(...xs) - Math.min(...xs));

    const png = await window.__fish.exportCanvasPng({ scale: 1 });
    const svg = await window.__fish.exportCanvasSvg({ scale: 1 });
    // `banner` carries the document's only gradient, so a selection that leaves it
    // out is the case where an unpruned <defs> shows up.
    const svgNoBanner = await window.__fish.exportCanvasSvg({
      scale: 1,
      allowedElementIds: new Set(["frost"])
    });

    const painted = document.querySelectorAll("[data-element-id]").length;
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    return {
      repairs: normalized.repairs,
      painted,
      outside: spread(await readRow(png, 20, 180, scanY)),
      inside: spread(await readRow(png, panel.x + 10, panel.x + panel.width - 10, scanY)),
      bareBelow: spread(await readRow(png, 160, 320, nestedScanY)),
      nestedInside: spread(
        await readRow(png, nested.x + 6, nested.x + nested.width - 6, nestedScanY)
      ),
      pngSize: png.length,
      svg,
      svgNoBanner,
      textRuns: [...parsed.querySelectorAll("text")].map((t) => t.textContent),
      hasForeignObject: /<foreignObject/.test(svg),
      bakedImages: (svg.match(/<image/g) || []).length,
      hasBakeClip: /bd_clip_/.test(svg),
      hasFontFace: /@font-face/.test(svg) && /Testface/.test(svg),
      keptGradient: (svg.match(/grad_fill_banner/g) || []).length,
      droppedGradient: (svgNoBanner.match(/grad_fill_banner/g) || []).length,
      droppedWrapper: /<g><\/g>|<g>\s*<\/g>/.test(svgNoBanner)
    };
  },
  {
    doc: candidate,
    panel: PANEL,
    scanY: SCAN_Y,
    nested: NESTED,
    nestedScanY: NESTED_SCAN_Y
  }
);

check(
  "the backdrop effect is a property the engine keeps",
  !out.repairs.some((r) => /blur|effects/i.test(`${r.path} ${r.message}`)),
  out.repairs.map((r) => r.path).join(",") || "none"
);
check("the document is painted before the export runs", out.painted > 10, `${out.painted} elements`);

// The whole point: without the blur the panel's scanline is as contrasty as the
// bare stripes beside it.
check(
  "the stripes outside the panel are full contrast",
  out.outside > 200,
  `spread ${out.outside}`
);
check(
  "the panel's backdrop is blurred in the exported PNG",
  out.inside < out.outside / 2,
  `inside ${out.inside} vs outside ${out.outside}`
);

// The frame's clip rides on an unkeyed `<g>`, which the layer split copies whole
// into every layer. Treating it as unsplittable is what dropped these entirely.
check(
  "a frosted panel inside a clipping frame is blurred too",
  out.bareBelow > 200 && out.nestedInside < out.bareBelow / 2,
  `inside ${out.nestedInside} vs bare ${out.bareBelow}`
);

// A backdrop div with no text used to be re-read as an empty text run, which the
// emitter turned into one NBSP in a default 24px white face.
check(
  "no text run is invented for the backdrop",
  out.textRuns.length === 1 && out.textRuns[0].trim() === "one run",
  JSON.stringify(out.textRuns)
);
check("the vector export carries no foreignObject", !out.hasForeignObject);
check(
  "the frosted backdrop is baked into the vector file",
  out.bakedImages > 0 && out.hasBakeClip,
  `${out.bakedImages} image(s)`
);
check(
  "the declared font is embedded, so the file does not depend on the reader",
  out.hasFontFace,
  out.hasFontFace ? "present" : "absent"
);
// The live <defs> is scoped to the viewport, and `retainSelection` cannot see into
// it, so a one-element crop used to ship every gradient in the document. Selective
// matters as much as aggressive: the full export still needs its own.
check(
  "a definition the export does use is kept",
  out.keptGradient > 0,
  `${out.keptGradient} id(s) in the full export`
);
check(
  "a definition the export does not use does not ship",
  out.droppedGradient === 0 && !out.droppedWrapper,
  `${out.droppedGradient} leftover gradient id(s)`
);
check("the export is a real PNG", out.pngSize > 2000, `${out.pngSize} chars`);
check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
