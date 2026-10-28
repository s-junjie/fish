import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// The gestures around the in-place text editor, none of which a unit test can
// see: WHICH click opens the caret, whether the editor actually goes away, and
// what the selection is afterwards.
//
// A double click reaches a text nested in a frame in two steps — the first press
// selects the frame, the second drills in — so "double click on a text edits it"
// made a nested text impossible to merely SELECT. And the editor selects the
// layer for itself so the caret has a home; that selection outlived the edit and
// made the NEXT double click land on an already-selected text, which is the one
// case that edits. Both are read off the live DOM here, not reasoned about.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok: !!ok });
}

const DOC = {
  version: "0.1",
  canvas: { width: 900, height: 600 },
  pages: [
    {
      id: "p1",
      name: "Page 1",
      children: [
        {
          id: "card",
          type: "frame",
          name: "Card",
          x: 80,
          y: 80,
          width: 400,
          height: 260,
          fills: [{ type: "solid", color: "#222222" }],
          children: [
            { id: "label", type: "text", name: "Label", x: 40, y: 40, width: 200, height: 40, content: "Hello there", style: { fontFamily: "Inter", fontSize: 20, color: "#FFFFFF" } },
            { id: "box", type: "rect", name: "Box", x: 40, y: 140, width: 120, height: 60, fills: [{ type: "solid", color: "#3E63DD" }] }
          ]
        },
        { id: "free", type: "text", name: "Free", x: 560, y: 120, width: 240, height: 40, content: "Free text", style: { fontFamily: "Inter", fontSize: 20, color: "#000000" } }
      ]
    }
  ],
  activePageId: "p1"
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);
await page.evaluate((doc) => {
  const base = window.__FISH_BRIDGE__.getDoc();
  window.__FISH_BRIDGE__.applyDoc(
    window.__fish.normalize({ ...base, canvas: doc.canvas, pages: doc.pages, activePageId: "p1" }).document
  );
}, DOC);
await page.waitForTimeout(350);

const boxOf = (id) =>
  page.evaluate((id) => {
    const el = document.querySelector(`[data-element-id="${id}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, x: r.x, y: r.y, w: r.width, h: r.height };
  }, id);

/** The editor, the selection and the selection's owner, read off the live DOM. */
const state = () =>
  page.evaluate(() => {
    const editor = document.querySelector('[contenteditable="true"]');
    const sel = window.getSelection();
    const out = {
      selected: window.__FISH_BRIDGE__.getSelectedIds(),
      editing: !!editor,
      editorOwns: editor ? (editor.closest("[data-element-id]")?.getAttribute("data-element-id") ?? null) : null,
      ranges: sel ? sel.rangeCount : -1,
      selWidth: 0,
      selInCanvas: false
    };
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      out.selWidth = Math.round(range.getBoundingClientRect().width);
      const root = document.querySelector("[data-canvas-root]");
      out.selInCanvas = !!root && root.contains(range.startContainer);
    }
    return out;
  });

const only = (ids, id) => ids.length === 1 && ids[0] === id;

const dbl = async (box) => {
  await page.mouse.move(box.cx, box.cy);
  await page.mouse.dblclick(box.cx, box.cy, { delay: 40 });
  await page.waitForTimeout(220);
};

/** A press on empty canvas, clear of the frame, the panels and the dock. */
const canvasSpot = await page.evaluate(() => {
  const r = document.querySelector("[data-canvas-root]").getBoundingClientRect();
  return { x: r.x + r.width * 0.5, y: r.y + r.height - 90 };
});
const deselect = async () => {
  await page.mouse.click(canvasSpot.x, canvasSpot.y);
  await page.waitForTimeout(220);
};

const content = (id) =>
  page.evaluate((id) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const els = doc.pages.find((p) => p.id === doc.activePageId).children;
    let found = null;
    const walk = (list) => list.forEach((e) => { if (e.id === id) found = e; if (e.children) walk(e.children); });
    walk(els);
    return found ? found.content : null;
  }, id);

const labelBox = await boxOf("label");
const cardBox = await boxOf("card");
const freeBox = await boxOf("free");

// ------------------------------------------- a text nested in a frame (card)
await deselect();
await dbl(labelBox);
let s = await state();
check("nested: a double click selects the text", only(s.selected, "label"), JSON.stringify(s.selected));
check("nested: that double click does NOT open the editor", s.editing === false, JSON.stringify(s));
// The settled paint is not selectable text: a double click on the canvas used
// to leave the browser's own word-selection highlighted on the glyphs, which is
// a selection the app never made and nothing ever cleared.
check(
  "nested: no browser text highlight is left on the canvas",
  s.ranges === 0 || s.selWidth === 0,
  JSON.stringify({ ranges: s.ranges, width: s.selWidth, inCanvas: s.selInCanvas })
);

// A range is an editing concept. A stray one used to be reported to the
// inspector as a live run, sending the next panel write into the span path —
// the size typed below has to land on the ELEMENT.
await page.fill('[data-scrub-field="Size"]', "26");
await page.locator('[data-scrub-field="Size"]').press("Enter");
await page.waitForTimeout(250);
const afterPanelWrite = await page.evaluate(() => {
  const doc = window.__FISH_BRIDGE__.getDoc();
  const card = doc.pages.find((p) => p.id === doc.activePageId).children.find((e) => e.id === "card");
  const label = card.children.find((c) => c.id === "label");
  return { fontSize: label.style?.fontSize, spans: label.spans?.length ?? 0 };
});
check(
  "panel writes land on the element, not in a stale text range",
  afterPanelWrite.fontSize === 26 && afterPanelWrite.spans === 0,
  JSON.stringify(afterPanelWrite)
);

await dbl(labelBox);
s = await state();
check(
  "nested: the next double click opens the editor on it",
  s.editing === true && s.editorOwns === "label",
  JSON.stringify({ editing: s.editing, owns: s.editorOwns })
);

// Escape: closes, and hands back the selection the editor made for itself — that
// selection is what made the next double click edit instead of select.
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
s = await state();
check("nested: Escape closes the editor", s.editing === false, JSON.stringify(s));
check("nested: Escape leaves no selection on the canvas", s.selected.length === 0, JSON.stringify(s.selected));
check(
  "nested: Escape leaves no selection in the DOM either",
  s.ranges === 0 && s.selInCanvas === false && s.selWidth === 0,
  JSON.stringify({ ranges: s.ranges, inCanvas: s.selInCanvas, width: s.selWidth })
);

// From nothing selected it is select-then-edit again, not edit.
await dbl(labelBox);
s = await state();
check(
  "nested: after exiting, a double click selects only again",
  s.editing === false && only(s.selected, "label"),
  JSON.stringify({ editing: s.editing, selected: s.selected })
);

// The editor still edits: type, commit, and read the document.
await dbl(labelBox);
await page.keyboard.type("!");
await page.keyboard.press("Meta+Enter");
await page.waitForTimeout(250);
// Opening the editor selects the whole run (that is what makes the first
// keystroke replace it), so "!" is the whole content the commit has to land.
const committed = await content("label");
s = await state();
check("editor: typing then committing writes the document", committed === "!", JSON.stringify(committed));
check("editor: committing closes it", s.editing === false, JSON.stringify(s));
// A commit is "done typing", not "done with the layer": the panel the author is
// about to click into must still have a target, so the selection stays.
check("editor: committing keeps the layer selected", only(s.selected, "label"), JSON.stringify(s.selected));

// The race the updater exists for: a click that exits the editor by selecting
// something ELSE is the author's answer and must survive.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("label"));
await page.waitForTimeout(220);
await dbl(labelBox);
check("race: an already-selected text edits on one double click", (await state()).editing === true);
await page.mouse.click(cardBox.x + 30, cardBox.cy + 90);
await page.waitForTimeout(250);
s = await state();
check(
  "race: clicking the frame exits and selects the FRAME",
  !s.editing && only(s.selected, "card"),
  JSON.stringify({ editing: s.editing, selected: s.selected })
);

// ------------------------------------------------------ a canvas-level text
await deselect();
await dbl(freeBox);
s = await state();
check(
  "control — a canvas-level text still opens on the FIRST double click",
  s.editing === true && s.editorOwns === "free",
  JSON.stringify({ editing: s.editing, owns: s.editorOwns })
);
await page.keyboard.press("Escape");
await page.waitForTimeout(220);
s = await state();
check(
  "control — Escape closes it there too, and drops the selection",
  s.editing === false && s.selected.length === 0,
  JSON.stringify(s)
);

// A selection made in the layer tree is a real selection, so one double click edits.
await page.evaluate(() => document.querySelector('[data-layer-row="label"]').click());
await page.waitForTimeout(250);
await dbl(labelBox);
s = await state();
check(
  "control — a text picked in the layers panel edits on ONE double click",
  s.editing === true && s.editorOwns === "label",
  JSON.stringify({ editing: s.editing, owns: s.editorOwns })
);

// The release is Escape-only. Clicking into a panel to keep working with the
// text must NOT drop it — the panel loses its target the moment it is used.
const inspector = await page.$('[data-ui-panel="right"]');
if (inspector) {
  await inspector.click({ position: { x: 20, y: 8 } });
  await page.waitForTimeout(250);
  s = await state();
  check(
    "exit: clicking the inspector closes the editor and KEEPS the layer selected",
    s.editing === false && only(s.selected, "label"),
    JSON.stringify({ editing: s.editing, selected: s.selected })
  );
} else {
  check("exit: the inspector is on screen", false, "no [data-ui-panel=right]");
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (errors.length) console.log("pageErrors:", errors.slice(0, 6));
process.exit(failed.length || errors.length ? 1 : 0);
