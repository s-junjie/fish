import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Styling PART of a text — one run inside a paragraph — driven the way a person
// does it: select characters in the canvas editor, then use the inspector.
//
// The whole path was unreachable and no test noticed, because the two halves
// were proven separately: the span engine has unit tests, and the typography
// spec only ever asserted LAYER-scoped writes. What was missing is the handover
// — the press on a panel control blurs the contentEditable, and the commit that
// follows used to drop the run selection a moment before the panel read it, so
// the size or italic landed on the whole layer.
//
// The other half of the contract is what must NOT survive: the browser's own
// selection is an editing artifact, so leaving the editor by any route has to
// leave the canvas with nothing highlighted.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok: !!ok });
}

const ELEMENTS = () => [
  {
    id: "free",
    type: "text",
    name: "Free",
    x: 120,
    y: 140,
    width: 360,
    height: 48,
    content: "Hello World",
    style: { fontFamily: "Inter", fontSize: 24, color: "#000000" }
  },
  {
    id: "other",
    type: "text",
    name: "Other",
    x: 120,
    y: 300,
    width: 360,
    height: 48,
    content: "Second Line",
    style: { fontFamily: "Inter", fontSize: 24, color: "#000000" }
  },
  {
    id: "pad",
    type: "rect",
    name: "Pad",
    x: 600,
    y: 480,
    width: 120,
    height: 80,
    fills: [{ type: "solid", color: "#3E63DD" }]
  }
];

const inspector = '[data-ui-panel="right"]';
const ITALIC = `${inspector} [data-typography-toggle="italic"]`;
const SIZE_LABEL = `${inspector} [data-scrub-label="Size"]`;
const SIZE_FIELD = `${inspector} [data-scrub-field="Size"]`;
const LS_FIELD = `${inspector} [data-scrub-field="LS"]`;
const FILL_HEX = `${inspector} [data-hex-input="fill-0"]`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

const seed = async () =>
  page.evaluate((elements) => {
    const base = window.__FISH_BRIDGE__.getDoc();
    window.__FISH_BRIDGE__.applyDoc(
      window.__fish.normalize({
        ...base,
        canvas: { width: 1100, height: 700 },
        pages: [{ id: "p1", name: "Page 1", children: elements }],
        activePageId: "p1"
      }).document
    );
  }, ELEMENTS());

const boxOf = (id) =>
  page.evaluate((id) => {
    const el = document.querySelector(`[data-element-id="${id}"]`);
    const r = el.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  }, id);

const textOf = (id) =>
  page.evaluate((id) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const els = doc.pages.find((p) => p.id === doc.activePageId).children;
    const el = els.find((e) => e.id === id);
    return {
      fontSize: el.style?.fontSize,
      fontStyle: el.style?.fontStyle ?? null,
      letterSpacing: el.style?.letterSpacing,
      fillColor: el.fills?.[0]?.color ?? null,
      fillTokenId: el.fills?.[0]?.tokenId ?? null,
      spans: (el.spans ?? []).map((s) => ({ text: s.text, style: s.style ?? null }))
    };
  }, id);

const editorOpen = () => page.evaluate(() => !!document.querySelector('[contenteditable="true"]'));

/**
 * Where the BROWSER's selection is, and whether the canvas would paint it. A
 * range that lives only in the app's state paints nothing; the settled text is
 * also asked whether it accepts selection at all — that is the app-side half of
 * "the editor is closed, so there is no selection to show".
 */
const canvasHighlight = () =>
  page.evaluate(() => {
    const root = document.querySelector("[data-canvas-root]");
    const sel = window.getSelection();
    let painted = false;
    let where = "none";
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const inside = !!root && root.contains(range.startContainer);
      const box = range.getBoundingClientRect();
      painted = inside && box.width > 0 && box.height > 0;
      where = inside ? `in-canvas w=${Math.round(box.width)}` : "outside-canvas";
    }
    const settled = root?.querySelector('[data-element-id="free"] div[contenteditable="false"]');
    return {
      painted,
      where,
      ranged: sel ? sel.rangeCount : -1,
      userSelect: settled ? getComputedStyle(settled).userSelect : null
    };
  });

/** What the settled paint actually says: computed style, per run. */
const paintedRuns = () =>
  page.evaluate(() => {
    const root = document.querySelector('[data-element-id="free"]');
    if (!root) return [];
    return Array.from(root.querySelectorAll("span"))
      .filter((s) => s.textContent)
      .map((s) => {
        const cs = getComputedStyle(s);
        return { text: s.textContent, color: cs.color, letterSpacing: cs.letterSpacing };
      });
  });

/**
 * Type a hex into the fill row and commit it, reporting whether the field was
 * there at all. Written as a probe rather than a bare `page.fill`, because on a
 * bundle that predates the hook the locator waits 30s and throws — which reads as
 * a broken spec instead of a failing check.
 */
const typeFillHex = async (value, sel = FILL_HEX) => {
  const present = await page.evaluate((s) => !!document.querySelector(s), sel);
  if (!present) return false;
  await page.fill(sel, value);
  await page.locator(sel).press("Enter");
  await page.waitForTimeout(320);
  return true;
};

const openFreeEditor = async () => {
  const box = await boxOf("free");
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("free"));
  await page.waitForTimeout(220);
  await page.mouse.move(box.cx, box.cy);
  await page.mouse.dblclick(box.cx, box.cy, { delay: 40 });
  await page.waitForTimeout(280);
};

/** Select "Hello" and report it exactly as the editor's own mouseup handler does. */
const selectHello = () =>
  page.evaluate(() => {
    const ed = document.querySelector('[contenteditable="true"]');
    if (!ed) return null;
    const node = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT).nextNode();
    if (!node) return null;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 5);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ed.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return sel.getRangeAt(0).toString();
  });

// ---------------------------------------------- a press on a toggle styles the run
await seed();
await page.waitForTimeout(350);
await openFreeEditor();
const selected = await selectHello();
check("setup — the editor is open with “Hello” selected", (await editorOpen()) && selected === "Hello", String(selected));

await page.click(ITALIC);
await page.waitForTimeout(300);
const afterItalic = await textOf("free");
check(
  "a real press on the italic toggle leaves the editor open, so the range stays visible",
  await editorOpen(),
  JSON.stringify(await canvasHighlight())
);
check(
  "…and italicises the RUN, not the layer",
  afterItalic.fontStyle === null &&
    afterItalic.spans.length === 2 &&
    afterItalic.spans[0].text === "Hello" &&
    afterItalic.spans[0].style?.fontStyle === "italic" &&
    afterItalic.spans[1].text === " World",
  JSON.stringify(afterItalic)
);
check("…with that range painted on the canvas while it is live", (await canvasHighlight()).painted === true);

// ---------------------------------------------- scrubbing the size handle keeps the caret
await seed();
await page.waitForTimeout(350);
await openFreeEditor();
await selectHello();
const handle = await page.evaluate((sel) => {
  const r = document.querySelector(sel).getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, SIZE_LABEL);
await page.mouse.move(handle.x, handle.y);
await page.mouse.down();
await page.mouse.move(handle.x + 24, handle.y, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(320);
const afterScrub = await textOf("free");
check("scrubbing the size handle keeps the editor open", await editorOpen());
check(
  "…and resizes only the selected run",
  afterScrub.spans.length === 2 &&
    afterScrub.spans[0].style?.fontSize > 24 &&
    afterScrub.spans[1].text === " World" &&
    afterScrub.spans[1].style?.fontSize === undefined,
  JSON.stringify(afterScrub)
);

// ---------------------------------------------- a field that must take focus anyway
await seed();
await page.waitForTimeout(350);
await openFreeEditor();
await selectHello();
await page.click(SIZE_FIELD);
await page.waitForTimeout(220);
const afterFieldClick = await canvasHighlight();
check("clicking a number field closes the editor (a field has to take focus)", (await editorOpen()) === false);
check(
  "…and that exit leaves nothing selected on the canvas",
  afterFieldClick.painted === false && (afterFieldClick.ranged === 0 || afterFieldClick.where === "outside-canvas"),
  JSON.stringify(afterFieldClick)
);
check("…while the settled text refuses to be selectable at all", afterFieldClick.userSelect === "none", String(afterFieldClick.userSelect));
await page.fill(SIZE_FIELD, "60");
await page.locator(SIZE_FIELD).press("Enter");
await page.waitForTimeout(300);
const afterType = await textOf("free");
check(
  "…and the range still lands as a run when the field commits",
  afterType.spans.length === 2 &&
    afterType.spans[0].style?.fontSize === 60 &&
    afterType.spans[1].text === " World" &&
    afterType.fontSize === 24,
  JSON.stringify(afterType)
);
check("…with no highlight left behind", (await canvasHighlight()).painted === false);

// ---------------------------------------------- Escape drops the session AND the range
await seed();
await page.waitForTimeout(350);
await openFreeEditor();
await selectHello();
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const afterEscape = await canvasHighlight();
check("Escape closes the editor", (await editorOpen()) === false);
check(
  "Escape leaves nothing selected on the canvas",
  afterEscape.painted === false && (afterEscape.ranged === 0 || afterEscape.where === "outside-canvas"),
  JSON.stringify(afterEscape)
);
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("free"));
await page.waitForTimeout(250);
await page.click(ITALIC);
await page.waitForTimeout(280);
const afterEscapeWrite = await textOf("free");
check(
  "after Escape the panel writes the LAYER again — the range is gone, not merely invisible",
  afterEscapeWrite.fontStyle === "italic" && afterEscapeWrite.spans.length === 0,
  JSON.stringify(afterEscapeWrite)
);

// ---------------------------------------------- leaving the text ends the session too
await seed();
await page.waitForTimeout(350);
await openFreeEditor();
await selectHello();
await page.click(ITALIC);
await page.waitForTimeout(280);
await page.evaluate(() => document.querySelector('[data-layer-row="other"]').click());
await page.waitForTimeout(300);
await page.click(ITALIC);
await page.waitForTimeout(300);
const other = await textOf("other");
check(
  "choosing another layer drops the first text's range — this write is layer-scoped",
  other.fontStyle === "italic" && other.spans.length === 0,
  JSON.stringify(other)
);

// ---------------------------------------------- a press on the canvas exits cleanly
await seed();
await page.waitForTimeout(350);
await openFreeEditor();
await selectHello();
const pad = await boxOf("pad");
await page.mouse.click(pad.cx, pad.cy);
await page.waitForTimeout(300);
const afterCanvasPress = await canvasHighlight();
check("pressing another layer closes the editor", (await editorOpen()) === false);
check(
  "…and paints no selection on the canvas",
  afterCanvasPress.painted === false && (afterCanvasPress.ranged === 0 || afterCanvasPress.where === "outside-canvas"),
  JSON.stringify(afterCanvasPress)
);

// ---------------------------------------------- letter spacing is a run property too
await seed();
await page.waitForTimeout(350);
await openFreeEditor();
await selectHello();
await page.fill(LS_FIELD, "6");
await page.locator(LS_FIELD).press("Enter");
await page.waitForTimeout(320);
const afterLS = await textOf("free");
check(
  "a letter-spacing typed with a range armed lands on the RUN, and leaves the layers' own spacing alone",
  afterLS.spans.length === 2 &&
    afterLS.spans[0].text === "Hello" &&
    afterLS.spans[0].style?.letterSpacing === 6 &&
    afterLS.spans[1].text === " World" &&
    afterLS.spans[1].style?.letterSpacing === undefined &&
    afterLS.letterSpacing === undefined,
  JSON.stringify(afterLS)
);
const lsPainted = (await paintedRuns()).find((r) => r.text === "Hello");
check(
  "…and the canvas paints that tracking",
  lsPainted?.letterSpacing === "6px",
  JSON.stringify(await paintedRuns())
);

// ---------------------------------------------- the fill section's colour follows the run
await seed();
await page.waitForTimeout(350);
await openFreeEditor();
await selectHello();
const hexReachable = await typeFillHex("FF0000");
const afterColor = await textOf("free");
check("the fill row offers a hex field", hexReachable);
check(
  "a fill colour picked with a range armed lands on the RUN, not on the layer's fills",
  afterColor.spans.length === 2 &&
    /^#FF0000/i.test(afterColor.spans[0].style?.color ?? "") &&
    afterColor.spans[1].text === " World" &&
    afterColor.spans[1].style?.color === undefined &&
    afterColor.fillColor === "#000000",
  JSON.stringify(afterColor)
);
check(
  "…and the fill row shows the run's colour while it is armed",
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return !!el && el.value.toUpperCase() === "#FF0000";
  }, FILL_HEX)
);
const colorPainted = await paintedRuns();
check(
  "…and the canvas paints the run red while the layer's fill stays black",
  colorPainted.find((r) => r.text === "Hello")?.color === "rgb(255, 0, 0)" &&
    colorPainted.find((r) => r.text === " World")?.color === "rgb(0, 0, 0)",
  JSON.stringify(colorPainted)
);

// ---------------------------------------------- …and the layer's colour with no range
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("other"));
await page.waitForTimeout(250);
await typeFillHex("00AA55");
const otherColor = await textOf("other");
check(
  "with nothing selected in a text, the same field still writes the LAYER",
  /^#00AA55/i.test(otherColor.fillColor ?? "") && otherColor.spans.length === 0,
  JSON.stringify(otherColor)
);

// ---------------------------------------------- a token detach is LAYER-scoped
// A run carries only a materialised colour, so detaching while characters are
// selected must strip the token from the layer's paint. Routed through the run
// writer it rewrote the same colour and the x looked dead.
await page.evaluate((elements) => {
  const base = window.__FISH_BRIDGE__.getDoc();
  window.__FISH_BRIDGE__.applyDoc(
    window.__fish.normalize({
      ...base,
      tokens: [{ id: "tok_color", name: "brand/primary", type: "color", value: "#3355FF" }],
      canvas: { width: 1100, height: 700 },
      pages: [{ id: "p1", name: "Page 1", children: elements }],
      activePageId: "p1"
    }).document
  );
}, [
  {
    id: "free",
    type: "text",
    name: "Free",
    x: 120,
    y: 140,
    width: 360,
    height: 48,
    content: "Hello World",
    style: { fontFamily: "Inter", fontSize: 24, color: "#3355FF" },
    fills: [{ type: "solid", color: "#3355FF", tokenId: "tok_color" }]
  }
]);
await page.waitForTimeout(350);
await openFreeEditor();
await selectHello();
const DETACH = `${inspector} [data-paint-token-detach="tok_color"]`;
const tokenTagPresent = await page.evaluate((sel) => !!document.querySelector(sel), DETACH);
check("a token-bound text row offers x while characters are selected", tokenTagPresent);
if (tokenTagPresent) {
  await page.click(DETACH);
  await page.waitForTimeout(320);
}
const afterDetach = await textOf("free");
check(
  "…and pressing it detaches the token from the layer",
  afterDetach.fillTokenId === null && /^#3355FF/i.test(afterDetach.fillColor ?? ""),
  JSON.stringify(afterDetach)
);
check(
  "…leaving the row on the raw colour",
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return !!el && el.value.toUpperCase() === "#3355FF";
  }, FILL_HEX)
);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (errors.length) console.log("pageErrors:", errors.slice(0, 6));
process.exit(failed.length || errors.length ? 1 : 0);
