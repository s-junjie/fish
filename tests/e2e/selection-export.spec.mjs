import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// A selection export reduces the document to the selected subtrees. The filter has
// to answer two questions that both fail silently:
//
//   1. instance children paint under derived ids the selection never mints, so
//      membership has to be decided by ancestry rather than by the id set
//   2. a node outside the selection is very often an ANCESTOR of a node inside it —
//      selecting a card inside a page leaves the page itself doomed. Removing it
//      took the whole subtree with it, so every export of a NESTED selection came
//      out empty, at the correct size, with no error. A top-level selection was
//      never affected, which is why it survived: nothing doomed sits above it.
//
// The second case is the one this file exists for.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

const candidate = {
  version: "0.1",
  canvas: { width: 600, height: 400 },
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: 600, height: 400 },
      children: [
        {
          id: "page",
          type: "frame",
          name: "Page",
          x: 0,
          y: 0,
          width: 600,
          height: 400,
          fills: [{ type: "solid", color: "#101010" }],
          children: [
            {
              id: "card",
              type: "frame",
              name: "Card",
              x: 40,
              y: 40,
              width: 300,
              height: 160,
              fills: [{ type: "solid", color: "#2A2A2A" }],
              children: [
                {
                  id: "label",
                  type: "rect",
                  name: "Label",
                  x: 16,
                  y: 16,
                  width: 120,
                  height: 40,
                  fills: [{ type: "solid", color: "#4C8DFF" }]
                }
              ]
            },
            {
              id: "other",
              type: "rect",
              name: "Other",
              x: 400,
              y: 40,
              width: 120,
              height: 40,
              fills: [{ type: "solid", color: "#FF4C4C" }]
            }
          ]
        },
        {
          id: "banner",
          type: "rect",
          name: "Banner",
          x: 20,
          y: 300,
          width: 200,
          height: 40,
          fills: [{ type: "solid", color: "#33CC33" }]
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

  const analyse = async (allowed) => {
    const svg = await window.__fish.exportCanvasSvg({ scale: 1, allowedElementIds: allowed });
    const d = new DOMParser().parseFromString(svg, "image/svg+xml");
    return {
      ids: [...d.querySelectorAll("[data-element-id]")].map((g) => g.getAttribute("data-element-id")),
      // Distinct fills, which is what "the content is actually in there" means
      // here: a stripped subtree still serializes, it just paints nothing.
      fills: [...new Set([...d.querySelectorAll("[fill]")].map((n) => n.getAttribute("fill")))]
    };
  };

  return {
    nestedSelection: await analyse(new Set(["card", "label"])),
    deepSelection: await analyse(new Set(["label"])),
    topLevelSelection: await analyse(new Set(["banner"])),
    whole: await analyse(new Set(["page", "card", "label", "other", "banner"]))
  };
}, candidate);

const has = (result, ...ids) => ids.every((id) => result.ids.includes(id));

check(
  "a nested selection keeps the selected element and its children",
  has(out.nestedSelection, "card", "label"),
  out.nestedSelection.ids.join(",")
);
check(
  "a nested selection drops everything that was not selected",
  !has(out.nestedSelection, "other") && !has(out.nestedSelection, "page"),
  out.nestedSelection.ids.join(",")
);
check(
  "a deeply nested selection survives — the bug this file exists for",
  has(out.deepSelection, "label"),
  out.deepSelection.ids.join(",")
);
check(
  "a top-level selection is unaffected — nothing doomed sits above it",
  has(out.topLevelSelection, "banner"),
  out.topLevelSelection.ids.join(",")
);
check(
  "selecting everything keeps everything",
  has(out.whole, "page", "card", "label", "other", "banner"),
  out.whole.ids.join(",")
);
// A stripped subtree is still valid SVG of the right size, so size proves nothing.
// The label's own fill is the only thing that proves its paint came with it rather
// than just its wrapper.
check(
  "the selection carries its own paint, not just its wrapper",
  out.deepSelection.fills.includes("#4C8DFF"),
  `selection fills ${JSON.stringify(out.deepSelection.fills)}`
);
check(
  "a selection carries only its own paint",
  !out.nestedSelection.fills.includes("#FF4C4C"),
  JSON.stringify(out.nestedSelection.fills)
);
check("no page errors", pageErrors.length === 0, pageErrors.join("; "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length > 0 ? 1 : 0);
