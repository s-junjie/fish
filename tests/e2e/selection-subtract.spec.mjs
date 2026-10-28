import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// Option is the "take this OUT of the selection" key: Option+click drops one layer,
// Option+marquee drops everything the box encloses. Both had to be deferred to the
// pointer-up, because Option+DRAG is a duplicate and Shift+DRAG is an axis lock —
// a removal applied on pointerdown would have taken the layer out of the box the
// drag needs it in.
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

const seed = () => page.evaluate(() => {
  const b = window.__FISH_BRIDGE__;
  const base = b.getDoc();
  const rect = (id, x, y, color) => ({
    id,
    type: "rect",
    name: id,
    x,
    y,
    width: 100,
    height: 100,
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

/**
 * A point ON a layer, as screen coordinates.
 *
 * `fx`/`fy` are fractions of the box, and the probe uses a quarter rather than the
 * centre on purpose: an evenly spaced selection wears the smart-selection reorder
 * dots at every element's centre, and a press there lands on a dot rather than on
 * the layer. That is correct behaviour — the dot is the control under the pointer —
 * and it means a click test has to aim somewhere else.
 */
const pointOn = async (id, fx = 0.25, fy = 0.5) => {
  const b = await rectOf(id);
  return { x: b.left + (b.right - b.left) * fx, y: b.top + (b.bottom - b.top) * fy };
};

/** Screen rect of a layer's painted shape — the truth, whatever the pan and zoom. */
const rectOf = (id) =>
  page.evaluate((elId) => {
    const g = document.querySelector(`[data-element-id="${elId}"]`);
    const shape = [...g.querySelectorAll("path, rect, ellipse, polygon")].find((n) => n.closest("[data-element-id]") === g);
    const r = shape.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);

/** Drag a marquee across the world band the given layers occupy, plus slack. */
const marquee = async (ids, opts = {}) => {
  const boxes = [];
  for (const id of ids) boxes.push(await rectOf(id));
  const left = Math.min(...boxes.map((b) => b.left)) - 30;
  const top = Math.min(...boxes.map((b) => b.top)) - 30;
  const right = Math.max(...boxes.map((b) => b.right)) + 30;
  const bottom = Math.max(...boxes.map((b) => b.bottom)) + 30;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(right, bottom, { steps: 10 });
  await page.mouse.up();
  await settle();
};

// --------------------------------------------------------------- Option + click
await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["a", "b", "c"]));
await settle();
check("three are selected to begin with", JSON.stringify(await selected()) === JSON.stringify(["a", "b", "c"]));

{
  const p = await pointOn("b");
  await page.keyboard.down("Alt");
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await settle();
  check("Option+click drops the layer from the selection", JSON.stringify(await selected()) === JSON.stringify(["a", "c"]), JSON.stringify(await selected()));
}

// A press on a layer that is NOT selected must not subtract it into the set as a
// no-op — it selects, which is what a plain click does.
{
  const p = await pointOn("e");
  await page.keyboard.down("Alt");
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await settle();
  check("Option+click on an unselected layer still selects it", JSON.stringify(await selected()) === JSON.stringify(["e"]), JSON.stringify(await selected()));
}

// ------------------------------------------------- Option + click must not drag
{
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["a", "b", "c"]));
  await settle();
  const p = await pointOn("a");
  await page.keyboard.down("Alt");
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 60, p.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await settle();
  // The duplicate gesture re-points the selection at the copies, so "nothing was
  // removed" is a statement about the COUNT, not about which ids survived.
  const ids = await selected();
  check("Option+DRAG removes nothing — a drag is not a click", ids.length === 3, JSON.stringify(ids));
  const minted = await page.evaluate(() => {
    const d = window.__FISH_BRIDGE__.getDoc();
    const pageEls = (d.pages.find((p) => p.id === d.activePageId) || d).children;
    return pageEls.length;
  });
  check("and it is still the duplicate gesture", minted > 6, `${minted} layers`);
  // The drag minted copies; re-seed so the marquee checks count only a..f.
  await seed();
  await settle();
}

// ------------------------------------------------------------ Option + marquee
{
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["a", "b", "c", "d", "e", "f"]));
  await settle();
  await page.keyboard.down("Alt");
  await marquee(["a", "b", "c"]);
  await page.keyboard.up("Alt");
  check("Option+marquee subtracts the enclosed layers", JSON.stringify(await selected()) === JSON.stringify(["d", "e", "f"]), JSON.stringify(await selected()));
}

// ------------------------------------------------------------ plain marquee
{
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["a", "c"]));
  await settle();
  await marquee(["a", "b", "c"]);
  check("a plain marquee still replaces", JSON.stringify(await selected()) === JSON.stringify(["a", "b", "c"]), JSON.stringify(await selected()));
}

// ------------------------------------------------------------ shift + marquee
// Shift was the one combination that did nothing different: the press skipped the
// clear and the release still replaced, so a box drawn with Shift behaved exactly
// like a box drawn without it.
{
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["a", "c"]));
  await settle();
  await page.keyboard.down("Shift");
  await marquee(["a", "b", "c"]);
  await page.keyboard.up("Shift");
  check("Shift+marquee adds what the box encloses", JSON.stringify(await selected()) === JSON.stringify(["a", "b", "c"]), JSON.stringify(await selected()));
}

{
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["a", "c"]));
  await settle();
  await page.keyboard.down("Shift");
  await marquee(["d", "e", "f"]);
  await page.keyboard.up("Shift");
  check("Shift+marquee leaves the rest of the selection alone", JSON.stringify(await selected()) === JSON.stringify(["a", "c", "d", "e", "f"]), JSON.stringify(await selected()));
}

// ------------------------------------------- the selection survives the drag
// Clearing under a modifier made the layers being added to, or subtracted from,
// blink out for the whole gesture: the user was subtracting from a selection they
// could not see.
{
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["a", "c"]));
  await settle();
  // Only a and b inside the box, so `c` is what survives the subtraction.
  const boxes = [];
  for (const id of ["a", "b"]) boxes.push(await rectOf(id));
  const left = Math.min(...boxes.map((b) => b.left)) - 30;
  const top = Math.min(...boxes.map((b) => b.top)) - 30;
  const right = Math.max(...boxes.map((b) => b.right)) + 30;
  const bottom = Math.max(...boxes.map((b) => b.bottom)) + 30;

  await page.keyboard.down("Alt");
  await page.mouse.move(left, top);
  await page.mouse.down();
  await settle();
  const midway = await selected();
  check("Option+marquee keeps the selection it is subtracting from", JSON.stringify(midway) === JSON.stringify(["a", "c"]), JSON.stringify(midway));
  await page.mouse.move(right, bottom, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await settle();
  check("and the result is still the subtraction", JSON.stringify(await selected()) === JSON.stringify(["c"]), JSON.stringify(await selected()));
}

{
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElements(["a", "c"]));
  await settle();
  const boxes = [];
  for (const id of ["d", "e", "f"]) boxes.push(await rectOf(id));
  const left = Math.min(...boxes.map((b) => b.left)) - 30;
  const top = Math.min(...boxes.map((b) => b.top)) - 30;
  const right = Math.max(...boxes.map((b) => b.right)) + 30;
  const bottom = Math.max(...boxes.map((b) => b.bottom)) + 30;
  await page.keyboard.down("Shift");
  await page.mouse.move(left, top);
  await page.mouse.down();
  await settle();
  const midway = await selected();
  check("Shift+marquee keeps the selection it is adding to", JSON.stringify(midway) === JSON.stringify(["a", "c"]), JSON.stringify(midway));
  await page.mouse.move(right, bottom, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await settle();
  check("and the result is still the addition", JSON.stringify(await selected()) === JSON.stringify(["a", "c", "d", "e", "f"]), JSON.stringify(await selected()));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${r.detail ?? ""}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);