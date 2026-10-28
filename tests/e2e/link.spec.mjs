import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// A layer link, measured where it matters: the three surfaces that open it, and
// the one that must not.
//
//   1. the editor      — a linked layer is marked in the DOM and in the layers
//                        panel, and a click SELECTS it instead of navigating
//   2. presentation    — a click on a linked layer opens it and does NOT advance
//                        the deck, while a click beside it still does
//   3. ?view=canvas    — the embed is a viewing surface, so links are live there
//   4. the SVG export  — the marker becomes a real `<a target="_blank">`
//   5. the inspector   — a URL commits, a non-URL is refused without writing
//
// `window.open` is stubbed before the app loads, so "did it navigate" is answered
// by a recorded call rather than by a tab.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const VIEW = { width: 1600, height: 1000 };
const LINK = "https://example.com/pricing";

const ELEMENTS = [
  {
    id: "f_one",
    type: "frame",
    name: "Slide One",
    x: 0,
    y: 0,
    width: 600,
    height: 400,
    fills: [{ type: "solid", color: "#FFFFFF" }],
    children: [
      {
        id: "btn_link",
        type: "rect",
        name: "Linked",
        x: 40,
        y: 40,
        width: 240,
        height: 100,
        link: LINK,
        fills: [{ type: "solid", color: "#3E63DD" }]
      },
      {
        id: "btn_plain",
        type: "rect",
        name: "Plain",
        x: 40,
        y: 220,
        width: 240,
        height: 100,
        fills: [{ type: "solid", color: "#30A46C" }]
      }
    ]
  },
  {
    id: "f_two",
    type: "frame",
    name: "Slide Two",
    x: 700,
    y: 0,
    width: 600,
    height: 400,
    fills: [{ type: "solid", color: "#0D0D0D" }]
  },
  {
    // Top level, so it is not a slide: the editor and the canvas-only view show
    // the whole page, and this is the layer they click.
    id: "r_out_link",
    type: "rect",
    name: "Outside Linked",
    x: 0,
    y: 480,
    width: 200,
    height: 120,
    link: LINK,
    fills: [{ type: "solid", color: "#AB4ABA" }]
  },
  {
    id: "r_out_plain",
    type: "rect",
    name: "Outside Plain",
    x: 260,
    y: 480,
    width: 200,
    height: 120,
    fills: [{ type: "solid", color: "#F76B15" }]
  }
];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const browser = await chromium.launch();
const stubOpen = () => {
  window.__opened = [];
  window.open = (url) => {
    window.__opened.push(String(url));
    return null;
  };
};

const openUrl = (page) => page.evaluate(() => window.__opened.slice());

const seed = (page) =>
  page.evaluate((elements) => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 1920, height: 1080 } });
  }, ELEMENTS);

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const idle = async (page) => {
  await settle(page);
  await page.waitForTimeout(150);
  await settle(page);
};

/** Centre of a painted node, scoped so the editor's copy is never confused with
 *  the slide's — both are in the document while the deck is open. */
const centreIn = (page, scope, id) =>
  page.evaluate(
    ({ scope: s, id: elId }) => {
      const root = s ? document.querySelector(s) : document.body;
      const nodes = [...root.querySelectorAll(`[data-element-id="${CSS.escape(elId)}"]`)];
      const n = s === "[data-present-stage]" ? nodes[0] : nodes.find((x) => !x.closest("[data-present-stage]"));
      if (!n) return null;
      const b = n.getBoundingClientRect();
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    },
    { scope, id }
  );

const attr = (page, scope, id, name) =>
  page.evaluate(
    ({ scope: s, id: elId, name: attrName }) => {
      const root = s ? document.querySelector(s) : document.body;
      const nodes = [...root.querySelectorAll(`[data-element-id="${CSS.escape(elId)}"]`)];
      const n = s === "[data-present-stage]" ? nodes[0] : nodes.find((x) => !x.closest("[data-present-stage]"));
      return n ? n.getAttribute(attrName) : null;
    },
    { scope, id, name }
  );

const linkInDoc = (page, id) =>
  page.evaluate((elId) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const walk = (list) => {
      for (const el of list) {
        if (el.id === elId) return el;
        if (el.children) {
          const hit = walk(el.children);
          if (hit) return hit;
        }
      }
      return null;
    };
    const el = walk(doc.pages.find((p) => p.id === doc.activePageId).children);
    return el ? el.link ?? null : null;
  }, id);

// ---------------------------------------------------------------- the editor
const page = await browser.newPage({ viewport: VIEW });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.addInitScript(stubOpen);
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
await seed(page);
await idle(page);

check(
  "a linked layer is marked with its URL",
  (await attr(page, null, "r_out_link", "data-link")) === LINK,
  `got ${await attr(page, null, "r_out_link", "data-link")}`
);
check(
  "an unlinked layer carries no marker at all",
  (await attr(page, null, "r_out_plain", "data-link")) === null,
  `got ${await attr(page, null, "r_out_plain", "data-link")}`
);
check(
  "the layers panel shows which rows link out",
  await page.evaluate(() => {
    const panel = document.querySelector('[data-ui-panel="left"]');
    return !!panel?.querySelector('[data-layer-link="r_out_link"]') && !panel?.querySelector('[data-layer-link="r_out_plain"]');
  })
);

const editorCentre = await centreIn(page, null, "r_out_link");
await page.mouse.click(editorCentre.x, editorCentre.y);
await idle(page);
check(
  "the editor selects a linked layer instead of navigating",
  (await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds().join(","))) === "r_out_link" &&
    (await openUrl(page)).length === 0,
  `selected ${await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds().join(","))}, opened ${JSON.stringify(await openUrl(page))}`
);

// ------------------------------------------------------------- presentation
await page.click("[data-present-button]");
await idle(page);

check(
  "the deck paints the linked layer",
  (await attr(page, "[data-present-stage]", "btn_link", "data-link")) === LINK,
  `got ${await attr(page, "[data-present-stage]", "btn_link", "data-link")}`
);
check(
  "a live link reads as clickable in a viewing surface",
  (await page.evaluate(() => {
    const n = document.querySelector('[data-present-stage] [data-element-id="btn_link"]');
    return n ? getComputedStyle(n).cursor : null;
  })) === "pointer"
);

const counter = () =>
  page.evaluate(() => {
    const n = document.querySelector("[data-present-counter]");
    return n ? n.textContent.trim() : null;
  });

const slideCentre = await centreIn(page, "[data-present-stage]", "btn_link");
await page.mouse.click(slideCentre.x, slideCentre.y);
await idle(page);
check(
  "clicking a link opens it in a new tab",
  (await openUrl(page)).join(",") === LINK,
  `opened ${JSON.stringify(await openUrl(page))}`
);
check("and the deck does not advance on it", (await counter()) === "1 / 2", `got ${await counter()}`);

await page.evaluate(() => (window.__opened = []));
const plainCentre = await centreIn(page, "[data-present-stage]", "btn_plain");
await page.mouse.click(plainCentre.x, plainCentre.y);
await idle(page);
check("clicking off a link still advances", (await counter()) === "2 / 2", `got ${await counter()}`);
check("and opened nothing", (await openUrl(page)).length === 0, JSON.stringify(await openUrl(page)));
await page.keyboard.press("Escape");
await idle(page);

// ------------------------------------------------------------- the SVG export
const svg = await page.evaluate(() => window.__fish.exportCanvasSvg());
check(
  "the export turns the marker into a real anchor",
  svg.includes(`<a href="${LINK}"`) && svg.includes('target="_blank"'),
  `anchor present: ${svg.includes("<a href=")}`
);
check(
  "the anchor wraps the layer rather than replacing it",
  /<a [^>]*>\s*<g [^>]*data-element-id="r_out_link"/.test(svg),
  "the linked group is not a child of the anchor"
);
check("the marker itself is gone from the file", !svg.includes("data-link="));

// ------------------------------------------------------- normalized on load
const normalized = await page.evaluate(() =>
  window.__fish.normalize({
    version: "0.1",
    canvas: { width: 100, height: 100, unit: "px" },
    activePageId: "p1",
    pages: [
      {
        id: "p1",
        name: "Page 1",
        canvas: { width: 100, height: 100, unit: "px" },
        children: [
          { id: "a", type: "rect", x: 0, y: 0, width: 10, height: 10, href: "example.com" },
          { id: "b", type: "rect", x: 0, y: 0, width: 10, height: 10, link: "javascript:alert(1)" }
        ]
      }
    ]
  })
);
check(
  "a bare host is absorbed and read as https",
  normalized.document.pages[0].children[0].link === "https://example.com/",
  `got ${JSON.stringify(normalized.document.pages[0].children[0].link)}`
);
check(
  "an unsupported scheme is refused, and said so",
  normalized.document.pages[0].children[1].link === undefined &&
    normalized.repairs.some((r) => r.path === "/pages/0/children/1/link"),
  `link ${JSON.stringify(normalized.document.pages[0].children[1].link)}, repairs ${JSON.stringify(normalized.repairs.map((r) => r.path))}`
);

// ----------------------------------------------------------- the inspector
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("r_out_plain"));
await idle(page);
check(
  "the inspector offers a link field for the selection",
  await page.evaluate(() => !!document.querySelector('[data-ui-panel="right"] [data-link-input]'))
);

await page.fill('[data-ui-panel="right"] [data-link-input]', "https://fish.example/docs");
// `page.press(selector, …)` mis-parses this attribute selector; `fill` focuses the
// field, so the Enter goes to it off the keyboard instead.
await page.keyboard.press("Enter");
await idle(page);
check(
  "a typed URL is committed",
  (await linkInDoc(page, "r_out_plain")) === "https://fish.example/docs",
  `got ${JSON.stringify(await linkInDoc(page, "r_out_plain"))}`
);

await page.fill('[data-ui-panel="right"] [data-link-input]', "not a url");
await page.keyboard.press("Enter");
await idle(page);
const hint = await page.evaluate(() => {
  const panel = document.querySelector('[data-ui-panel="right"]');
  return panel ? panel.textContent.includes("Not a link") : false;
});
check(
  "a non-URL is refused and the stored link is left alone",
  hint && (await linkInDoc(page, "r_out_plain")) === "https://fish.example/docs",
  `hint ${hint}, stored ${JSON.stringify(await linkInDoc(page, "r_out_plain"))}`
);

// ------------------------------------------------------------- ?view=canvas
const canvasPage = await browser.newPage({ viewport: VIEW });
canvasPage.on("pageerror", (e) => errors.push(`[canvas] ${String(e)}`));
canvasPage.on("console", (m) => {
  if (m.type() === "error") errors.push(`[canvas] ${m.text()}`);
});
await canvasPage.addInitScript(stubOpen);
await canvasPage.goto(`${pathToFileURL(html).href}?view=canvas`);
await canvasPage.waitForFunction(() => !!window.__FISH_BRIDGE__);
await seed(canvasPage);
await idle(canvasPage);

check(
  "the embed is a viewing surface, so the marker is painted there too",
  (await attr(canvasPage, null, "r_out_link", "data-link")) === LINK
);
const embedCentre = await centreIn(canvasPage, null, "r_out_link");
await canvasPage.mouse.click(embedCentre.x, embedCentre.y);
await idle(canvasPage);
check(
  "clicking a link in the embed opens it",
  (await openUrl(canvasPage)).join(",") === LINK,
  `opened ${JSON.stringify(await openUrl(canvasPage))}`
);
await canvasPage.evaluate(() => (window.__opened = []));
const embedPlain = await centreIn(canvasPage, null, "r_out_plain");
await canvasPage.mouse.click(embedPlain.x, embedPlain.y);
await idle(canvasPage);
check(
  "and a click off a link opens nothing",
  (await openUrl(canvasPage)).length === 0,
  JSON.stringify(await openUrl(canvasPage))
);

check("no console errors", errors.length === 0, errors.join("\n      "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0 || errors.length > 0) process.exit(1);
