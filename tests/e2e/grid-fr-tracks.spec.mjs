import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// The `fr` track editor, from the panel's own controls.
//
// `grid-tracks-and-cells.spec.mjs` covers reachability and geometry; what is
// new here is the unit affordance and the numbers each unit takes: a weight
// moves in tenths and cannot reach 0, a pixel track cannot either, and choosing
// `Tracks` writes shares rather than the px numbers that only looked equal.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const ELEMENTS = [
  {
    id: "G",
    type: "frame",
    name: "Grid",
    x: 300,
    y: 200,
    width: 400,
    height: 300,
    fills: [{ type: "solid", color: "#1E1E1E" }],
    display: "grid",
    "grid-template-columns": 2,
    gap: 0,
    padding: 0,
    children: [
      {
        id: "a",
        type: "rect",
        name: "A",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        fills: [{ type: "solid", color: "#30A46C" }],
      },
      {
        id: "b",
        type: "rect",
        name: "B",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        fills: [{ type: "solid", color: "#3E63DD" }],
      },
    ],
  },
];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`,
  );
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
await page.evaluate((elements) => {
  const b = window.__FISH_BRIDGE__;
  const base = b.getDoc();
  b.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 4000, height: 3000 } });
}, ELEMENTS);
await page.waitForTimeout(500);
const settle = () =>
  page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("G"));
await settle();
await page.waitForTimeout(200);

const docEl = async (id) =>
  page.evaluate((elId) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const els = JSON.parse(
      JSON.stringify(doc.pages.find((p) => p.id === doc.activePageId).children),
    );
    return els.find((e) => e.id === elId) ?? null;
  }, id);
const tracks = async () => (await docEl("G"))["grid-template-columns"];
const unitButtons = () =>
  page.locator('[data-stack-tracks="column"] [data-stack-track-unit]');

// ------------------------------------------------------- the unit says it is a control
await page.locator('[data-stack-tracks-mode="column-custom"]').click();
await settle();
await page.waitForTimeout(200);
check(
  "choosing Tracks writes SHARES, not the px numbers that only looked equal",
  JSON.stringify(await tracks()) === JSON.stringify([{ fr: 1 }, { fr: 1 }]),
  JSON.stringify(await tracks()),
);

// Two fields per row: at three, a track's well was ~90px and its unit menu needs
// 216, so the menu that names what `fr` means had nowhere to go.
const boxes = await page.evaluate(() =>
  Array.from(
    document.querySelectorAll(
      '[data-stack-tracks="column"] input[data-scrub-field]',
    ),
  ).map((n) => {
    const b =
      n.closest("label, div")?.getBoundingClientRect() ??
      n.getBoundingClientRect();
    return {
      x: Math.round(b.left),
      y: Math.round(b.top),
      w: Math.round(b.width),
    };
  }),
);
check(
  "two tracks per row, and the fields are wide enough for the unit menu beside them",
  boxes.length === 2 && boxes[0].y === boxes[1].y && boxes[0].w >= 120,
  JSON.stringify(boxes),
);

const caret = await page.evaluate(() => {
  const b = document.querySelector("[data-stack-track-unit]");
  return {
    tag: b.tagName,
    svgs: b.querySelectorAll("svg").length,
    text: b.textContent.trim(),
    expanded: b.getAttribute("aria-expanded"),
  };
});
check(
  "the unit carries a caret and announces itself as a menu, not a suffix",
  caret.tag === "BUTTON" && caret.svgs === 1 && caret.expanded === "false",
  JSON.stringify(caret),
);

await page
  .locator('[data-stack-tracks="column"] [data-stack-track-unit]')
  .first()
  .click();
await settle();
await page.waitForTimeout(200);
const menu = await page.evaluate(() => {
  const m = document.querySelector("[data-track-unit-menu]");
  if (!m) return null;
  const b = m.getBoundingClientRect();
  const panel = document
    .querySelector('[data-ui-panel="right"]')
    .getBoundingClientRect();
  return {
    options: Array.from(m.querySelectorAll("[data-track-unit-option]")).map(
      (n) => ({
        unit: n.getAttribute("data-track-unit-option"),
        text: n.textContent.trim(),
        checked: n.querySelectorAll("svg").length,
      }),
    ),
    width: Math.round(b.width),
    insidePanel: b.right <= panel.right + 1 && b.left >= panel.left - 1,
  };
});
check(
  "the unit opens a menu of the two spellings, the current one ticked",
  menu &&
    menu.options.length === 2 &&
    menu.options.find((o) => o.unit === "fr")?.checked === 1,
  JSON.stringify(menu),
);
check(
  "and the menu explains both units in the size menu's own option row",
  menu &&
    menu.options.every((o) => o.text.replace(o.unit, "").trim().length > 10),
  JSON.stringify(menu?.options),
);
check(
  "the menu stays inside the panel even on the left-hand field",
  menu && menu.insidePanel && menu.width >= 200,
  JSON.stringify(menu),
);
// Closed by pressing the same button again rather than Escape: Escape is the
// app's global "leave what you are in", and this probe is about the menu, not
// about which shortcut also ends a selection.
await page.locator('[data-stack-tracks="column"] [data-stack-track-unit]').first().click();
await settle();
await page.waitForTimeout(250);
check("pressing the unit again closes the menu and changes nothing",
  (await page.locator("[data-track-unit-menu]").count()) === 0 &&
    JSON.stringify(await tracks()) === JSON.stringify([{ fr: 1 }, { fr: 1 }]),
  JSON.stringify(await tracks()));

// ------------------------------------------------------------------- weights
const weightField = page.locator(
  '[data-stack-tracks="column"] input[data-scrub-field="1"]',
);
await weightField.fill("2");
await weightField.press("Enter");
await settle();
await page.waitForTimeout(200);
const twoOne = await docEl("G");
check(
  "a weight of 2 against a weight of 1 gives 2:1 of the frame",
  JSON.stringify(twoOne["grid-template-columns"]) ===
    JSON.stringify([{ fr: 2 }, { fr: 1 }]) &&
    Math.round(twoOne.children[0].width) === 267 &&
    Math.round(twoOne.children[1].width) === 133,
  `sizes=${JSON.stringify(twoOne["grid-template-columns"])} widths=${twoOne.children.map((c) => Math.round(c.width)).join(",")}`,
);

// The scrub step, measured by dragging the handle rather than typing.
const label = page.locator(
  '[data-stack-tracks="column"] [data-scrub-label="2"]',
);
const lb = await label.boundingBox();
const before = Number(
  await page
    .locator('[data-stack-tracks="column"] input[data-scrub-field="2"]')
    .inputValue(),
);
await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
await page.mouse.down();
await page.mouse.move(lb.x + lb.width / 2 + 5, lb.y + lb.height / 2, {
  steps: 5,
});
await page.mouse.up();
await settle();
await page.waitForTimeout(200);
const after = Number(
  await page
    .locator('[data-stack-tracks="column"] input[data-scrub-field="2"]')
    .inputValue(),
);
check(
  "dragging a weight moves it in TENTHS, not whole units",
  Math.abs(after - before - 0.5) < 0.001,
  `${before} → ${after} after a 5px drag`,
);

// ------------------------------------------------------------------- the floors
const floor = async (index) => {
  const f = page.locator(
    `[data-stack-tracks="column"] input[data-scrub-field="${index}"]`,
  );
  await f.fill("-5");
  await f.press("Enter");
  await settle();
  await page.waitForTimeout(150);
  return f.inputValue();
};
const frFloor = await floor(1);
check(
  "a weight cannot be driven below 0.1",
  frFloor === "0.1",
  `field shows ${frFloor}`,
);

const beforeFreeze = await docEl("G");
const wasThisTrackPx = Math.round(beforeFreeze.children[0].width);
await page
  .locator('[data-stack-tracks="column"] [data-stack-track-unit]')
  .first()
  .click();
await settle();
await page
  .locator('[data-stack-tracks="column"] [data-track-unit-option="px"]')
  .first()
  .click();
await settle();
await page.waitForTimeout(250);
const frozen = await tracks();
check(
  "switching one track to px freezes it at the size it resolves to, so nothing moves",
  typeof frozen[0] === "number" && Math.round(frozen[0]) === wasThisTrackPx,
  `froze at ${JSON.stringify(frozen[0])} against a painted ${wasThisTrackPx}px`,
);
const pxFloor = await floor(1);
check(
  "and a pixel track cannot be driven to 0 — the engine floors cells at 1px",
  Number(pxFloor) >= 1,
  `field shows ${pxFloor}`,
);

// ------------------------------------------------------------- the readout titles
const titles = await page.evaluate(() =>
  Array.from(
    document.querySelectorAll(
      '[data-stack-tracks="column"] input[data-scrub-field]',
    ),
  ).map((n) => n.closest("[title]")?.getAttribute("title") ?? ""),
);
check(
  "each field says what its number means — a weight names the px it is right now",
  titles.some((t) => /\d+(\.\d+)?px right now\./.test(t)) &&
    titles.some((t) => /\d+px at every frame width\./.test(t)),
  JSON.stringify(titles),
);

await page
  .locator('[data-ui-panel="right"]')
  .screenshot({ path: "/tmp/shot-fr-tracks.png" });
await browser.close();
if (errors.length) {
  console.log("--- page errors ---");
  errors.slice(0, 6).forEach((e) => console.log("  " + e));
}
const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length === 0 ? "ALL CHECKS PASS" : `${failed.length} CHECK(S) FAILED`}\n`,
);
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
