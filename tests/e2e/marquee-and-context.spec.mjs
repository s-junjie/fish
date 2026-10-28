import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// Two things a right-click and a subtractive box must not do, measured on the
// built shell because both are absences — nothing to click, only nothing to have
// broken.
//
//   1. A right press belongs to the context menu. It used to fall through to the
//      marquee branch, which clears the selection first: the comment above that
//      branch said a right press was excluded, and the exclusion was not in the
//      code.
//   2. The band wears the verb. Option turns the gesture into a removal, so the
//      band turns coral — and it does so MID-DRAG, because Option can go down
//      halfway through.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds().sort());
const seed = () =>
  page.evaluate(() => {
    const b = window.__FISH_BRIDGE__;
    const base = b.getDoc();
    const rect = (id, x, y, color) => ({
      id, type: "rect", name: id, x, y, width: 100, height: 100,
      fills: [{ type: "solid", color }]
    });
    b.setElements([
        rect("a", 60, 60, "#111111"),
        rect("b", 220, 60, "#222222"),
        rect("c", 380, 60, "#333333"),
        rect("d", 60, 400, "#444444"),
        rect("e", 220, 400, "#555555"),
        rect("f", 380, 400, "#666666")
      ], { canvas: { ...base.canvas, width: 1200, height: 800 } });
  });
await seed();
await settle();

const boxOf = (id) =>
  page.evaluate((elId) => {
    const g = document.querySelector(`[data-element-id="${elId}"]`);
    const shape = [...g.querySelectorAll("path, rect, ellipse, polygon")].find((n) => n.closest("[data-element-id]") === g);
    const r = shape.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);

// ------------------------------------------------------------------ right click
await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["a", "b", "c"]));
await settle();
{
  const p = await boxOf("b");
  await page.mouse.click(p.x, p.y, { button: "right" });
  await settle();
  check("right-click on a selected layer keeps the selection", JSON.stringify(await selected()) === JSON.stringify(["a", "b", "c"]), JSON.stringify(await selected()));
  check("and opens the menu", await page.evaluate(() => !!document.querySelector('[role="menu"]')));
  await page.keyboard.press("Escape");
  await settle();
  check("which closes again", (await page.evaluate(() => !!document.querySelector('[role="menu"]'))) === false);
}
{
  // Nothing is selected, and a right press on empty canvas must not manufacture a
  // selection out of whatever a zero-width band happens to contain.
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElements([]));
  await settle();
  const host = await page.evaluate(() => {
    const r = document.querySelector("svg.pointer-events-auto").parentElement.getBoundingClientRect();
    return { x: r.x + 20, y: r.y + r.height - 20 };
  });
  await page.mouse.click(host.x, host.y, { button: "right" });
  await settle();
  check("right-click on empty canvas selects nothing", JSON.stringify(await selected()) === JSON.stringify([]), JSON.stringify(await selected()));
}

// ------------------------------------------------------------ the band's colour
const bandStroke = () =>
  page.evaluate(() => {
    const r = document.querySelector('[data-selection-overlay] rect[stroke-dasharray="3 3"]');
    return r ? { stroke: r.getAttribute("stroke"), subtract: r.getAttribute("data-marquee-subtract") } : null;
  });

{
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["a", "b", "c", "d", "e", "f"]));
  await settle();
  const top = await boxOf("a");
  const bottom = await boxOf("d");

  await page.mouse.move(top.left - 30, top.top - 30);
  await page.mouse.down();
  await page.mouse.move(top.right + 30, bottom.bottom + 30, { steps: 6 });
  await settle();
  const plain = await bandStroke();
  check("a plain band is the selection blue", !!plain && plain.stroke === "#1B72FF", JSON.stringify(plain));
  await page.mouse.up();
  await settle();

  await page.mouse.move(top.left - 30, top.top - 30);
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(top.right + 30, top.bottom + 60, { steps: 6 });
  await settle();
  const alt = await bandStroke();
  check("an Option band is the geometry coral", !!alt && alt.stroke === "#FF5353", JSON.stringify(alt));
  check("and is tagged as subtractive", !!alt && alt.subtract === "true", JSON.stringify(alt));

  // The band has to change its mind while the drag is live, not only at the press.
  await page.keyboard.up("Alt");
  await page.mouse.move(top.right + 40, top.bottom + 60, { steps: 4 });
  await settle();
  const released = await bandStroke();
  check("releasing Option mid-drag repaints it", !!released && released.stroke === "#1B72FF", JSON.stringify(released));
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await settle();
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${r.detail ?? ""}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);