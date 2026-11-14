import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// A top-level instance is a slide in its own right: the deck must play it,
// resolve its master's subtree, and put it in the reading order beside frames.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const VIEW = { width: 1400, height: 900 };
const SLIDE = { width: 400, height: 300 };

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEW });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

await page.evaluate(({ slide }) => {
  const bridge = window.__FISH_BRIDGE__;
  const canvas = bridge.getDoc().canvas;
  const master = {
    id: "master",
    type: "component",
    name: "MASTER",
    x: 0,
    y: 0,
    width: slide.width,
    height: slide.height,
    fills: [{ type: "solid", color: "#1F2937" }],
    children: [
      {
        id: "badge",
        type: "rect",
        name: "badge",
        x: 20,
        y: 20,
        width: 120,
        height: 60,
        fills: [{ type: "solid", color: "#EF4444" }]
      }
    ]
  };
  const instance = {
    id: "inst1",
    type: "instance",
    name: "Instance slide",
    x: 0,
    y: 0,
    width: slide.width,
    height: slide.height,
    componentId: "master"
  };
  const frame = {
    id: "frame2",
    type: "frame",
    name: "Frame slide",
    x: 600,
    y: 0,
    width: slide.width,
    height: slide.height,
    fills: [{ type: "solid", color: "#3E63DD" }],
    children: []
  };
  bridge.setElements([instance, frame], {
    canvas: { ...canvas, width: 2000, height: 1000 },
    pages: [
      { id: "page_1", name: "Page 1", canvas, children: [] },
      { id: "page_2", name: "Page 2", canvas, children: [master] }
    ],
    activePageId: "page_1"
  });
}, { slide: SLIDE });
await page.waitForTimeout(400);

const idle = async () => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(150);
};

const state = () =>
  page.evaluate(() => {
    const stage = document.querySelector('svg[data-present-stage="true"]');
    const has = (selector) => !!stage?.querySelector(selector);
    const node = stage?.querySelector('[data-element-id="inst1"]');
    const box = node?.getBoundingClientRect();
    return {
      counter: document.querySelector("[data-present-counter]")?.textContent?.trim() ?? null,
      instance: has('[data-element-id="inst1"]'),
      instanceChild: has('[data-element-id="inst1_badge"]'),
      placeholder: has("[data-instance-placeholder]"),
      frame: has('[data-element-id="frame2"]'),
      box: box ? { width: Math.round(box.width), height: Math.round(box.height) } : null
    };
  });

await page.click("[data-present-button]");
await idle();

const first = await state();
check("the deck opens with the instance and the frame as two slides", first.counter === "1 / 2", `counter ${first.counter}`);
check("the instance slide paints the instance at its own box", first.instance && first.box?.width === SLIDE.width && first.box?.height === SLIDE.height, JSON.stringify(first.box));
check("the instance resolves its master's child", first.instanceChild && !first.placeholder, JSON.stringify(first));
check("the frame is not painted on the instance's slide", !first.frame);

await page.keyboard.press("ArrowRight");
await idle();
const second = await state();
check("the next slide is the frame", second.counter === "2 / 2" && second.frame && !second.instance, JSON.stringify(second));

check("no console errors", errors.length === 0, errors.join("\n      "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
