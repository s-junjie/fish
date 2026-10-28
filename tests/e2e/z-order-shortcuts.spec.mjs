import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

/**
 * `[` and `]` are matched on `e.code`, not `e.key`.
 *
 * The failure this covers is invisible to `page.keyboard.press`, which always
 * reports a clean `key: "["`. A layout or an IME rewrites the character on the
 * way to the page — `Shift+[` is `{` on any layout, and a CJK IME composes a
 * bare bracket into something else while a dead key raises `isComposing` and
 * drops the event at the top of the handler. `Cmd+[` survives all of that,
 * because the modifier short-circuits the IME, which is why the bug presents as
 * "the plain key does nothing and the Cmd one works".
 */
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
const rect = (id, y) => ({ id, type: "rect", name: id, x: 0, y, width: 100, height: 60, fills: [{ type: "solid", color: "#3B82F6" }] });

const fresh = async () => {
  await page.evaluate((els) => {
    const b = window.__FISH_BRIDGE__;
    b.setElements(els, { ...b.getDoc(), canvas: { ...b.getDoc().canvas, width: 4000, height: 3000 } });
  }, [rect("a", 0), rect("b", 100), rect("c", 200), rect("d", 300), rect("e", 400)]);
  await settle();
  // The MIDDLE of five, so all four shortcuts do four different things: a layer
  // one place from either end has a one-step move that collides with the jump.
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("c"));
  await settle();
};
const order = () => page.evaluate(() => window.__FISH_BRIDGE__.getElements().map((e) => e.id));

/** Dispatch a keydown carrying a rewritten `key`, the way a layout or IME would. */
const pressWithKey = (code, key, init = {}) =>
  page.evaluate(
    ({ code, key, init }) => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true, ...init })
      );
    },
    { code, key, init }
  );

// --- the plain keys, through the real keyboard ---------------------------
await fresh();
check("root order before", await order(), ["a", "b", "c", "d", "e"]);
await page.keyboard.press("]");
await settle();
check("bare ] sends the layer to the front", await order(), ["a", "b", "d", "e", "c"]);

await fresh();
await page.keyboard.press("[");
await settle();
check("bare [ sends the layer to the back", await order(), ["c", "a", "b", "d", "e"]);

await fresh();
await page.keyboard.press("Meta+]");
await settle();
check("Cmd+] brings the layer forward one step", await order(), ["a", "b", "d", "c", "e"]);

await fresh();
await page.keyboard.press("Meta+[");
await settle();
check("Cmd+[ sends the layer backward one step", await order(), ["a", "c", "b", "d", "e"]);

// --- the same keys, arriving as a rewritten character --------------------
await fresh();
await pressWithKey("BracketRight", "{");
await settle();
check("BracketRight reported as '{' still reaches the front shortcut", await order(), ["a", "b", "d", "e", "c"]);

await fresh();
await pressWithKey("BracketLeft", "{");
await settle();
check("BracketLeft reported as '{' still reaches the back shortcut", await order(), ["c", "a", "b", "d", "e"]);

// --- and the guard that must keep winning over all of it ----------------
await fresh();
await pressWithKey("BracketRight", "]", { keyCode: 229 });
await settle();
check("an IME composition is still refused", await order(), ["a", "b", "c", "d", "e"]);

check("no page errors", errors, []);

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "✔" : "✖"} ${r.name}`);
  if (!r.ok) console.log(`    expected ${JSON.stringify(r.expected)}, got ${JSON.stringify(r.actual)}`);
}
await browser.close();
console.log(failed === 0 ? "\nAll checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
