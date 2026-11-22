import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// An HTML embed cannot travel as markup, but its authored page still has to
// travel as pixels. Both the resting canvas badge and the selected iframe are
// editor state, so neither may survive into a PNG or SVG export.
//
//   1. pixel   - the exported PNG contains the srcdoc's own background/ink
//   2. chrome  - the editor's "Click to preview" badge is gone
//   3. selected - selecting the embed does not change what is exported
//   4. fallback - a page that cannot be fetched exports a placeholder, not chrome
//
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

const SOURCE = `<!doctype html><html><head><style>
  html,body{margin:0;background:#0B7A75}
  h1{font:700 34px sans-serif;color:#FFFFFF;margin:40px 0 0 30px}
</style></head><body><h1>REAL HTML</h1></body></html>`;

const setup = async (embed) => {
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElements([]));
  await page.evaluate((el) => {
    const doc = {
      pages: [{ id: "p1", name: "P", canvas: { width: 600, height: 500 }, children: [el] }],
      activePageId: "p1"
    };
    window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(doc).document);
  }, embed);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120)))));
};

const exportState = async (selected) => {
  await page.evaluate((id) => {
    if (id) window.__FISH_BRIDGE__.selectElement(id);
    else window.__FISH_BRIDGE__.selectElements([]);
  }, selected ? "h1" : null);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120)))));
  return page.evaluate(async () => {
    const bounds = { x: 0, y: 0, width: 600, height: 500 };
    const png = await window.__fish.exportCanvasPng({ scale: 1, bounds });
    const svg = await window.__fish.exportCanvasSvg({ bounds });
    const img = new Image();
    img.src = png;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const at = (x, y) => [px[(y * canvas.width + x) * 4], px[(y * canvas.width + x) * 4 + 1], px[(y * canvas.width + x) * 4 + 2]];
    let ink = 0;
    for (let y = 30; y < 230; y++) {
      for (let x = 40; x < 360; x++) {
        const [r, g, b] = at(x, y);
        if (r > 230 && g > 230 && b > 230) ink++;
      }
    }
    return {
      background: at(300, 200),
      ink,
      chromeAt: svg.indexOf("Click to preview"),
      hasImage: /<image[^>]+href="data:image\/png/.test(svg),
      size: [img.width, img.height]
    };
  });
};

await setup({ id: "h1", type: "html", name: "Embed", x: 40, y: 30, width: 320, height: 200, srcdoc: SOURCE });
const resting = await exportState(false);
check("PNG has the embedded page's background", resting.background, [11, 122, 117]);
check("PNG has the embedded page's ink", resting.ink > 200, true);
check("SVG carries the baked page as an image", resting.hasImage, true);
check("no editor badge in the resting export", resting.chromeAt, -1);
check("export keeps the requested size", resting.size, [600, 500]);

const selected = await exportState(true);
check("selection does not change the baked background", selected.background, resting.background);
check("no editor badge in the selected export", selected.chromeAt, -1);

await setup({ id: "h1", type: "html", name: "Embed", x: 40, y: 30, width: 320, height: 200, src: "http://127.0.0.1:1/unreachable.html" });
const fallback = await exportState(false);
check("unreachable page falls back without editor chrome", fallback.chromeAt, -1);

check("no page errors", errors, []);
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
await browser.close();
if (results.some((r) => !r.ok)) process.exitCode = 1;
