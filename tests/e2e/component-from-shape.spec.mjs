import { activeElements } from "./_support/doc.mjs";
import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// A component is a container, so a shape or a text can only become one by
// gaining a parent frame to hold it. The wrapper is built from the element's own
// box, and children live in LOCAL coordinates — so the drawing must not move or
// resize by a single pixel when the wrap happens, and an instance of the wrapped
// component must paint it inside the instance's own box.
//
// This drives the real editor against dist/index.html and measures the painted
// node; the arithmetic is checked against the DOM, not against the model.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail) =>
  results.push({ name, ok: !!ok, detail }) &&
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements([
      {
        id: "f_card",
        type: "frame",
        name: "Card",
        x: 200,
        y: 150,
        width: 400,
        height: 300,
        fills: [{ type: "solid", color: "#111827" }],
        clipContent: false,
        children: [
          {
            id: "r_fill",
            type: "rect",
            name: "Rectangle",
            x: 40,
            y: 60,
            width: 120,
            height: 48,
            fills: [{ type: "solid", color: "#3B82F6" }]
          },
          {
            id: "t_label",
            type: "text",
            name: "Label",
            x: 40,
            y: 140,
            width: 160,
            height: 24,
            content: "Hello",
            style: { fontFamily: "Inter", fontSize: 16, color: "#FFFFFF" }
          }
        ]
      }
    ], { canvas: { ...base.canvas, width: 3000, height: 2000 } });
});

const boxOf = (id) =>
  page.evaluate((elId) => {
    const node = document.querySelector(`[data-element-id="${elId}"]`);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, id);

const getDoc = () => page.evaluate(() => window.__FISH_BRIDGE__.getDoc());
const sameBox = (a, b) =>
  Boolean(a && b) &&
  Math.abs(a.x - b.x) < 1.5 &&
  Math.abs(a.y - b.y) < 1.5 &&
  Math.abs(a.w - b.w) < 1.5 &&
  Math.abs(a.h - b.h) < 1.5;

const before = await boxOf("r_fill");
check("the seeded rect paints", Boolean(before), JSON.stringify(before));

// --- inspector button path (the shape/text affordance) ----------------------
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("r_fill"));
await page.waitForSelector('button[title="Create Component (⌥⌘K)"]', { timeout: 5000 }).catch(() => null);
const hasButton = await page.$('button[title="Create Component (⌥⌘K)"]');
check("a selected rect offers Create Component", Boolean(hasButton));

await page.click('button[title="Create Component (⌥⌘K)"]');
await page.waitForTimeout(150);

const card = activeElements(await getDoc())[0];
const comp = card?.children?.find((el) => el.type === "component");
check("the rect's parent gained a component", Boolean(comp), JSON.stringify(card?.children?.map((e) => e.type)));
check("the wrapper frame takes the element's name", comp?.name === "Rectangle", comp?.name);
// The rect was the first child, so the wrapper takes its index — the text stays on top.
check("the wrapper lands in the element's own slot", card?.children?.[0]?.id === comp?.id, card?.children?.map((e) => e.id).join(","));
check("the element is the component's only child", comp?.children?.length === 1 && comp.children[0].id === "r_fill");
check(
  "the child is re-based into the frame's local space",
  comp?.children?.[0]?.x === 0 && comp?.children?.[0]?.y === 0,
  JSON.stringify({ x: comp?.children?.[0]?.x, y: comp?.children?.[0]?.y })
);
check(
  "the frame takes the element's box",
  comp?.x === 40 && comp?.y === 60 && comp?.width === 120 && comp?.height === 48,
  JSON.stringify({ x: comp?.x, y: comp?.y, w: comp?.width, h: comp?.height })
);
check("the wrapper is transparent and does not clip", comp?.fills === undefined && comp?.clipContent === false);

const after = await boxOf("r_fill");
check("the drawing does not move or resize on screen", sameBox(before, after), JSON.stringify({ before, after }));

// --- keyboard path with a text element --------------------------------------
const textBefore = await boxOf("t_label");
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("t_label"));
// Waiting for the button to come back proves the selection reached the app —
// otherwise the shortcut fires against the component selected a moment ago.
await page.waitForSelector('button[title="Create Component (⌥⌘K)"]', { timeout: 5000 });
await page.keyboard.press("Meta+Alt+KeyK");
await page.waitForTimeout(200);

const card2 = activeElements(await getDoc())[0];
const textComp = card2?.children?.find((el) => el.type === "component" && el.children?.[0]?.id === "t_label");
check("⌥⌘K wraps a text into a component too", Boolean(textComp), JSON.stringify(card2?.children?.map((e) => e.type)));
check("its name comes from the text", textComp?.name === "Label", textComp?.name);
const textAfter = await boxOf("t_label");
check("the text does not move on screen", sameBox(textBefore, textAfter), JSON.stringify({ textBefore, textAfter }));

// --- the wrapped master still resolves through an instance ------------------
await page.evaluate(
  (id) => {
    const bridge = window.__FISH_BRIDGE__;
    const doc = bridge.getDoc();
    bridge.setElements([
        ...bridge.getElements(),
        {
          id: "inst_probe",
          type: "instance",
          name: "Probe",
          componentId: id,
          // Exactly where the component itself sits: the clone must land on top.
          x: 240,
          y: 210,
          width: 120,
          height: 48,
          rotation: 0,
          opacity: 1,
          visible: true
        }
      ]);
  },
  comp.id
);
await page.waitForTimeout(200);
const derived = await boxOf("inst_probe_r_fill");
check("an instance paints the wrapped shape in its own box", sameBox(after, derived), JSON.stringify({ after, derived }));

// --- the instance's own section still renders, next to the same button ------
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("inst_probe"));
await page.waitForSelector('button[title="Create Component (⌥⌘K)"]', { timeout: 5000 });
check("an instance keeps its own section beside the button", Boolean(await page.$('button[title^="Detach Instance"]')));

await page.click('button[title="Create Component (⌥⌘K)"]');
await page.waitForTimeout(150);
const finalElements = activeElements(await getDoc());
check(
  "an instance can be wrapped too",
  finalElements.some((el) => el.type === "component" && el.children?.[0]?.id === "inst_probe"),
  finalElements.map((el) => el.type).join(",")
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (errors.length > 0) console.log(`page errors:\n${errors.join("\n")}`);
await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
