import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// Presentation mode, as a viewer: it must show one artboard at a time, fit it to
// the window, and keep its hands off the document — the arrow keys that walk the
// deck are the same keys that nudge elements on the canvas, and a deck that
// nudges is a deck nobody will use twice.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const VIEW = { width: 1600, height: 1000 };
const SLIDE = { width: 400, height: 300 };

// A two-row deck whose stored order is neither reading order nor the layer
// panel's. A single row of evenly spaced frames cannot tell the three orderings
// apart — they all agree — so the fixture has to be laid out in two rows and
// shuffled in the array for the order assertions to mean anything.
const FRAMES = [
  { key: "b-top-right", x: 500, y: 0 },
  { key: "d-bottom-left", x: 0, y: 400 },
  { key: "a-top-left", x: 0, y: 0 },
  { key: "c-bottom-right", x: 500, y: 400 }
].map(({ key, x, y }, i) => ({
  id: key,
  type: "frame",
  name: `Slide ${key[0].toUpperCase()}`,
  x,
  y,
  width: SLIDE.width,
  height: SLIDE.height,
  fills: [{ type: "solid", color: ["#3E63DD", "#F76B15", "#12A594", "#B547D6"][i] }],
  children: [
    { id: `m${i}`, type: "rect", name: "mark", x: 20, y: 20, width: 40, height: 40, fills: [{ type: "solid", color: "#FFFFFF" }] }
  ]
}));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEW });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
await page.evaluate((elements) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 3000, height: 1400 } });
}, FRAMES);
await page.waitForTimeout(400);

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const idle = async () => {
  await settle();
  await page.waitForTimeout(150);
  await settle();
};

const counter = () =>
  page.evaluate(() => {
    const n = document.querySelector("[data-present-counter]");
    return n ? n.textContent.trim() : null;
  });

const overlayVisible = () => page.evaluate(() => !!document.querySelector("[data-present-overlay]"));

// Scoped to the station the overlay mounts: the editor's own canvas is still in
// the document behind it, painting the same ids, so an unscoped query measures
// the canvas and reports the fit wrong.
const boxOf = (id) =>
  page.evaluate((elId) => {
    const stage = document.querySelector("[data-present-stage]");
    const n = stage?.querySelector(`[data-element-id="${CSS.escape(elId)}"]`);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  }, id);

const geometryOf = (id) =>
  page.evaluate((elId) => window.__fish.measure(elId), id);

// ---------------------------------------------------------------- entry & fit
check("the deck is closed to begin with", (await overlayVisible()) === false);

await page.click("[data-present-button]");
await idle();

check("the overlay opens", await overlayVisible());
check("the counter starts on the first slide", (await counter()) === "1 / 4", `got ${await counter()}`);

// The deck runs in READING ORDER: rows top to bottom, left to right within a
// row. The fixture's stored order is `b, d, a, c`, so the array order and the
// panel's reversed order each put a different slide first — this is the
// assertion that tells the three apart.
check("the first slide is the top-left artboard, whatever order it was stored in", (await boxOf("a-top-left")) !== null, `box: ${JSON.stringify(await boxOf("a-top-left"))}`);
check("neither the array's first nor the panel's first is on screen", (await boxOf("b-top-right")) === null, `b present: ${(await boxOf("b-top-right")) !== null}`);

// The default scale mode is `responsive`: it fits a slide too big for the window
// DOWN and never scales a small one up, so a 400x300 slide in a 1600x1000 window
// is 1:1. This assertion used to expect `fit`'s 1333x1000 and has been failing
// since the default changed — every navigation check below it still ran, but the
// fit itself was no longer guarded by anything.
const first = await boxOf("a-top-left");
check(
  "the default mode does not scale a small slide up",
  first && Math.abs(first.width - SLIDE.width) < 2 && Math.abs(first.height - SLIDE.height) < 2,
  `expected ${SLIDE.width}x${SLIDE.height}, got ${first ? `${first.width}x${first.height}` : "no box"}`
);

// `fit` is the mode that does fill the window, on the tighter axis: 1000/300.
// The HUD auto-hides, and its trigger is inert while hidden, so the pointer has
// to be over the overlay before it can be clicked.
const fitZoom = Math.min(VIEW.width / SLIDE.width, VIEW.height / SLIDE.height);
await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
await page.click("[data-testid='present-scale-trigger']");
await page.getByRole("button", { name: "Fit width and height" }).click();
await idle();
const fitted = await boxOf("a-top-left");
check(
  "and `fit` scales it to the tighter axis",
  fitted &&
    Math.abs(fitted.width - SLIDE.width * fitZoom) < 2 &&
    Math.abs(fitted.height - SLIDE.height * fitZoom) < 2,
  `expected ${Math.round(SLIDE.width * fitZoom)}x${Math.round(SLIDE.height * fitZoom)}, got ${fitted ? `${fitted.width}x${fitted.height}` : "no box"}`
);
await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
await page.click("[data-testid='present-scale-trigger']");
await page.getByRole("button", { name: "Responsive" }).click();
await idle();
check("only the current artboard is on screen", (await boxOf("c-bottom-right")) === null, `c present: ${(await boxOf("c-bottom-right")) !== null}`);

// The name label the editor draws above every frame is chrome an audience must
// not see — and it sits outside the frame, so leaving it on measures into the fit.
const titles = await page.evaluate(() => document.querySelectorAll("[data-present-stage] [data-frame-title]").length);
check("the deck carries no editor chrome", titles === 0, `${titles} frame titles painted`);

// ------------------------------------------------------------------ moving on
await page.keyboard.press("ArrowRight");
await idle();
check("ArrowRight advances", (await counter()) === "2 / 4", `got ${await counter()}`);

await page.keyboard.press("ArrowLeft");
await idle();
check("ArrowLeft goes back", (await counter()) === "1 / 4", `got ${await counter()}`);

await page.keyboard.press("Space");
await idle();
check("Space advances", (await counter()) === "2 / 4", `got ${await counter()}`);

await page.keyboard.press("End");
await idle();
check("End jumps to the last slide", (await counter()) === "4 / 4", `got ${await counter()}`);

await page.keyboard.press("ArrowRight");
await idle();
check("the deck stops at the last slide", (await counter()) === "4 / 4", `got ${await counter()}`);

await page.keyboard.press("Home");
await idle();
check("Home jumps to the first slide", (await counter()) === "1 / 4", `got ${await counter()}`);

await page.mouse.click(VIEW.width / 2, VIEW.height / 2);
await idle();
check("clicking advances", (await counter()) === "2 / 4", `got ${await counter()}`);

await page.keyboard.press("r");
await idle();
check("R restarts the deck", (await counter()) === "1 / 4", `got ${await counter()}`);

// ------------------------------------------------------------------- the wheel
// One gesture, one slide. A trackpad flick is not one event — two fingers emit
// dozens inside a few hundred ms — and a per-event step sent a single flick to
// the end of the deck. Dispatched from inside the page so the burst lands in one
// frame, the way a real flick does; twelve awaited CDP round trips would pace
// themselves out of any cooldown.
const wheelBurst = async (deltaY) => {
  await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
  await page.evaluate((dy) => {
    const el = document.querySelector("[data-present-overlay]");
    for (let i = 0; i < 12; i++) el.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, bubbles: true, cancelable: true }));
  }, deltaY);
};
await wheelBurst(120);
await idle();
check("one wheel gesture advances one slide", (await counter()) === "2 / 4", `12 wheel events -> ${await counter()}`);
await page.waitForTimeout(450);
await wheelBurst(-120);
await idle();
check("and one gesture back is one slide", (await counter()) === "1 / 4", `got ${await counter()}`);

await page.keyboard.press("End");
await idle();
check("the wheel did not skip us past the end", (await counter()) === "4 / 4", `got ${await counter()}`);
await page.keyboard.press("Home");
await idle();

// -------------------------------------------------------- the deck is read-only
// Selected first, so a key that reached the editor would have something to move.
// A selection behind the overlay is the whole hazard: it is invisible, and
// ⌥Arrow is a navigation reflex on macOS.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("b-top-right"));
await page.keyboard.press("Home");
await idle();
const before = await geometryOf("b-top-right");
check("the artboard behind the overlay is selected, so a stray key would have a target", (await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds().join(","))) === "b-top-right");

// Modified keys are the case a "no ⌘, so let ⌘ through" rule misses: the
// arrow-nudge branch reads `e.key` and never looks at the modifiers.
await page.keyboard.press("Alt+ArrowRight");
await page.keyboard.press("Alt+ArrowLeft");
await page.keyboard.press("Meta+z");
await page.keyboard.press("Meta+d");
await page.keyboard.press("Backspace");
await page.keyboard.press("Delete");
await idle();
const afterModified = await geometryOf("b-top-right");
check(
  "a MODIFIED arrow key does not nudge the artboard behind the overlay",
  before && afterModified && before.x === afterModified.x && before.y === afterModified.y,
  `${JSON.stringify(before)} -> ${JSON.stringify(afterModified)}`
);
check("and the deck did not advance on it either", (await counter()) === "1 / 4", `got ${await counter()}`);

// ⌘R is the one that used to be unrecoverable: it opened a rename input BEHIND
// the overlay, and the presentation branch sits above the `isInput` bail, so
// every keystroke meant for that field was swallowed in the capture phase. The
// user typed a name into the void and found the draft after closing the deck.
await page.keyboard.press("Meta+r");
await idle();
const renameOpen = await page.evaluate(() => !!document.querySelector("[data-layer-rename]"));
check("⌘R opened no rename field behind the overlay", renameOpen === false, `rename field present: ${renameOpen}`);

// Typing must still reach a text input even while the deck is up (§8), and must
// not land in a field the user cannot see.
await page.keyboard.type("hello");
await idle();
const focusReport = await page.evaluate(() => {
  const a = document.activeElement;
  return { tag: a ? a.tagName : "none", value: a && "value" in a ? String(a.value) : "" };
});
check("typing while presenting does not vanish into a hidden field", focusReport.tag !== "INPUT", `active: ${focusReport.tag}="${focusReport.value}"`);

await page.keyboard.press("Escape");
await idle();

check("Escape closes the overlay", (await overlayVisible()) === false);

// The other half of the chrome switch: it is a property of the deck, not of the
// renderer, so the editor still labels its frames.
const editorTitles = await page.evaluate(() => document.querySelectorAll("[data-frame-title]").length);
check("the editor keeps its frame titles", editorTitles > 0, `${editorTitles} in the editor`);

const after = await geometryOf("b-top-right");
check(
  "the arrow keys moved the deck, not the artboard",
  before && after && before.x === after.x && before.y === after.y,
  `${JSON.stringify(before)} -> ${JSON.stringify(after)}`
);
check("Backspace deleted nothing", !!after, `b-top-right gone: ${!after}`);

// ------------------------------------------------- a slide is the canvas, exactly
// The overlay mounts the same `DocumentStage` the editor does, so anything the
// stage derives for the canvas it must derive for a slide. Text on a path is the
// test for that: the string is stored forwards and REVERSED at render time when
// the run sits on the inside of the shape, and it is reversed from a guide map
// that `<defs>` and the node renderer have to share. A host that mounts the
// stage without that map draws the run forwards — readable, plausible, and
// wrong — so the claim has to be made by comparing the two hosts' DOM.
await page.keyboard.press("Escape");
await idle();
await page.evaluate(() => {
  const b = window.__FISH_BRIDGE__;
  const doc = JSON.parse(JSON.stringify(b.getDoc()));
  const page = doc.pages.find((p) => p.id === doc.activePageId) || doc.pages[0];
  const ring = page.children.find((el) => el.id === "a-top-left");
  ring.children = [
    {
      id: "ring",
      type: "ellipse",
      name: "ring",
      x: 20,
      y: 20,
      width: 260,
      height: 200,
      fills: []
    },
    {
      id: "curved",
      type: "text",
      name: "curved",
      x: 0,
      y: 0,
      width: 100,
      height: 24,
      content: "GAUGE",
      style: { fontSize: 18, fontFamily: "Inter", fontWeight: 400, color: "#FFFFFF" },
      onPath: { pathId: "ring", side: "in", startOffset: 0 }
    }
  ];
  b.applyDoc(doc);
});
await idle();

// Both copies of the element are in the DOM while the deck is open, so each read
// has to say WHICH host it is asking.
const runIn = (host) =>
  page.evaluate((h) => {
    const all = [...document.querySelectorAll('[data-element-id="curved"] textPath')];
    const t = h === "slide" ? all.find((n) => n.closest("[data-present-stage]")) : all.find((n) => !n.closest("[data-present-stage]"));
    return t ? t.textContent : null;
  }, host);

const canvasRun = await runIn("canvas");
check("an inside-the-shape run is stored forwards and drawn reversed on the canvas", canvasRun === "EGUAG", `canvas drew ${JSON.stringify(canvasRun)}`);

await page.click("[data-present-button]");
await idle();
const slideRun = await runIn("slide");
check("and a slide draws the very same string", slideRun === canvasRun, `canvas ${JSON.stringify(canvasRun)} vs slide ${JSON.stringify(slideRun)}`);
await page.keyboard.press("Escape");
await idle();

// ------------------------------------------------------------ Cmd+Enter toggles
await page.keyboard.press("Meta+Enter");
await idle();
check("Cmd+Enter opens the deck", await overlayVisible());
await page.keyboard.press("Meta+Enter");
await idle();
check("Cmd+Enter closes it again", (await overlayVisible()) === false);

check("no console errors", errors.length === 0, errors.join("\n      "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
