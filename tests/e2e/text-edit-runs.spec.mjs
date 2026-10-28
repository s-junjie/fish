import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Editing the characters of a run-bearing text, driven through the real editor.
//
// The run engine has unit tests and the reconciler's arithmetic is proven there;
// what a unit test cannot reach is the HANDOVER — whether the browser actually
// tells the editor which characters an edit replaced, and whether the editor's
// own DOM manipulations (a trailing-newline sentinel, a dropped string) land in
// the model as the text the author sees.
//
// Two of these cases are only visible end to end. The repeated-character one is
// the reason `beforeinput` is read at all: from the two strings alone, typing one
// more "a" after the second of four is indistinguishable from typing it at the
// end, and the styles come out on the wrong run. The newline one is the reason
// the sentinel exists: without it there is no position in the DOM after a
// trailing newline for a caret to occupy, and the next character typed lands
// before it.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok: !!ok });
}

const BLUE = "#3B63DD";
const RED = "#EF4444";

const ELEMENTS = () => [
  {
    id: "para",
    type: "text",
    name: "Para",
    x: 120,
    y: 120,
    width: 420,
    height: 48,
    content: "Hello World",
    style: { fontFamily: "Inter", fontSize: 24, color: "#000000" },
    spans: [
      { text: "Hello ", style: { color: BLUE } },
      { text: "World", style: { fontWeight: 700 } }
    ]
  },
  {
    id: "rep",
    type: "text",
    name: "Repeated",
    x: 120,
    y: 240,
    width: 420,
    height: 48,
    content: "aaa",
    style: { fontFamily: "Inter", fontSize: 24, color: "#000000" },
    spans: [
      { text: "a", style: { color: BLUE } },
      { text: "a", style: { fontWeight: 700 } },
      { text: "a", style: { color: RED } }
    ]
  },
  {
    id: "plain",
    type: "text",
    name: "Plain",
    x: 120,
    y: 360,
    width: 420,
    height: 48,
    content: "Tail",
    style: { fontFamily: "Inter", fontSize: 24, color: "#000000" }
  },
  {
    id: "pad",
    type: "rect",
    name: "Pad",
    x: 700,
    y: 560,
    width: 120,
    height: 80,
    fills: [{ type: "solid", color: "#3E63DD" }]
  }
];

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
        canvas: { width: 1200, height: 800 },
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

/** The live model: content and runs, as the document holds them. */
const textOf = (id) =>
  page.evaluate((id) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const els = doc.pages.find((p) => p.id === doc.activePageId).children;
    const el = els.find((e) => e.id === id);
    return {
      content: el.content,
      spans: (el.spans ?? []).map((s) => ({ text: s.text, style: s.style ?? null }))
    };
  }, id);

const editorOpen = () => page.evaluate(() => !!document.querySelector('[contenteditable="true"]'));

/**
 * Open the in-place editor on `id`.
 *
 * A press that selects and a press that opens the caret are two presses, so the
 * first double click selects and the second opens — the same gesture a person
 * makes, and the same one the gesture spec pins.
 */
const openEditor = async (id) => {
  const box = await boxOf(id);
  await page.evaluate((el) => window.__FISH_BRIDGE__.selectElement(el), id);
  await page.waitForTimeout(180);
  await page.mouse.move(box.cx, box.cy);
  await page.mouse.dblclick(box.cx, box.cy, { delay: 40 });
  await page.waitForTimeout(180);
  await page.mouse.dblclick(box.cx, box.cy, { delay: 40 });
  await page.waitForTimeout(260);
};

/** Put the caret (or a selection) at character offsets in the editor, as typing would. */
const setOffsets = (start, end) =>
  page.evaluate(
    ([s, e]) => {
      const ed = document.querySelector('[contenteditable="true"]');
      if (!ed) return null;
      const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
      const locate = (offset) => {
        let cur = 0;
        for (const n of nodes) {
          const len = (n.nodeValue || "").length;
          if (cur + len >= offset) return { node: n, offset: Math.max(0, offset - cur) };
          cur += len;
        }
        const last = nodes[nodes.length - 1];
        return { node: last, offset: (last?.nodeValue || "").length };
      };
      const a = locate(s);
      const b = locate(e);
      if (!a.node || !b.node) return null;
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.getRangeAt(0).toString();
    },
    [start, end]
  );

const settle = async () => {
  await page.keyboard.press("Meta+Enter");
  await page.waitForTimeout(200);
};

// ------------------------------------------------- a replacement keeps the run it replaced
await seed();
await page.waitForTimeout(300);
await openEditor("para");
check("setup — the editor is open on a run-bearing text", await editorOpen());
check("setup — the whole run is selected, as opening the editor selects it", (await setOffsets(6, 11)) === "World");

await page.keyboard.type("Fish", { delay: 30 });
await page.waitForTimeout(250);
const replaced = await textOf("para");
check(
  "typing over a run gives the new text THAT run's style",
  replaced.content === "Hello Fish" &&
    replaced.spans.length === 2 &&
    replaced.spans[0].text === "Hello " &&
    replaced.spans[0].style?.color === BLUE &&
    replaced.spans[1].text === "Fish" &&
    replaced.spans[1].style?.fontWeight === 700,
  JSON.stringify(replaced)
);
await settle();

// ------------------------------------------------- an append joins the run it lands in
await seed();
await page.waitForTimeout(300);
await openEditor("para");
await setOffsets(11, 11);
await page.keyboard.type("!", { delay: 30 });
await page.waitForTimeout(250);
const appended = await textOf("para");
check(
  "typing at the end extends the run the caret is in",
  appended.content === "Hello World!" &&
    appended.spans.length === 2 &&
    appended.spans[1].text === "World!" &&
    appended.spans[1].style?.fontWeight === 700,
  JSON.stringify(appended)
);
await settle();

// ------------------------------------------------- a delete across runs keeps the survivors
await seed();
await page.waitForTimeout(300);
await openEditor("para");
await setOffsets(4, 11);
await page.keyboard.press("Delete");
await page.waitForTimeout(250);
const deleted = await textOf("para");
check(
  "deleting across a run boundary leaves the survivors with their own styles",
  deleted.content === "Hell" &&
    deleted.spans.length === 1 &&
    deleted.spans[0].text === "Hell" &&
    deleted.spans[0].style?.color === BLUE,
  JSON.stringify(deleted)
);
await settle();

// ------------------------------------------------- the edit the strings cannot describe
await seed();
await page.waitForTimeout(300);
await openEditor("rep");
await setOffsets(1, 1);
await page.keyboard.type("a", { delay: 30 });
await page.waitForTimeout(250);
const exact = await textOf("rep");
// From the two strings alone the extra "a" reads as appended, and the last run's
// red is what it would wear. The caret was after the FIRST "a", and only the
// browser's own account of the edit can say so.
check(
  "typing into repeated characters styles the character at the caret",
  exact.content === "aaaa" &&
    exact.spans.map((s) => s.text).join("|") === "aa|a|a" &&
    exact.spans[0].style?.color === BLUE &&
    exact.spans[2].style?.color === RED,
  JSON.stringify(exact)
);
await settle();

// ------------------------------------------------- a drop is plain text, and nothing else
await seed();
await page.waitForTimeout(300);
await openEditor("plain");
await setOffsets(4, 4);
const dropped = await page.evaluate(() => {
  const ed = document.querySelector('[contenteditable="true"]');
  if (!ed) return null;
  const dt = new DataTransfer();
  dt.setData("text/plain", "DROP");
  ed.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  return {
    divs: ed.querySelectorAll("div").length,
    brs: ed.querySelectorAll("br").length
  };
});
await page.waitForTimeout(250);
const afterDrop = await textOf("plain");
check(
  "a dropped string arrives as plain text",
  afterDrop.content === "TailDROP",
  JSON.stringify(afterDrop)
);
check(
  "…and leaves no browser markup behind in the editor",
  dropped && dropped.divs === 0 && dropped.brs === 0,
  JSON.stringify(dropped)
);
await settle();

// ------------------------------------------------- a trailing newline still has a caret
await seed();
await page.waitForTimeout(300);
await openEditor("plain");
// Opening the editor selects the whole run so the caret has a home, so a raw
// Enter here would replace the text — put the caret at the end first.
await setOffsets(4, 4);
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const afterEnter = await textOf("plain");
check("Enter opens a line", afterEnter.content === "Tail\n", JSON.stringify(afterEnter));

await page.keyboard.type("x", { delay: 30 });
await page.waitForTimeout(250);
const afterNewLine = await textOf("plain");
// The sentinel the editor appends is what gives that new line a caret; it must
// never survive into the document, and the "x" must not land in front of it.
check(
  "the character typed on the new line lands there, and no sentinel is stored",
  afterNewLine.content === "Tail\nx" && !afterNewLine.content.includes("\u200b"),
  JSON.stringify(afterNewLine)
);

// The re-render rebuilds the runs, and the caret has to come back where it was
// rather than in front of the character just typed.
const caretOffset = await page.evaluate(() => {
  const ed = document.querySelector('[contenteditable="true"]');
  const sel = window.getSelection();
  if (!ed || !sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.setStart(ed, 0);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().replace(/\u200b/g, "").length;
});
check("the caret sits after the character just typed", caretOffset === 6, String(caretOffset));
await settle();

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (errors.length) console.log("pageErrors:", errors.slice(0, 6));
process.exit(failed.length || errors.length ? 1 : 0);
