import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// The Local Font Access prompt appears wherever `queryLocalFonts()` is first
// called, so the number of calls IS the user-visible behaviour. Two callers that
// each cached their own answer meant two prompts: one when a text layer was
// created and selected, a second when its font was changed — neither of them
// asked for, and the grant given to the first did not answer the second.
//
// Counting calls also sidesteps the part of this that cannot be asserted in
// headless: whether Chromium would have shown a prompt or silently refused. The
// stub refuses, so what is measured is the app's discipline about asking, not the
// browser's answer.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.addInitScript(() => {
  const native = typeof window.queryLocalFonts === "function" ? window.queryLocalFonts : null;
  window.__FONT_READS__ = 0;
  window.queryLocalFonts = function () {
    window.__FONT_READS__++;
    // A refusal, not an empty list: what a blocked prompt produces, and the case
    // that must still be cached rather than re-asked.
    if (!native) return Promise.reject(new DOMException("denied", "NotAllowedError"));
    return native.call(window);
  };
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const reads = () => page.evaluate(() => window.__FONT_READS__);
const settle = () =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

check("the font list is not read just for loading the editor", (await reads()) === 0, `${await reads()} reads`);

await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements([
      {
        id: "T1",
        type: "text",
        name: "T1",
        x: 300,
        y: 300,
        width: 320,
        height: 40,
        content: "Font list",
        style: { fontFamily: "Inter, sans-serif", fontSize: 28, color: "#000000" }
      }
    ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
});
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("T1"));
await page.waitForSelector('[data-typography-section="true"]');
await settle();

check("creating and selecting a text layer asks for nothing", (await reads()) === 0, `${await reads()} reads`);

// The field is mounted for a selected text layer, so its appearance is not the
// signal either — the LIST is what was requested, and it is only on screen when
// the user asked to see it.
await page.click('[data-font-trigger="1"]');
await page.waitForSelector('[data-font-panel="1"]');
check("opening the font list is what reads it, exactly once", (await reads()) === 1, `${await reads()} reads`);
await page.waitForFunction(
  () => !document.querySelector('[data-font-panel="1"] .animate-spin'),
  undefined,
  { timeout: 5000 }
);

// The refusal is an answer too: reopening the list must reuse it, because the
// platform will not prompt a second time for a decision already taken.
await page.keyboard.press("Escape");
await settle();
await page.click('[data-font-trigger="1"]');
await page.waitForSelector('[data-font-panel="1"]');
await page.waitForFunction(
  () => !document.querySelector('[data-font-panel="1"] .animate-spin'),
  undefined,
  { timeout: 5000 }
);
check("reopening the list does not ask again", (await reads()) === 1, `${await reads()} reads`);

// Outlining text needs the font BINARY, which is the other half of the same
// enumeration. It runs after the list was already read, so it must add nothing.
await page.keyboard.press("Escape");
await settle();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("T1"));
await settle();
const p = await page.evaluate(() => {
  const svg = document.querySelector("svg.pointer-events-auto");
  const box = svg.parentElement.getBoundingClientRect();
  const stage = document.querySelector("[data-stage-transform]");
  const raw =
    (stage && stage.getAttribute("transform")) ||
    getComputedStyle(stage ? stage.ownerSVGElement : svg).transform;
  const m =
    /translate\((-?[\d.]+), (-?[\d.]+)\) scale\(([\d.]+)\)/.exec(raw) ||
    /matrix\(([\d.eE+-]+), 0, 0, ([\d.eE+-]+), ([\d.eE+-]+), ([\d.eE+-]+)\)/.exec(raw);
  if (!m) return null;
  const [panX, panY, zoom] = m.length === 4
    ? [m[1], m[2], m[3]]
    : [m[3], m[4], m[1]];
  return { x: box.left + parseFloat(panX) + 400 * parseFloat(zoom), y: box.top + parseFloat(panY) + 320 * parseFloat(zoom) };
});
check("the canvas transform is readable, so the outline row can be reached", p !== null, JSON.stringify(p));
if (p) {
  await page.mouse.click(p.x, p.y, { button: "right" });
  await settle();
  const row = page.locator('[data-context-item="outlineText"]');
  check("a text layer offers Outline Text", (await row.count()) === 1);
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(600);
  }
}
check("outlining reuses the one read instead of asking again", (await reads()) === 1, `${await reads()} reads`);
check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);