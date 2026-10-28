import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// "Start from Scratch…" lives in the autosave popover because that popover is the
// app's document hub. The claims worth making are therefore not "a row renders":
//
//   - it sits alone between two rules, because it is the only row that acts on the
//     document's CONTENT rather than its file — next to Save it would read as
//     "save, then empty what I just saved".
//   - the rule is visible. `MENU_SEPARATOR_CLASS` exists because a separator in
//     the menu's own colour is a 1px line of the colour it is drawn on; the check
//     is therefore against the popover's background, not against a token.
//   - clicking CLEARS THIS CANVAS and asks first (`324a44c` replaced an earlier
//     "write a second, empty file" behaviour). Both halves of that are pinned:
//     a confirm nobody can decline is not a confirm, and a reset that reaches for
//     a file picker is not the command the row names.

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const ELEMENTS = [
  { id: "nf_a", type: "rect", name: "Original", x: 0, y: 0, width: 400, height: 200, fills: [{ type: "solid", color: "#3E63DD" }] }
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
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
  bridge.setElements(JSON.parse(JSON.stringify(elements)));
}, ELEMENTS);
await page.waitForTimeout(300);

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const idle = async () => {
  await settle();
  await page.waitForTimeout(150);
  await settle();
};

await page.click("[data-autosave-status]");
await idle();

// ------------------------------------------------------------------- the row
const row = await page.evaluate(() => {
  const n = document.querySelector("[data-title-bar-new-file]");
  if (!n) return null;
  const b = n.getBoundingClientRect();
  const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  return {
    text: n.textContent.trim(),
    height: b.height,
    hit: !!hit && (hit === n || n.contains(hit) || hit.contains(n)),
    hitTag: hit ? `${hit.tagName}.${String(hit.className).slice(0, 24)}` : "nothing"
  };
});
check("the popover carries a Start from Scratch row", row !== null, JSON.stringify(row));
check("it is named, not blank", !!row && row.text.length > 0, row ? `“${row.text}”` : "");
check("its middle is the topmost thing at that point", !!row && row.hit, row ? `hit: ${row.hitTag}` : "");
// MENU_ITEM_CLASS's own height, measured rather than read from the class: a row
// that silently changed size is the change nothing else here would notice.
check("it is a 26px menu row", !!row && Math.abs(row.height - 26) < 0.5, `height ${row?.height}`);

// The rows around it act on this document's FILE; this one acts on its CONTENT.
// Asserted by position rather than by a separator existing, because the separation
// is the meaning — a rule that failed to render would still leave the order intact.
//
// "alone between two rules" rather than "the first row": the menu gains rows over
// time (document JSON, then Save As), and a position-of-1 assertion turns every
// addition into a false regression while saying nothing about the rule this row
// exists to state. A rule on each side does say it — nothing sits next to it, so it
// cannot read as one more file command.
const order = await page.evaluate(() => {
  const menu = document.querySelector("[data-title-bar-new-file]")?.closest("div.flex.flex-col");
  if (!menu) return null;
  const name = (c) =>
    c.dataset.titleBarSave ? "[save]" :
    c.dataset.titleBarSaveAs ? "[save-as]" :
    c.dataset.titleBarHistory ? "[history]" :
    c.dataset.titleBarNewFile ? "[new]" :
    c.dataset.titleBarExportJson ? "[export]" :
    c.dataset.titleBarImportJson ? "[import]" :
    c.dataset.titleBarCopyCompactJson ? "[copy-compact]" : "[?]";
  const rows = [...menu.children].map((c) => c.tagName + (c.tagName === "BUTTON" ? name(c) : "[sep]"));
  const index = [...menu.children].findIndex((c) => c.dataset.titleBarNewFile);
  const tag = (i) => menu.children[i]?.tagName ?? null;
  return { rows, index, prev: tag(index - 1), next: tag(index + 1), buttons: rows.filter((r) => r.startsWith("BUTTON")).length };
});
check(
  "it sits alone between two rules, so it never reads as a neighbour of Save",
  order !== null && order.index >= 0 && order.prev === "DIV" && order.next === "DIV",
  JSON.stringify(order)
);
// Every row is a command this spec can name, or one of the rules between them.
// An unnamed row would be a command in the menu that nothing here accounts for.
check(
  "every row is a named command or a rule — none is unaccounted for",
  order !== null && !order.rows.some((r) => r.includes("[?]")),
  order?.rows.join(" ")
);

// ------------------------------------------------------------- the separator
const sep = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("[data-title-bar-new-file]")];
  const menu = rows[0]?.closest("div.flex.flex-col");
  const node = menu?.children[1];
  if (!node || node.tagName !== "DIV") return null;
  const b = node.getBoundingClientRect();
  const pop = document.querySelector("[data-autosave-popover]");
  return {
    height: b.height,
    top: b.top,
    bottom: b.bottom,
    color: getComputedStyle(node).backgroundColor,
    popoverColor: pop ? getComputedStyle(pop).backgroundColor : ""
  };
});
check("a rule separates it from Save", sep !== null, JSON.stringify(sep));
check("the rule is a hairline", sep !== null && sep.height <= 1 && sep.height > 0, `height ${sep?.height}`);
check("the rule is visible — not the popover's own colour", sep !== null && sep.color !== sep.popoverColor, `rule ${sep?.color}, popover ${sep?.popoverColor}`);

// ---------------------------------------------------------------- the click
// The row is a canvas RESET, not a second file (`324a44c`): it clears this tab and
// asks first, because the only thing a reset can destroy is the work in it. Both
// halves are worth pinning — a confirm nobody can decline is not a confirm, and a
// reset that writes a file behind the user is the "empty the file you are looking
// at" failure the row is placed away from Save to avoid.
//
// `showSaveFilePicker` is still stubbed, to prove the reset does NOT reach for it.
await page.evaluate(() => {
  window.__pickerCalls = 0;
  globalThis.showSaveFilePicker = async () => {
    window.__pickerCalls++;
    throw new Error("the reset must not ask for a file");
  };
});

const stillPainted = () => page.evaluate(() => !!document.querySelector('[data-element-id="nf_a"]'));
const elementCount = () => page.evaluate(() => window.__FISH_BRIDGE__.getElements().length);

check("the tab holds a document to lose", (await elementCount()) === 1, `${await elementCount()} element(s)`);

// Declining has to be a real branch: Playwright dismisses dialogs by default, which
// is why an unhandled confirm reads as "the row does nothing".
page.once("dialog", (d) => d.dismiss());
await page.click("[data-title-bar-new-file]");
await idle();
check("declining the confirm leaves the document alone", (await elementCount()) === 1, `${await elementCount()} element(s)`);
check("and the element is still painted", await stillPainted(), true);

await page.click("[data-autosave-status]");
await idle();
page.once("dialog", (d) => d.accept());
await page.click("[data-title-bar-new-file]");
await idle();

const afterAccept = await elementCount();
check("accepting it clears the canvas", afterAccept === 0, `${afterAccept} element(s)`);
// The model is empty before the canvas is: one commit, one paint.
await page.waitForSelector('[data-element-id="nf_a"]', { state: "detached", timeout: 2000 }).catch(() => {});
check("and the element this tab held is gone", (await stillPainted()) === false, String(await stillPainted()));
const pickerCalls = await page.evaluate(() => window.__pickerCalls);
check("it never reaches for a file picker", pickerCalls === 0, JSON.stringify(pickerCalls));
const popoverClosed = await page.evaluate(() => !document.querySelector("[data-autosave-popover]"));
check("the popover closes behind it", popoverClosed);

check("no console errors", errors.length === 0, errors.join("\n      "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
