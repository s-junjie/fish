import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// Text on path, measured in the real editor (Figma parity):
//
//   1. bbox write-back — the stored x/y/width/height of an on-path text converge
//      to the painted glyph run's getBBox(), even when seeded far off-canvas
//   2. selection box   — the overlay rect hugs the glyph box, not the stale box
//   3. start handle    — a blue diamond sits at the glyph run start, and dragging
//      it changes onPath.startOffset
//   4. editing         — double-click opens the on-canvas editor, typing updates
//      the document live, Enter commits
//   5. slide           — dragging the text body slides it along the path (offset
//      changes) instead of translating an invisible box
//
// Every screen coordinate is derived from the DOM.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const pageErrors = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const PATH_ID = "tp_path";
const TEXT_ID = "tp_text";

await page.evaluate(([pathId, textId]) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements([
      {
        id: pathId,
        type: "path",
        name: "Arc",
        x: 120,
        y: 200,
        width: 400,
        height: 220,
        d: "M 20 200 C 120 20, 300 20, 400 200",
        strokes: [{ color: "#888888", width: 2 }]
      },
      {
        id: textId,
        type: "text",
        name: "Text on Arc",
        // Deliberately stale and far away: the renderer must measure the real
        // glyph box and write it back.
        x: -8000,
        y: -8000,
        width: 10,
        height: 10,
        content: "Text on Path",
        fills: [{ type: "solid", color: "#FFFFFF" }],
        style: { fontSize: 24, fontFamily: "Inter, sans-serif", fontWeight: 400, color: "#FFFFFF" },
        onPath: { pathId, startOffset: 0 }
      }
    ], { canvas: { ...base.canvas, width: 1920, height: 1080 } });
}, [PATH_ID, TEXT_ID]);

await page.waitForSelector(`[data-element-id="${TEXT_ID}"] textPath`);
await page.waitForTimeout(400);

const readText = () =>
  page.evaluate((textId) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const el = doc.pages.find((p) => p.id === doc.activePageId).children.find((e) => e.id === textId);
    return JSON.parse(JSON.stringify(el));
  }, TEXT_ID);

// --- 1. bbox write-back ----------------------------------------------------
const converged = await page.waitForFunction((textId) => {
  const node = document.querySelector(`[data-element-id="${textId}"] text`);
  if (!node) return false;
  const b = node.getBBox();
  const doc = window.__FISH_BRIDGE__.getDoc();
  const el = doc.pages.find((p) => p.id === doc.activePageId).children.find((e) => e.id === textId);
  if (!el) return false;
  return (
    Math.abs(el.x - b.x) < 1 &&
    Math.abs(el.y - b.y) < 1 &&
    Math.abs(el.width - b.width) < 1 &&
    Math.abs(el.height - b.height) < 1
  );
}, TEXT_ID, { timeout: 5000 }).then(() => true).catch(() => false);
check("bbox write-back converges to painted glyph box", converged);

const stored = await readText();
check("write-back replaced the stale seed box", stored.x > -8000, JSON.stringify({ x: stored.x, y: stored.y, w: stored.width, h: stored.height }));

// --- 2. selection box hugs the glyph box -----------------------------------
await page.evaluate((textId) => window.__FISH_BRIDGE__.selectElement(textId), TEXT_ID);
await page.waitForTimeout(120);
const selVsGlyph = await page.evaluate((textId) => {
  const node = document.querySelector(`[data-element-id="${textId}"] text`);
  const b = node.getBoundingClientRect();
  // The single-selection overlay rect: stroke #1B72FF, outside element groups.
  const rects = [...document.querySelectorAll("rect")].filter(
    (r) => r.getAttribute("stroke") === "#1B72FF" && r.getAttribute("fill") === "none" && !r.closest("[data-element-id]")
  );
  const sel = rects.map((r) => r.getBoundingClientRect()).find(
    (r) => Math.abs(r.width - b.width) < b.width && Math.abs(r.x - b.x) < 50 && Math.abs(r.y - b.y) < 50
  );
  if (!sel) return null;
  return { dx: Math.abs(sel.x - b.x), dy: Math.abs(sel.y - b.y), dw: Math.abs(sel.width - b.width), dh: Math.abs(sel.height - b.height) };
}, TEXT_ID);
check("selection overlay rect hugs glyph box", selVsGlyph && selVsGlyph.dx < 3 && selVsGlyph.dy < 3 && selVsGlyph.dh < 6, JSON.stringify(selVsGlyph));

// --- 3. start-offset handle ------------------------------------------------
await page.waitForSelector('[data-offset-handle="true"]');
const handlePos = await page.evaluate((textId) => {
  const h = document.querySelector('[data-offset-handle="true"] rect');
  const hb = h.getBoundingClientRect();
  const textNode = document.querySelector(`[data-element-id="${textId}"] text`);
  // The handle marks where the run begins — the first glyph's origin, measured
  // in screen space via the node's own CTM (coordinate-free).
  const start = textNode.getStartPositionOfChar(0);
  const ctm = textNode.getScreenCTM();
  const sx = start.matrixTransform(ctm).x;
  const sy = start.matrixTransform(ctm).y;
  return { dx: hb.x + hb.width / 2 - sx, dy: hb.y + hb.height / 2 - sy };
}, TEXT_ID);
check(
  "start handle sits at the glyph run start",
  handlePos && Math.abs(handlePos.dx) < 6 && Math.abs(handlePos.dy) < 8,
  JSON.stringify(handlePos)
);

// Drag the handle along the path: startOffset must move off 0.
const before = (await readText()).onPath.startOffset;
const hb = await page.locator('[data-offset-handle="true"] rect').boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(hb.x + hb.width / 2 + i * 18, hb.y + hb.height / 2 + i * 6, { steps: 2 });
}
await page.mouse.up();
const afterHandleDrag = (await readText()).onPath.startOffset;
check("handle drag changes startOffset", afterHandleDrag !== before, `${before} -> ${afterHandleDrag}`);

// --- 4. editing -------------------------------------------------------------
// Re-select, then double-click the glyphs to open the on-canvas editor.
await page.evaluate((textId) => window.__FISH_BRIDGE__.selectElement(textId), TEXT_ID);
await page.waitForTimeout(120);
const tb = await page.locator(`[data-element-id="${TEXT_ID}"] text`).boundingBox();
await page.mouse.dblclick(tb.x + tb.width / 2, tb.y + tb.height / 2);
const editorOpen = await page.waitForFunction((textId) => {
  const fo = document.querySelector(`[data-element-id="${textId}"] foreignObject textarea`);
  return !!fo && document.activeElement === fo;
}, TEXT_ID, { timeout: 3000 }).then(() => true).catch(() => false);
check("double-click opens on-path text editor", editorOpen);

await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("Curved!");
const liveContent = (await readText()).content;
check("typing updates the document live", liveContent === "Curved!", liveContent);

await page.keyboard.press("Enter");
const committed = await page.waitForFunction((textId) => {
  const doc = window.__FISH_BRIDGE__.getDoc();
  const el = doc.pages.find((p) => p.id === doc.activePageId).children.find((e) => e.id === textId);
  const editor = document.querySelector(`[data-element-id="${textId}"] foreignObject textarea`);
  return el.content === "Curved!" && !editor;
}, TEXT_ID, { timeout: 3000 }).then(() => true).catch(() => false);
check("Enter commits and closes the editor", committed);

// --- 5. dragging the text body slides it along the path ---------------------
// The handle drag above pinned the run at 100%; re-seat it mid-path first.
await page.evaluate((textId) => {
  const bridge = window.__FISH_BRIDGE__;
  const doc = bridge.getDoc();
  const pageEls = doc.pages.find((p) => p.id === doc.activePageId).children;
  const next = pageEls.map((e) =>
    e.id === textId ? { ...e, onPath: { ...e.onPath, startOffset: 40 } } : e
  );
  bridge.setElements(next);
}, TEXT_ID);
await page.waitForSelector('[data-element-id="tp_text"] textPath');
await page.waitForTimeout(250);
const slideBefore = (await readText()).onPath.startOffset;
const gb = await page.locator(`[data-element-id="${TEXT_ID}"] text`).boundingBox();
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
await page.mouse.down();
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(gb.x + gb.width / 2 + i * 20, gb.y + gb.height / 2, { steps: 2 });
}
await page.mouse.up();
await page.waitForTimeout(120);
const slideAfter = (await readText()).onPath.startOffset;
check("dragging the text body slides it along the path", slideAfter !== slideBefore, `${slideBefore} -> ${slideAfter}`);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 && pageErrors.length === 0 ? 0 : 1);
