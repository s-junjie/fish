import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// Text inside a component instance is the one thing the PNG export used to drop
// silently, and silently is what made it survive: the canvas paints text as HTML
// in a `foreignObject`, a browser refuses to lay out a `foreignObject` when the
// SVG is loaded as an `<img>`, so the exporter re-implements the layout as SVG
// `<text>`. It used to take the run's box from the design document — and an
// instance's children are painted under derived ids (`<instanceId>_<masterNodeId>`)
// that the document tree never mints, so every lookup missed and the run was
// deleted. Half the interface simply was not in the exported file.
//
// Two distinct paths reach the bug, and both are asserted here:
//   1. whole-canvas export — the text conversion itself
//   2. selection export   — the `allowedElementIds` filter, which enumerated the
//      selection from the document tree and so also deleted instance children
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok: !!ok });
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

const RUNS = ["Leasing tab", "Buy tab", "9:41", "Seller's Description", "39%"];
// The master paints the same strings as its instance, so an unoverridden run
// cannot tell the two apart and the check would pass on a run that only the
// master contributed. `OVERRIDDEN_INST` is the instance's own copy of the run the
// instance overrode: it exists nowhere else on the canvas.
const OVERRIDDEN_INST = "10:08";

const out = await page.evaluate(async (RUNS) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements([
      {
        id: "master",
        type: "component",
        name: "Screen",
        x: 40,
        y: 40,
        width: 320,
        height: 200,
        fills: [{ type: "solid", color: "#1F2937" }],
        clipContent: false,
        children: RUNS.map((content, i) => ({
          id: `run-${i}`,
          type: "text",
          name: `run-${i}`,
          x: 16,
          y: 16 + i * 32,
          width: 280,
          height: 28,
          content,
          style: { fontSize: 18, fontFamily: "Inter, sans-serif", fontWeight: 500, color: "#FFFFFF" }
        }))
      },
      {
        id: "inst",
        type: "instance",
        name: "Screen copy",
        componentId: "master",
        x: 500,
        y: 40,
        width: 320,
        height: 200,
        overrides: [{ targetId: "run-2", property: "content", value: "10:08" }]
      },
      {
        id: "loose",
        type: "text",
        name: "loose",
        x: 40,
        y: 320,
        width: 280,
        height: 28,
        content: "outside the component",
        style: { fontSize: 18, fontFamily: "Inter, sans-serif", color: "#FFFFFF" }
      }
    ], { canvas: { ...base.canvas, width: 1200, height: 600 } });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))));

  const tspanStrings = (markup) =>
    Array.from(new DOMParser().parseFromString(markup, "image/svg+xml").querySelectorAll("tspan"))
      .map((t) => (t.textContent || "").trim())
      .filter(Boolean);

  // What ExportSection builds for a selected element: the selected id plus every
  // id the document tree says is under it — which, for an instance, is none.
  const whole = await window.__fish.exportCanvasSvg({ scale: 1 });
  const selection = await window.__fish.exportCanvasSvg({ scale: 1, allowedElementIds: new Set(["inst"]) });

  return {
    whole: tspanStrings(whole),
    selection: tspanStrings(selection),
    wholeHasForeignObject: /<foreignObject/.test(whole),
    painted: Array.from(document.querySelectorAll("svg foreignObject"))
      .map((fo) => (fo.firstElementChild?.textContent || "").trim())
      .filter(Boolean)
  };
}, RUNS);

// The instance's own copy of the overridden run. If this string is in the export,
// the run came from inside the instance: the master is the only other thing on
// the canvas that paints text, and it paints the pre-override content.
const missingWhole = [OVERRIDDEN_INST].filter((t) => !out.whole.includes(t));
const missingSelection = [OVERRIDDEN_INST].filter((t) => !out.selection.includes(t));

check(
  "the instance's own text copy reaches the whole-canvas export",
  missingWhole.length === 0,
  missingWhole.length ? `missing ${JSON.stringify(missingWhole)}` : `"${OVERRIDDEN_INST}"`
);
check(
  "the instance's own text copy survives a selection export of that instance",
  missingSelection.length === 0,
  missingSelection.length ? `missing ${JSON.stringify(missingSelection)}` : `"${OVERRIDDEN_INST}"`
);
check(
  "a selection export keeps the master it selected, not the master's own node",
  out.selection.includes("Leasing tab"),
  `${out.selection.length} run(s) in the selection export`
);
check(
  "a selection export drops what was not selected",
  !out.selection.includes("outside the component"),
  "the loose text run is correctly excluded"
);
check(
  "the export contains no foreignObject the rasterizer would refuse to lay out",
  !out.wholeHasForeignObject
);
check("the canvas actually painted every run under test", out.painted.length >= RUNS.length + 1, `${out.painted.length} painted`);
check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
