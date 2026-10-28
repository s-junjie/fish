import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// A selection export is cropped to the selection and MUST have a transparent
// background — that is the whole point of copying one layer out of a document.
// The ancestor chain is still needed (it carries the transforms that give the
// selected layer its coordinates), so the failure mode is quiet: the select
// layer is right, and the frame it sits in paints its own fill across the crop.
// A shadow on the ancestor leaks the same way through its `filter`.
//
//   1. transparent - the ancestor's fill is not in the crop
//   2. paint       - the selected layer itself is
//   3. shadow      - the selected layer's own shadow is (the crop grew for it)
//   4. vector      - the same tree, so the SVG carries no ancestor fill either
//   5. control     - selecting the ANCESTOR still exports its fill
//
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

const PANEL_FILL = [42, 42, 255, 255];
const CARD_FILL = [232, 232, 232, 255];
const BOUNDS = { x: 0, y: 0, width: 240, height: 240 };

const candidate = {
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: 400, height: 400 },
      children: [
        {
          id: "panel",
          type: "frame",
          name: "Panel",
          x: 20,
          y: 20,
          width: 200,
          height: 200,
          clipContent: true,
          fills: [{ type: "solid", color: "#2A2AFF" }],
          effects: [
            { id: "panelShadow", type: "drop-shadow", enabled: true, color: "#00000080", offset: { x: 0, y: 10 }, blur: 20, spread: 0 }
          ],
          children: [
            {
              id: "card",
              type: "rect",
              name: "Card",
              x: 70,
              y: 70,
              width: 60,
              height: 40,
              fills: [{ type: "solid", color: "#E8E8E8" }],
              effects: [
                { id: "cardShadow", type: "drop-shadow", enabled: true, color: "#00000080", offset: { x: 0, y: 8 }, blur: 16, spread: 0 }
              ]
            },
            {
              id: "frost",
              type: "rect",
              name: "Frost",
              x: 20,
              y: 130,
              width: 100,
              height: 50,
              fills: [{ type: "solid", color: "#FFFFFF22" }],
              effects: [{ id: "frostBlur", type: "backdrop-blur", enabled: true, blur: 24 }]
            }
          ]
        }
      ]
    }
  ],
  activePageId: "p1"
};

const out = await page.evaluate(
  async ({ doc, bounds }) => {
    const normalized = window.__fish.normalize(doc);
    window.__FISH_BRIDGE__.applyDoc(normalized.document);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))));

    const shot = async (ids) => {
      const dataUrl = await window.__fish.exportCanvasPng({ scale: 1, bounds, allowedElementIds: new Set(ids) });
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error("the exported PNG did not decode"));
        img.src = dataUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      const svg = await window.__fish.exportCanvasSvg({ scale: 1, bounds, allowedElementIds: new Set(ids) });
      return { size: [canvas.width, canvas.height], px, svg };
    };

    const card = await shot(["card"]);
    const panel = await shot(["panel"]);
    const frost = await shot(["frost"]);
    return {
      cardSize: card.size,
      panelFillArea: card.px(30, 30),
      cardBody: card.px(120, 110),
      cardShadow: card.px(120, 138),
      cardSvg: card.svg,
      panelBody: panel.px(30, 30),
      frostBackdrop: frost.px(30, 200),
      frostBody: frost.px(90, 175)
    };
  },
  { doc: candidate, bounds: BOUNDS }
);

const alpha = (rgba) => rgba[3];
const same = (rgba, expected) => rgba.every((v, i) => Math.abs(v - expected[i]) <= 2);

check("the crop is the requested box", out.cardSize[0] === 240 && out.cardSize[1] === 240, out.cardSize.join("x"));
check(
  "a selection exports on a transparent background",
  alpha(out.panelFillArea) === 0,
  `rgba(${out.panelFillArea.join(",")}) where the ancestor's fill is`
);
check("the selected layer still paints", same(out.cardBody, CARD_FILL), `rgba(${out.cardBody.join(",")})`);
check(
  "the selected layer's own shadow still exports",
  alpha(out.cardShadow) > 0 && alpha(out.cardShadow) < 255,
  `alpha ${alpha(out.cardShadow)} below the card`
);
check(
  "the vector export carries no ancestor fill",
  !/#2a2aff/i.test(out.cardSvg),
  out.cardSvg.match(/fill="#[0-9a-f]{6}"/gi)?.join(",") ?? ""
);
check(
  "selecting the ancestor still exports its fill",
  same(out.panelBody, PANEL_FILL),
  `rgba(${out.panelBody.join(",")})`
);
// A frosted selection goes through the layered path, which keys its layers on
// `data-element-id`. An ancestor that keeps its id there is both a layer key and
// a split barrier, so the panel's own plate is composited twice and the blur is
// dropped — the same bug wearing a different mask, and invisible in the fill
// check above because that path is only taken when a backdrop is selected.
check("a frosted selection stays on a transparent background", alpha(out.frostBackdrop) === 0, `alpha ${alpha(out.frostBackdrop)} beside it`);
check("a frosted selection is composited once", Math.abs(alpha(out.frostBody) - 0x22) <= 2, `alpha ${alpha(out.frostBody)}, one plate is 34`);
check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
