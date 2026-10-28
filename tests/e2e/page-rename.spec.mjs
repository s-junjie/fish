import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// A page row is a layer row in another list, so its rename has to be armed and
// finished exactly like a layer's: double-click opens the field, Enter and a
// click-away commit it, Escape discards it — and the field unmounts on its own
// exit, which is what once let a discarded draft commit itself on the way out.
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
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const pageNames = () => page.evaluate(() => window.__FISH_BRIDGE__.getDoc().pages.map((p) => p.name));
const field = (id) => page.locator(`[data-page-rename="${id}"]`);

// Two named pages, so a rename is observable on a page that is not the only one.
await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements([], { pages: [ { id: "p1", name: "Page 1", canvas: base.canvas, children: [] }, { id: "p2", name: "Page 2", canvas: base.canvas, children: [] } ], activePageId: "p1" });
});
await settle();

check("the pages band draws a row per page", await page.locator("[data-page-id]").count(), 2);

// -------------------------------------------------- double-click opens the field
await page.locator('[data-page-id="p2"]').dblclick();
await settle();
check("double-clicking a page row opens its rename field", await field("p2").count(), 1);

await field("p2").fill("Renamed By Double Click");
await page.keyboard.press("Enter");
await settle();
check("Enter commits the new page name", await pageNames(), ["Page 1", "Renamed By Double Click"]);
check("and the field is gone", await page.locator("[data-page-id] input").count(), 0);

// ---------------------------------------------------------- clicking away commits
await page.locator('[data-page-id="p2"]').dblclick();
await settle();
await field("p2").fill("Clicked Away");
await page.locator('[data-testid="panel-tab-layers"]').click();
await settle();
check("clicking away commits the draft", await pageNames(), ["Page 1", "Clicked Away"]);

// ------------------------------------------------------------------- Escape discards
await page.locator('[data-page-id="p2"]').dblclick();
await settle();
await field("p2").fill("Throwaway");
await page.keyboard.press("Escape");
await settle();
check("Escape abandons the draft", await pageNames(), ["Page 1", "Clicked Away"]);
check("and closes the field", await page.locator("[data-page-id] input").count(), 0);

// ----------------------------------------------------------- the menu opens it too
await page.locator('[data-page-id="p1"]').click({ button: "right" });
await settle();
const menuIds = await page.evaluate(() =>
  [...document.querySelectorAll("[data-context-item]")].map((n) => n.getAttribute("data-context-item"))
);
check("right-clicking a page opens the page menu", await page.locator("[data-context-menu]").count(), 1);
check("which offers Rename page", menuIds.includes("rename-page"), true);

await page.click('[data-context-item="rename-page"]');
await settle();
check("choosing Rename opens the field on that page", await field("p1").count(), 1);
await field("p1").fill("Home");
await page.keyboard.press("Enter");
await settle();
check("and the menu-driven rename commits", await pageNames(), ["Home", "Clicked Away"]);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
