import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// Enter is "open what I have selected".
//
// A text layer opens the in-canvas text editor; a frame drills into its
// children; a shape hands the layer to the vector editor. All three live in
// different keymap rules, so the one that runs first has to decline what it
// cannot serve — the vector editor used to claim every single selection and then
// refuse text and frames, which made Enter a dead key on both.

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, actual, expected) => {
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const applySetup = () =>
  page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements(
      [
        { id: "label", type: "text", name: "label", x: 300, y: 300, width: 200, height: 60, content: "Hello there" },
        {
          id: "frame1", type: "frame", name: "frame1", x: 700, y: 300, width: 300, height: 200,
          children: [{ id: "kid", type: "rect", x: 20, y: 20, width: 60, height: 60 }]
        },
        { id: "rectA", type: "rect", name: "rectA", x: 300, y: 600, width: 120, height: 80 },
        { id: "textB", type: "text", name: "textB", x: 900, y: 700, width: 200, height: 60, content: "Second" }
      ],
      { canvas: { ...base.canvas, width: 3000, height: 2000 } }
    );
  });

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const selected = () => page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds());
const textEditors = () => page.locator('[contenteditable="true"]').count();
const pathEditor = () => page.locator('[data-path-edit="true"]').count();
const editorText = () => page.evaluate(() => document.querySelector('[contenteditable="true"]')?.textContent ?? null);
const select = async (ids) => {
  await page.evaluate((list) => window.__FISH_BRIDGE__.selectElements(list), ids);
  await settle();
};
const press = async (key) => {
  await page.keyboard.press(key);
  await settle();
};

// 1. Enter on a selected text layer opens the text editor on it.
await applySetup();
await select(["label"]);
check("no text editor before the press", await textEditors(), 0);
await press("Enter");
check("enter opens the text editor", await textEditors(), 1);
check("the editor holds that layer's content", await editorText(), "Hello there");
check("and the layer stays selected", await selected(), ["label"]);
check("enter does not open the vector editor on text", await pathEditor(), 0);

// 2. Escape leaves it, and Enter opens it again — the key is a door, not a toggle
//    that burns itself out after one use.
await press("Escape");
check("escape closes the text editor", await textEditors(), 0);
await select(["label"]);
await press("Enter");
check("enter opens it a second time", await textEditors(), 1);
await press("Escape");

// 3. Enter on a frame drills into its children.
await applySetup();
await select(["frame1"]);
await press("Enter");
check("enter on a frame selects its children", await selected(), ["kid"]);
check("drilling in opens no editor", await textEditors(), 0);

// 4. Enter on a shape still belongs to the vector editor.
await applySetup();
await select(["rectA"]);
await press("Enter");
check("enter on a shape opens the vector editor", await pathEditor(), 1);
check("and opens no text editor", await textEditors(), 0);

// 5. A group is not one thing to open: Enter declines rather than picking a
//    member at random.
await applySetup();
await select(["textB", "rectA"]);
await press("Enter");
check("enter on a multi-selection opens nothing", [await textEditors(), await pathEditor()], [0, 0]);
check("and leaves the selection alone", (await selected()).sort(), ["rectA", "textB"]);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
