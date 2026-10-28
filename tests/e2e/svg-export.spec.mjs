import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// The vector export is the one output a user opens in another tool, so it is
// the one that has to be clean rather than merely correct. Two things go wrong
// quietly: a camelCase property that never became an attribute, which paints
// nothing and reports no error, and editor chrome that a raster hid and a file
// does not — the transparent click target under every element, the workbench's
// Tailwind classes on the root.
//
//   1. fill-rule  — a donut has to survive as a hole, in the DOM and in the file
//   2. no chrome  — the hit targets and the root class are gone from the export
//   3. no default — a path that did not ask for a rule does not carry one
//
// The camelCase → dashed attribute mapping lives in `preact/compat`'s global
// `options` hook, so it can only be checked here: importing compat into a unit
// test rewrites the props of every vnode in the process, and the vitest config
// runs with `isolate: false`. See `tests/fill-rule.test.ts`.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const pageErrors = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

const candidate = {
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: 400, height: 400 },
      children: [
        {
          id: "donut",
          type: "path",
          name: "Donut",
          x: 20,
          y: 20,
          width: 120,
          height: 120,
          d: "M 60 0 A 60 60 0 1 0 60 120 A 60 60 0 1 0 60 0 Z M 60 30 A 30 30 0 1 1 60 90 A 30 30 0 1 1 60 30 Z",
          fillRule: "evenodd",
          fills: [{ type: "solid", color: "#E8E8E8" }]
        },
        {
          id: "plain",
          type: "path",
          name: "Plain",
          x: 200,
          y: 20,
          width: 120,
          height: 120,
          d: "M 0 0 H 120 V 120 H 0 Z",
          fills: [{ type: "solid", color: "#E8E8E8" }]
        },
        {
          id: "outline",
          type: "path",
          name: "Outline",
          x: 20,
          y: 200,
          width: 24,
          height: 24,
          d: "M 18 6 L 6 18 L 6 6 L 18 18 Z",
          strokes: [{ color: "#FFFFFF", width: 2, cap: "round", join: "round" }]
        },
        /* A top-level frame is what carries the canvas's painted chrome — the
           `data-chrome-counter` group the zoom variable is written onto — so the
           "no canvas chrome" check below has something to find. Without it the
           assertion would pass against a document that never had chrome. */
        {
          id: "card",
          type: "frame",
          name: "Card",
          x: 200,
          y: 200,
          width: 160,
          height: 120,
          fills: [{ type: "solid", color: "#101010" }],
          children: [
            {
              id: "dot",
              type: "ellipse",
              name: "Dot",
              x: 20,
              y: 20,
              width: 40,
              height: 40,
              fills: [{ type: "solid", color: "#E8E8E8" }]
            }
          ]
        }
      ]
    }
  ],
  activePageId: "p1"
};

const out = await page.evaluate(async (doc) => {
  const normalized = window.__fish.normalize(doc);
  window.__FISH_BRIDGE__.applyDoc(normalized.document);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))));

  const one = (id) => document.querySelector(`[data-element-id="${id}"]`);
  const paths = (id) => [...one(id).querySelectorAll("path")];
  const svg = await window.__fish.exportCanvasSvg({ scale: 1 });
  return {
    repairs: normalized.repairs,
    donutFillRules: paths("donut").map((p) => p.getAttribute("fill-rule")),
    plainFillRules: paths("plain").map((p) => p.getAttribute("fill-rule")),
    donutComputed: getComputedStyle(paths("donut")[0]).fillRule,
    plainComputed: getComputedStyle(paths("plain")[0]).fillRule,
    // The first stroked path under an element is the transparent click target,
    // which carries no cap — the painted one is the stroke itself.
    strokeLinecap: document
      .querySelector('[data-element-id="outline"] path[stroke]:not([stroke="transparent"])')
      ?.getAttribute("stroke-linecap"),
    svg
  };
}, candidate);

// The candidate has no top-level canvas, so normalize always reports that one;
// what matters is that it says nothing about the property under test.
const propertyRepairs = out.repairs.filter((r) => /fillRule/.test(r.path) || /fillRule/i.test(r.message));
check(
  "no repair for a property the engine implements",
  propertyRepairs.length === 0,
  JSON.stringify(propertyRepairs)
);
check(
  "the hole is cut on canvas",
  out.donutComputed === "evenodd",
  `computed fill-rule: ${out.donutComputed}`
);
check(
  "a path that did not ask for a rule does not carry one",
  out.plainComputed === "nonzero" && out.plainFillRules.every((v) => v === null),
  `plain: computed ${out.plainComputed}, attributes ${JSON.stringify(out.plainFillRules)}`
);
check(
  "the hole reaches the hit target, or clicking a donut's middle selects nothing",
  out.donutFillRules.length > 0 && out.donutFillRules.every((v) => v === "evenodd"),
  JSON.stringify(out.donutFillRules)
);
check("camelCase props still land as SVG attributes", out.strokeLinecap === "round", String(out.strokeLinecap));

check(
  "the export carries the rule",
  /fill-rule="evenodd"/.test(out.svg),
  `${(out.svg.match(/fill-rule="evenodd"/g) || []).length} occurrence(s)`
);
check("the export is a single root element", out.svg.trim().startsWith("<svg") && out.svg.trim().endsWith("</svg>"));
check("the export names its own box", /viewBox="0 0 400 400"/.test(out.svg));
check(
  "the export carries no editor chrome",
  !/data-hit|pointer-events|class=/.test(out.svg),
  (out.svg.match(/data-hit|pointer-events|class=/g) || []).join(",") || "clean"
);
check("the export has no invisible paint layers left behind", !/fill="transparent"/.test(out.svg));
// The canvas's own painted chrome (`LIVE_CHROME_SELECTOR`) rides the zoom
// variable, so leaving it in ships the editor's viewport state — a
// `--fish-zoom` and the pan offsets, inside a file that has no canvas. This
// check exists because the export's delete-list and the canvas's chrome list
// were spelled separately and drifted apart; both now read one constant.
check(
  "the export carries no canvas chrome",
  !/data-chrome-counter|data-component-set-outline|data-instance-placeholder|--fish-zoom/.test(out.svg),
  (out.svg.match(/data-chrome-counter|data-component-set-outline|data-instance-placeholder|--fish-zoom/g) || []).join(",") ||
    "clean"
);
check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
