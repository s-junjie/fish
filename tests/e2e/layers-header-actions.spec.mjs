import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// The LAYERS band carries two actions beside the collapse-all control: select the
// current layer's parent, and bring the current row back into view after the list
// has been scrolled away. Both act on the live selection, so an empty or root-level
// selection has to leave them honest (disabled) rather than silently doing nothing.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) =>
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
const settle = () =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

await page.evaluate(() => {
  const rows = [];
  for (let i = 0; i < 80; i++) {
    rows.push({
      id: `r${i}`,
      type: "rect",
      name: `Row ${i}`,
      x: 100,
      y: 100 + i * 10,
      width: 100,
      height: 8
    });
  }
  window.__FISH_BRIDGE__.setElements([
    {
      id: "parent",
      type: "frame",
      name: "Parent frame",
      x: 0,
      y: 0,
      width: 600,
      height: 500,
      children: [{ id: "child", type: "rect", name: "Child", x: 20, y: 20, width: 40, height: 30 }]
    },
    ...rows
  ]);
});
await settle();

const buttons = () =>
  page.evaluate(() => ({
    parent: document.querySelector("[data-layer-select-parent]")?.disabled ?? null
  }));

await page.evaluate(() => window.__FISH_BRIDGE__.selectElements([]));
await settle();
check("with nothing selected, select-parent header action is disabled", await buttons(), { parent: true });

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("r0"));
await settle();
check("a root-level layer has no parent action", await buttons(), { parent: true });

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("child"));
await settle();
check("a nested layer enables the parent action", await buttons(), { parent: false });

await page.click("[data-layer-select-parent]");
await settle();
check("the parent action selects the parent layer", await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds()), [
  "parent"
]);

const rowCount = (id) => page.locator(`[data-layer-row="${id}"]`).count();
const collapseParent = () => page.locator('[data-layer-row="parent"] [title="Collapse"]').click();

await collapseParent();
await settle();
check("collapsing the selected layer hides its child row", await rowCount("child"), 0);

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("child"));
await settle();
check("selecting a hidden child auto-expands ancestor path", await rowCount("child"), 1);

const scroller = await page.evaluate(() => {
  const panel = document.querySelector('[data-ui-panel="left"]');
  for (const el of panel ? panel.querySelectorAll("*") : []) {
    const style = getComputedStyle(el);
    if (style.overflowY === "auto" && el.scrollHeight > el.clientHeight) return true;
  }
  return false;
});
check("the list can overflow for scrolling", scroller, true);

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("r0"));
await settle();
const scrolledToSelection = await page.evaluate(() => {
  const panel = document.querySelector('[data-ui-panel="left"]');
  for (const el of panel.querySelectorAll("*")) {
    const style = getComputedStyle(el);
    if (style.overflowY === "auto" && el.scrollHeight > el.clientHeight) {
      window.__layerScroller = el;
      return el.scrollTop;
    }
  }
  return 0;
});
check("selecting the far row reveals it", scrolledToSelection > 0, true);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(
    `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`
  );
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
