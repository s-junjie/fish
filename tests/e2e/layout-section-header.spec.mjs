import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// The LAYOUT section, asserted as a SECTION rather than as a pile of controls.
//
// Two claims live here, both about grouping rather than about values:
//
//  1. An element that is PLACED by its parent and an element that PLACES its own
//     children are one concern, so they share one header — and an element that is
//     both must not show two headings reading "Layout" on top of each other,
//     which reads as a rendering fault rather than as two groups.
//  2. The placement controls come FIRST in that section. An imported page is
//     mostly containers inside stacks, so putting them under a container's own
//     controls buried them below the fold — which is why the header was asked for
//     in the first place, and re-burying them would leave the same complaint.
//
// Where each control sits is checked by DOCUMENT ORDER between two headers, not
// by a bounding box: a control can be present and still be in the wrong section,
// and a box cannot tell the two apart.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const ELEMENTS = [
  {
    id: "PAGE",
    type: "frame",
    name: "Page",
    x: 0,
    y: 0,
    width: 4000,
    height: 3000,
    fills: [{ type: "solid", color: "#101010" }],
    children: [
      {
        id: "STACK",
        type: "frame",
        name: "Stack",
        x: 200,
        y: 200,
        width: 400,
        height: 500,
        fills: [{ type: "solid", color: "#161616" }],
        display: "flex",
        "flex-direction": "column",
        gap: 20,
        padding: 20,
        children: [
          {
            id: "LEAF",
            type: "rect",
            name: "Leaf",
            x: 0,
            y: 0,
            width: 100,
            height: 40,
            fills: [{ type: "solid", color: "#30A46C" }],
            "align-self": "center",
            margin: [0, 0, 12, 0]
          },
          {
            id: "NEST",
            type: "frame",
            name: "Nested grid",
            x: 0,
            y: 0,
            width: 300,
            height: 200,
            fills: [{ type: "solid", color: "#1E1E1E" }],
            display: "grid",
            "grid-template-columns": 2,
            "column-gap": 4,
            "row-gap": 4,
            padding: 0,
            children: [{ id: "n1", type: "rect", name: "N1", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#8B5CF6" }] }]
          }
        ]
      },
      {
        id: "FREE",
        type: "frame",
        name: "Free grid",
        x: 200,
        y: 900,
        width: 300,
        height: 200,
        fills: [{ type: "solid", color: "#1E1E1E" }],
        display: "grid",
        "grid-template-columns": 2,
        "column-gap": 4,
        "row-gap": 4,
        padding: 0,
        children: [{ id: "f1", type: "rect", name: "F1", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#8B5CF6" }] }]
      }
    ]
  }
];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

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
  bridge.setElements(JSON.parse(JSON.stringify(elements)), { canvas: { ...base.canvas, width: 4000, height: 3000 } });
}, ELEMENTS);
await page.waitForTimeout(400);

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await settle();
};

/**
 * Where the layout controls sit relative to the section they belong to.
 *
 * A section runs from its own header to the next header of any kind, which is
 * what `after(header, x) && after(x, next)` says. `next` is `null` only when the
 * section is last in the panel, which Layout never is.
 */
const layoutSection = () =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-ui-panel="right"]');
    if (!panel) return null;
    const micros = Array.from(panel.querySelectorAll(".text-micro.uppercase"));
    const isLayout = (n) => n.textContent.trim().toLowerCase() === "layout";
    const idx = micros.findIndex(isLayout);
    const header = idx >= 0 ? micros[idx] : null;
    const next = idx >= 0 ? (micros[idx + 1] ?? null) : null;
    const after = (a, b) => !!a && !!b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    const alignSelf = panel.querySelector('[data-stack-align-self]');
    const margin = panel.querySelector('[data-stack-margin]');
    const tracks = panel.querySelector('[data-stack-tracks="column"]');
    const advanced = Array.from(panel.querySelectorAll("button")).find((b) => /advanced/i.test(b.textContent));

    const inSection = (el) => after(header, el) && after(el, next);
    return {
      headerCount: micros.filter(isLayout).length,
      headerText: header ? header.textContent.trim() : null,
      hasAlignSelf: !!alignSelf,
      hasMargin: !!margin,
      hasTracks: !!tracks,
      alignSelfInSection: inSection(alignSelf),
      marginInSection: inSection(margin),
      tracksInSection: inSection(tracks),
      advancedInSection: inSection(advanced),
      // "How my parent places me" before "how I place my children".
      placementBeforeOwnLayout: after(alignSelf, tracks) || after(margin, tracks) || after(alignSelf, advanced),
      // And the header is the FIRST thing in the section, not a label between rows.
      headerBeforeControls: after(header, alignSelf) || after(header, tracks)
    };
  });

// ------------------------------------------------- a leaf: placed, places nothing
await select("LEAF");
const leaf = await layoutSection();
check(
  "a child of a stack gets the LAYOUT header — this is the reported gap",
  leaf?.headerCount === 1 && leaf?.headerText?.toLowerCase() === "layout",
  `headers=${leaf?.headerCount} text=${JSON.stringify(leaf?.headerText)}`
);
check(
  "and Align Self and Margin sit INSIDE it, after the header and before the next one",
  leaf?.hasAlignSelf && leaf?.hasMargin && leaf?.alignSelfInSection && leaf?.marginInSection,
  `alignSelf in section=${leaf?.alignSelfInSection} margin in section=${leaf?.marginInSection}`
);

// --------------------------------------- a container that is also a placed child
await select("NEST");
const nest = await layoutSection();
check(
  "a container that is ALSO a child shows ONE Layout header, not two",
  nest?.headerCount === 1,
  `headers=${nest?.headerCount}`
);
check(
  "and both halves are inside it: its own placement and its own layout",
  nest?.hasAlignSelf && nest?.hasTracks && nest?.alignSelfInSection && nest?.tracksInSection,
  `alignSelf in section=${nest?.alignSelfInSection} tracks in section=${nest?.tracksInSection}`
);
check(
  "with the placement first — an imported page is mostly containers inside stacks",
  nest?.placementBeforeOwnLayout === true,
  `placement before own layout=${nest?.placementBeforeOwnLayout}`
);
check(
  "and the header leads the section rather than sitting between its rows",
  nest?.headerBeforeControls === true,
  `header before controls=${nest?.headerBeforeControls}`
);

// ----------------------------------------------- a container nothing else places
await select("FREE");
const free = await layoutSection();
check(
  "a container with no laid-out parent keeps the header and offers no Align Self",
  free?.headerCount === 1 && free?.hasAlignSelf === false && free?.hasTracks === true,
  `headers=${free?.headerCount} alignSelf=${free?.hasAlignSelf} tracks=${free?.hasTracks}`
);

await browser.close();

if (errors.length > 0) {
  console.log("\n--- page errors ---");
  for (const e of errors.slice(0, 6)) console.log(`  ${e}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "ALL CHECKS PASS" : `${failed.length} CHECK(S) FAILED`}\n`);
process.exit(failed.length === 0 ? 0 : 1);
