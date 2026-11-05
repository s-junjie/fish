import { chromium } from "playwright";
import { pathToFileURL } from "url";
import fs from "node:fs";
import path from "path";

// Canvas chrome never ships in an export.
//
// The hover preview — the dashed outline a plain click would select with — was
// the one overlay group without the `data-overlay` marker the exporter strips,
// and nothing cleared it when the pointer left the canvas. So the press on
// Export carried the last hovered layer's outline into the file: a selection
// export has a transparent background, and a 0.85-alpha stroke over it stores
// the selection blue as pure RGB, a bbox in the artwork that nothing drew.
//
// The frame and the hovered layer overlap here on purpose: a hover outline
// beside the crop would pass by luck, one inside it cannot.

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) => {
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

const downloads = [];
page.on("download", (d) => downloads.push(d));

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const applySetup = () =>
  page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements(
      [
        { id: "a", type: "frame", name: "A", x: 100, y: 100, width: 200, height: 200,
          fills: [{ type: "solid", color: "#EEEEEE" }] },
        { id: "b", type: "rect", name: "B", x: 150, y: 120, width: 200, height: 300,
          fills: [{ type: "solid", color: "#DDDDDD" }] }
      ],
      { canvas: { ...base.canvas, width: 1500, height: 900 } }
    );
  });

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const select = async (ids) => {
  await page.evaluate((list) => window.__FISH_BRIDGE__.selectElements(list), ids);
  await settle();
};
const hoverState = () =>
  page.evaluate(() => {
    const rect = document.querySelector('svg rect[opacity="0.85"]');
    const group = rect && rect.closest("g");
    return { painted: !!rect, marked: group ? group.getAttribute("data-overlay") : null };
  });
const hoverB = async () => {
  const at = await page.evaluate(() => {
    const r = document.querySelector('[data-element-id="b"]')?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(150);
};
/** The selection blue is chrome's own colour; artwork never paints it here. */
const bluePixels = async (download) => {
  const bytes = fs.readFileSync(await download.path());
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = "data:image/png;base64," + data;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data: px } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      if (b > 150 && b - r > 80 && b - g > 40) n++;
    }
    return n;
  }, bytes.toString("base64"));
};
const exportAndScan = async () => {
  const before = downloads.length;
  const btn = page.getByRole("button", { name: "Export PNG" });
  const box = await btn.boundingBox();
  // Travel like a hand does: onto the button, not a teleport that skips hover.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(120);
  await btn.click();
  const deadline = Date.now() + 15000;
  while (downloads.length < before + 1 && Date.now() < deadline) await page.waitForTimeout(100);
  return bluePixels(downloads[before]);
};

await applySetup();
await select(["a"]);
await hoverB();
check("hovering an unselected layer paints the preview", (await hoverState()).painted, true);
// The exporter strips chrome by this marker; an unmarked group is the one thing
// it cannot see, which is the whole bug.
check("the preview group carries the overlay marker", (await hoverState()).marked, "true");

await applySetup();
await select(["a"]);
await hoverB();
await page.mouse.move(700, 900);
await page.waitForTimeout(150);
check("leaving the canvas takes the preview down", await hoverState(), { painted: false, marked: null });

await applySetup();
await select(["a"]);
await hoverB();
const blue = await exportAndScan();
check("the export carries no selection chrome", blue, 0);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
