import { chromium } from "playwright";
import { pathToFileURL } from "url";
import fs from "node:fs";
import path from "path";

// Export writes one file per selected layer.
//
// A selection is a set of layers, not a region: cropping two frames into one
// image produced a file the size of the gap between them, with each frame a
// corner of it. The two frames here are deliberately different sizes, so a
// merged export cannot pass by accident — every dimension below is one frame's
// own, and the union of the two matches neither.

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
page.on("download", (d) => {
  const file = { name: d.suggestedFilename(), saved: d.path() };
  downloads.push(file);
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const applySetup = () =>
  page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    const rect = (id, x, y, w, h, color) => ({
      id, type: "rect", name: id, x, y, width: w, height: h,
      fills: [{ type: "solid", color }]
    });
    bridge.setElements(
      [
        {
          id: "hero", type: "frame", name: "Hero", x: 100, y: 100, width: 200, height: 120,
          fills: [{ type: "solid", color: "#1B72FF" }],
          children: [rect("heroLabel", 10, 10, 40, 20, "#FFFFFF")]
        },
        {
          id: "footer", type: "frame", name: "Footer", x: 700, y: 400, width: 300, height: 80,
          fills: [{ type: "solid", color: "#FF4C4C" }]
        }
      ],
      { canvas: { ...base.canvas, width: 2000, height: 1400 } }
    );
  });

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const select = async (ids) => {
  await page.evaluate((list) => window.__FISH_BRIDGE__.selectElements(list), ids);
  await settle();
};
const exportButton = () => page.getByRole("button", { name: "Export PNG" });
// The heading row carries the section title AND its trailing figure; the button
// itself holds only the title, so the parent is what has to be read.
const headerText = () =>
  page.evaluate(
    () => document.querySelector('[data-inspector-header="export"]')?.parentElement?.textContent ?? ""
  );
const exportNow = async (expected) => {
  const before = downloads.length;
  await exportButton().click();
  const deadline = Date.now() + 15000;
  while (downloads.length < before + expected && Date.now() < deadline) await page.waitForTimeout(100);
  // One more beat for a surplus file to show up, so "exactly N" means something.
  await page.waitForTimeout(400);
  const batch = downloads.slice(before);
  const files = [];
  for (const d of batch) {
    const file = await d.saved;
    const bytes = fs.readFileSync(file);
    files.push({
      name: d.name,
      // IHDR: width at byte 16, height at 20 of a PNG.
      size: [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
    });
  }
  return files;
};

await applySetup();
await select(["hero", "footer"]);
check("the panel counts the files, not a merged size", (await headerText()).includes("2 files"), true);

const two = await exportNow(2);
check("a two-frame selection writes two files", two.length, 2);
check("each file is named after its own frame", two.map((f) => f.name).sort(), ["Footer.png", "Hero.png"]);
check("Hero exports at its own size", two.find((f) => f.name === "Hero.png")?.size, [200, 120]);
check("Footer exports at its own size", two.find((f) => f.name === "Footer.png")?.size, [300, 80]);
// The union of the two frames — 900x380 — is the shape the bug produced.
check(
  "no file is the size of the selection's union",
  two.some((f) => f.size[0] === 900 && f.size[1] === 380),
  false
);

// A layer selected together with the frame it lives in is one picture, not two.
await applySetup();
await select(["hero", "heroLabel"]);
const nested = await exportNow(1);
check("a frame and its own child export as one file", nested.length, 1);
check("and it is the frame's size", nested[0]?.size, [200, 120]);

// A single layer is still the plain one-file export it always was.
await applySetup();
await select(["footer"]);
const single = await exportNow(1);
check("one selected layer writes one file", single.map((f) => f.name), ["Footer.png"]);
check("at that layer's size", single[0]?.size, [300, 80]);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
