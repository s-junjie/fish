import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Deleting back to a line break in a narrow, bottom-aligned text.
//
// The editor keeps a caret on an empty last line with a zero-width sentinel and
// a `<br>` the browser owns. Both used to leak into the model — the capture read
// `innerText`, which counts the `<br>` as a second newline, while the offsets
// read text nodes only — so every Backspace at the end ADDED a blank line, and
// the painted run slid up out of its own box. This drives the real editor and
// reads the result off the document and the live DOM.
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
          id: "t1",
          type: "text",
          name: "Narrow",
          x: 100,
          y: 80,
          width: 44,
          height: 300,
          content: "L\nI\nG\nH\nT",
          sizing: { height: "fit-content" },
          style: { fontFamily: "Inter", fontSize: 28, color: "#333333", verticalAlign: "bottom" }
        }
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

const element = () => page.evaluate(() => window.__FISH_BRIDGE__.getElements().find((e) => e.id === "t1"));
const boxes = () =>
  page.evaluate(() => {
    const fo = document.querySelector('[data-element-id="t1"] foreignObject');
    const ce = fo?.querySelector("[contenteditable]");
    const r = (n) => {
      const b = n.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, width: b.width, height: b.height };
    };
    return {
      box: fo ? r(fo) : null,
      content: ce ? r(ce) : null,
      brs: fo ? fo.querySelectorAll("br").length : 0,
      editing: !!ce
    };
  });

const box = await page.evaluate(() => {
  const n = document.querySelector('[data-element-id="t1"]');
  const b = n.getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
});
await page.mouse.dblclick(box.x + box.w / 2, box.y + 20);
await page.waitForTimeout(250);
check("the editor opens on the text", (await boxes()).editing);

await page.evaluate(() => {
  const ce = document.querySelector("[contenteditable='true']");
  const range = document.createRange();
  range.selectNodeContents(ce);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
for (let i = 0; i < 3; i++) {
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(90);
}

const during = await element();
const live = await boxes();
check(
  "three Backspaces delete three characters, not blank lines",
  during.content === "L\nI\nG\n",
  JSON.stringify(during.content)
);
check(
  "no caret sentinel is written into the document",
  !during.content.includes("\u200b"),
  JSON.stringify(during.content)
);
check(
  "the text is not pushed above the top of its box",
  live.content && live.box && live.content.top >= live.box.top - 1,
  live.content && live.box ? `content ${live.content.top} vs box ${live.box.top}` : "missing"
);
check(
  "the box is still the size of its lines",
  during.height < 200,
  `height ${during.height}`
);

await page.mouse.click(1000, 700);
await page.waitForTimeout(300);
const settled = await element();
const after = await boxes();
check("committing keeps the content", settled.content === "L\nI\nG\n", JSON.stringify(settled.content));
check("the settled paint carries no browser <br>", after.brs === 0, `${after.brs} br`);
check(
  "the settled text still sits inside its box",
  after.content && after.box && after.content.top >= after.box.top - 1,
  after.content && after.box ? `content ${after.content.top} vs box ${after.box.top}` : "missing"
);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
