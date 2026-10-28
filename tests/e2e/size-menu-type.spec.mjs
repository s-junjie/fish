// The size mode menu is the only TWO-LINE menu row in the shell, so it cannot
// wear MENU_ITEM_CLASS (which pins h-[26px] and holds one line) and spells its
// own. This asserts the four things that spell cannot be trusted to keep:
//
//   1. family — DESIGN.md §Typography reserves sans for "prose, and menu items";
//      a mono name and a mono note is what this menu shipped with.
//   2. two RANKS — §The label tiers separates tiers by SIZE as well as colour.
//      Name and note were both text-ui, so they differed only by ink.
//   3. the armed row — §The one menu: `text-brand` at rest. It was `bg-rule`.
//   4. the checkmark — brand ink on the brand hover fill, per §The one menu's
//      note that brand text on a brand fill is invisible.
//
// Measured off the rendered box, not off the class strings: a class can name a
// token the stylesheet never emitted (LESSONS §31), and only a computed style
// proves it reached the screen.
import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

// A text element INSIDE a frame, so the menu opens with real options rather
// than three disabled ones: a loose rect makes fill and max-content refusable,
// and a menu of refusals is not the menu this spec is about.
await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements([
      {
        id: "F1",
        type: "frame",
        name: "Frame",
        x: 200,
        y: 200,
        width: 420,
        height: 300,
        fills: [{ type: "solid", color: "#101010" }],
        children: [
          { id: "T1", type: "text", name: "T1", x: 20, y: 20, width: 200, height: 24, text: "Sizing" }
        ]
      }
    ]);
});
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("T1"));
await page.waitForSelector('[data-inspector-section="size"]');

/**
 * Open the width menu by clicking the caret inside the W well.
 *
 * The well holds two titled buttons — the number-token picker and, after it,
 * the mode caret (`trailing` renders last). The caret is the one that opens the
 * menu; `button[title]` first is the token door.
 */
const openWidthMenu = async () => {
  const caret = page.locator('[data-inspector-section="size"] [data-scrub-field="W"] ~ button[title]').last();
  await caret.click();
  await page.waitForSelector('button:has-text("Max Content")');
};

await openWidthMenu();

/**
 * The rows, read off their own DOM structure: children[0] is the name line
 * (name + optional check), children[1] the note. Selected positionally rather
 * than by `:last-child`, which silently matched the NAME span on any row with
 * no checkmark — the probe measured the wrong element and reported a pass/fail
 * about the wrong thing.
 */
const readRows = () =>
  page.evaluate(() => {
    const cs = (el) => {
      const s = getComputedStyle(el);
      return { fontFamily: s.fontFamily, fontSize: s.fontSize, letterSpacing: s.letterSpacing, color: s.color };
    };
    // Scoped to the SIZE section. Unscoped, this shape also matches the title
    // bar's dropdown rows, so the probe measured those and reported their type.
    const size = document.querySelector('[data-inspector-section="size"]');
    if (!size) return [];
    return [...size.querySelectorAll("button")]
      .filter((b) => b.children.length === 2 && b.children[1] instanceof HTMLSpanElement)
      .map((b) => {
        const nameLine = b.children[0];
        const note = b.children[1];
        const rowStyle = getComputedStyle(b);
        return {
          name: nameLine.children[0].textContent.trim(),
          armed: !!nameLine.querySelector("svg"),
          disabled: b.disabled,
          nameStyle: cs(nameLine.children[0]),
          noteStyle: cs(note),
          noteText: note.textContent.trim(),
          rowHeight: b.getBoundingClientRect().height,
          rowTransition: rowStyle.transitionProperty,
          rowBg: rowStyle.backgroundColor,
          cursor: rowStyle.cursor
        };
      });
  });

const rows = await readRows();

check("the size menu opened with four options", rows.length === 4, `got ${rows.length}`);

const armed = rows.find((r) => r.armed);
check("exactly one option is armed", !!armed && rows.filter((r) => r.armed).length === 1, JSON.stringify(rows.map((r) => [r.name, r.armed])));

if (armed) {
  const isSans = (f) => /system-ui|-apple-system|Segoe UI|Roboto|Helvetica|Arial/i.test(f);
  const isMono = (f) => /mono|Menlo|Consolas|Courier/i.test(f);

  // 1. Family. Computed, so a `font-sans` that never emitted still fails here.
  check("the option name speaks sans, not mono", isSans(armed.nameStyle.fontFamily) && !isMono(armed.nameStyle.fontFamily), armed.nameStyle.fontFamily);
  check("the note speaks sans, not mono", isSans(armed.noteStyle.fontFamily) && !isMono(armed.noteStyle.fontFamily), armed.noteStyle.fontFamily);

  // 2. Two ranks. §The label tiers: size separates the tiers, not colour alone.
  const namePx = parseFloat(armed.nameStyle.fontSize);
  const notePx = parseFloat(armed.noteStyle.fontSize);
  check("the note is a step below the name", notePx < namePx, `name ${namePx}px, note ${notePx}px`);
  check("the note is on the theme's scale, not a stock size", namePx === 12 && notePx === 10.5, `name ${namePx}px (text-ui), note ${notePx}px (text-row)`);
  check("the note is real text, not an ellipsis", armed.noteText.length > 0 && armed.noteText !== "...", armed.noteText);

  // A two-line row, so the 26px one-line metric must NOT apply — asserted as
  // "grew past it" rather than an exact px, since the note may wrap or not
  // depending on the panel width.
  check("the row is taller than a one-line menu row", armed.rowHeight > 26, `${armed.rowHeight.toFixed(1)}px`);

  // 3. The armed row wears brand TEXT (§The one menu), not a `bg-rule` slab.
  check("the armed row's name is brand amber", /^rgb\(232, 163, 61\)$/.test(armed.nameStyle.color), armed.nameStyle.color);
  check("the armed row paints no fill of its own", /0, 0, 0, 0|transparent/.test(armed.rowBg), armed.rowBg);

  // 4. No transition — §The one menu: the pointer is already over the landed row.
  check("the row does not transition on hover", /^(none|all)$/.test(armed.rowTransition), armed.rowTransition);
}

// Every option keeps a note; a mode that cannot apply says why in coral rather
// than vanishing (size-modes.ts), and that reason is the reason the row is listed.
check("every option carries a note", rows.every((r) => r.noteText.length > 0), JSON.stringify(rows.map((r) => r.noteText)));
for (const r of rows.filter((x) => x.disabled)) {
  check(`"${r.name}" is disabled and says why in coral`, /^rgba?\(255, 83, 83/.test(r.noteStyle.color), r.noteStyle.color);
  check(`"${r.name}" is not offered as pickable`, r.cursor === "not-allowed", r.cursor);
}

check("no page errors", errors.length === 0, errors.join("; "));

await browser.close();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);