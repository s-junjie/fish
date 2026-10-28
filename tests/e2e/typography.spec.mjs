import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Four typography features that only exist if TWO implementations agree: the
// canvas paints text as HTML inside a `foreignObject`, and the vector export
// re-lays it out as SVG `<text>`. Neither is visible to a unit test that mocks
// the DOM, and the failure mode is silent — an attribute the export never emits
// leaves an exported file that looks right until it is rendered somewhere
// without the app.
//
// The clamp is the one that has to be checked against the BOX and not just the
// paint: `maxLines` is the reason a wrapped paragraph no longer reserves the
// height of the paragraph it is cut down to, and a clamp that only hid the glyphs
// would still leave the layout sized for text nobody can see.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

const LONG =
  "This paragraph is deliberately far longer than two lines so the clamp has something to cut, and the ellipsis should land at the end of the second line.";

const DOC = {
  version: "0.1",
  canvas: { width: 600, height: 400 },
  pages: [
    {
      id: "p1",
      name: "Page 1",
      children: [
        {
          id: "card",
          type: "frame",
          name: "Card",
          x: 20,
          y: 20,
          width: 360,
          fills: [{ type: "solid", color: "#1B1B1B" }],
          display: "flex",
          "flex-direction": "column",
          gap: 12,
          padding: 24,
          children: [
            {
              id: "eyebrow",
              type: "text",
              name: "Eyebrow",
              content: "REVISED QUARTERLY FORECAST FOR THE NORTHERN REGION",
              style: {
                fontFamily: "Inter",
                fontSize: 11,
                fontWeight: 700,
                color: "#8A8A8A",
                maxLines: 1,
                textOverflow: "ellipsis"
              }
            },
            {
              id: "title",
              type: "text",
              name: "Title",
              content: "Revenue by region",
              style: { fontFamily: "Inter", fontSize: 22, fontWeight: 700, fontStyle: "italic", color: "#FFFFFF" }
            },
            {
              id: "nums",
              type: "text",
              name: "Numbers",
              content: "1,204,880\n9,910,004",
              style: { fontFamily: "Inter", fontSize: 14, fontVariantNumeric: "tabular-nums", color: "#E8E8E8" }
            },
            {
              id: "body",
              type: "text",
              name: "Body",
              content: LONG,
              style: { fontFamily: "Inter", fontSize: 14, color: "#A8A8A8", align: "justify" }
            },
            {
              id: "clamped",
              type: "text",
              name: "Clamped",
              content: LONG,
              style: { fontFamily: "Inter", fontSize: 14, color: "#787878", maxLines: 2, textOverflow: "ellipsis" }
            }
          ]
        }
      ]
    }
  ],
  activePageId: "p1"
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(pathToFileURL(html).href + "?view=canvas");
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

const out = await page.evaluate(async (doc) => {
  window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(doc).document);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))));

  const painted = {};
  for (const g of document.querySelectorAll("[data-element-id]")) {
    const id = g.getAttribute("data-element-id");
    const fo = g.querySelector("foreignObject");
    if (!fo || painted[id]) continue;
    const wrapper = fo.firstElementChild;
    const inner = wrapper?.firstElementChild;
    painted[id] = {
      box: Number(fo.getAttribute("height")),
      wrapper: wrapper?.getAttribute("style") || "",
      inner: inner?.getAttribute("style") || "",
      text: (inner?.textContent || "").slice(0, 60),
      // What the text actually occupies where it was painted — the claim is that
      // this and the box above are the same number.
      paintedHeight: inner ? inner.getBoundingClientRect().height : 0
    };
  }

  // `exportCanvasSvg` is async (it awaits the backdrop bake for blurred layers),
  // and a `Promise` stringifies to "" — which reads exactly like "the export
  // produced nothing" rather than "you forgot to await".
  const svgNode = await window.__fish.exportCanvasSvg?.();
  const svg = typeof svgNode === "string" ? svgNode : (svgNode?.svg ?? "");
  return { painted, svg, measured: window.__fish.measureAll?.() ?? null };
}, DOC);

const painted = out.painted;
// Two lines of 14px type at the engine's 1.38 line height.
const TWO_LINES = Math.round(14 * 1.38 * 2 * 100) / 100;
const ONE_LINE_11 = Math.round(11 * 1.38 * 100) / 100;

check("the document painted", Object.keys(painted).length >= 5, Object.keys(painted).join(","));
check("no page errors", pageErrors.length === 0, pageErrors[0] ?? "");

check("italic reaches the painted node", /font-style:\s*italic/.test(painted.title?.wrapper ?? ""));
check("tabular figures reach the painted node", /font-variant-numeric:\s*tabular-nums/.test(painted.nums?.wrapper ?? ""));
check("justify reaches the painted node", /text-align:\s*justify/.test(painted.body?.wrapper ?? ""));

// The clamp is split by line count, and the reason is the vertical alignment the
// wrapper keeps: `-webkit-box` would replace its `display: flex`.
check(
  "one line serialises as nowrap with a hidden overflow, on the INNER node",
  /white-space:\s*nowrap/.test(painted.eyebrow?.inner ?? "") &&
    /overflow:\s*hidden/.test(painted.eyebrow?.inner ?? "") &&
    /text-overflow:\s*ellipsis/.test(painted.eyebrow?.inner ?? ""),
  painted.eyebrow?.inner?.slice(0, 100)
);
check(
  "the wrapper keeps display:flex, so vertical alignment survives the clamp",
  /display:\s*flex/.test(painted.eyebrow?.wrapper ?? "")
);
check("two lines serialises as a webkit line clamp", /-webkit-line-clamp:\s*2/.test(painted.clamped?.inner ?? ""));

// The BOX, which is the half a paint-only clamp would get wrong.
check(
  `a 1-line clamp is a 1-line box (${ONE_LINE_11})`,
  Math.abs((painted.eyebrow?.box ?? 0) - ONE_LINE_11) < 0.05,
  `box ${painted.eyebrow?.box}`
);
check(
  `a 2-line clamp is a 2-line box (${TWO_LINES})`,
  Math.abs((painted.clamped?.box ?? 0) - TWO_LINES) < 0.05,
  `box ${painted.clamped?.box}`
);
check(
  "the box is the height the text actually occupies",
  Math.abs((painted.clamped?.paintedHeight ?? 0) - (painted.clamped?.box ?? -1)) < 1,
  `painted ${Math.round(painted.clamped?.paintedHeight ?? 0)} vs box ${painted.clamped?.box}`
);
check(
  "an unclamped paragraph is taller than the clamped copy of the same text",
  (painted.body?.box ?? 0) > (painted.clamped?.box ?? 0),
  `body ${painted.body?.box} vs clamped ${painted.clamped?.box}`
);

check("exportCanvasSvg returns a document", typeof out.svg === "string" && out.svg.length > 500, `${out.svg.length} bytes`);
check("the svg carries italic", /font-style="italic"/.test(out.svg));
check("the svg carries tabular figures", /font-variant-numeric="tabular-nums"/.test(out.svg));
check(
  "the svg justifies a non-final line with textLength",
  /textLength="/.test(out.svg) && /lengthAdjust="spacing"/.test(out.svg)
);
check("the svg cuts the clamped run and marks the cut", /\u2026/.test(out.svg));

// ---------------------------------------------------------------------------
// The other half of "a capability without a control is not a feature": these
// four fields have to be reachable by a person, not only by JSON. This half
// cannot run against `?view=canvas` — the inspector is editor chrome — so it
// opens the editor and clicks the real controls, then reads the DOCUMENT. A
// control that lights up without reaching the model is exactly the failure this
// is here to catch, and nothing about the button's own appearance can detect it.
// ---------------------------------------------------------------------------
const editor = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const editorErrors = [];
editor.on("pageerror", (e) => editorErrors.push(String(e)));
await editor.goto(pathToFileURL(html).href);
await editor.waitForFunction(() => !!window.__FISH_BRIDGE__);

await editor.evaluate(async (doc) => {
  window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(doc).document);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 90))));
  window.__FISH_BRIDGE__.selectElement("body");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 90))));
}, DOC);

check("no page errors in the editor either", editorErrors.length === 0, editorErrors[0] ?? "");

const present = await editor.evaluate(() => ({
  style: !!document.querySelector('[data-typography-toggle="italic"]'),
  figures: !!document.querySelector('[data-typography-figures="tabular-nums"]'),
  truncate: !!document.querySelector('[data-typography-truncate="ellipsis"]')
}));
check("the italic control is in the inspector", present.style);
check("the tabular-figures control is in the inspector", present.figures);
check("the truncate control is in the inspector", present.truncate);

/** Click a segment, settle, and read the `body` element's style out of the doc. */
async function clickAndReadStyle(selector) {
  await editor.click(selector);
  await editor.waitForTimeout(140);
  return editor.evaluate(() => {
    const card = window.__FISH_BRIDGE__.getDoc().pages[0].children[0];
    return card.children.find((c) => c.id === "body")?.style ?? {};
  });
}

const afterItalic = await clickAndReadStyle('[data-typography-toggle="italic"]');
check("clicking Italic writes style.fontStyle", afterItalic.fontStyle === "italic", JSON.stringify(afterItalic.fontStyle));

// ---------------------------------------------------------------------------
// One row, three INDEPENDENT toggles. This half is the point of the merge: the
// row only makes sense if pressing one leaves the other two where they were, and
// the two decoration lines have to be able to be on at the same time — which the
// single-value `textDecoration` enum this replaced could not write down at all.
// Reading the DOCUMENT after each press is what makes this a test of the model
// rather than of the button.
// ---------------------------------------------------------------------------
const row = await editor.evaluate(() => {
  const buttons = [...document.querySelectorAll("[data-typography-toggle]")];
  return {
    count: buttons.length,
    values: buttons.map((b) => b.getAttribute("data-typography-toggle")),
    // The three share one track, so a row that had become two rows would show up
    // as three different parents.
    oneTrack: new Set(buttons.map((b) => b.parentElement)).size === 1
  };
});
check(
  "the row offers italic, underline and strikethrough together",
  row.count === 3 && row.values.join(",") === "italic,underline,line-through",
  row.values.join(",")
);
check("the three toggles share one track", row.oneTrack);

const afterUnderline = await clickAndReadStyle('[data-typography-toggle="underline"]');
check(
  "turning underline on leaves the italic alone",
  afterUnderline.fontStyle === "italic" &&
    afterUnderline.textDecoration?.includes("underline") === true,
  JSON.stringify({ fontStyle: afterUnderline.fontStyle, decoration: afterUnderline.textDecoration })
);

const afterStrike = await clickAndReadStyle('[data-typography-toggle="line-through"]');
// The line that the old model could not express: CSS allows both at once, and so
// does this, while the italic from two presses ago is still on.
check(
  "underline and strikethrough are on at the same time, with italic",
  afterStrike.fontStyle === "italic" &&
    afterStrike.textDecoration?.length === 2 &&
    afterStrike.textDecoration.includes("underline") &&
    afterStrike.textDecoration.includes("line-through"),
  JSON.stringify(afterStrike.textDecoration)
);

const afterUnunderline = await clickAndReadStyle('[data-typography-toggle="underline"]');
check(
  "turning one line off leaves the other line and the italic",
  afterUnunderline.fontStyle === "italic" &&
    afterUnunderline.textDecoration?.length === 1 &&
    afterUnunderline.textDecoration[0] === "line-through",
  JSON.stringify(afterUnunderline.textDecoration)
);

// The armed state is read back from the document, so a toggle whose paint and
// whose value disagree cannot pass: `aria-pressed` is the button's own answer.
const armed = await editor.evaluate(() => {
  const read = (v) =>
    document.querySelector(`[data-typography-toggle="${v}"]`)?.getAttribute("aria-pressed");
  return { italic: read("italic"), underline: read("underline"), strike: read("line-through") };
});
check(
  "the buttons show what the document says",
  armed.italic === "true" && armed.underline === "false" && armed.strike === "true",
  JSON.stringify(armed)
);

// Put the strikethrough back so the truncation half below starts from the same
// document the earlier checks assumed.
await clickAndReadStyle('[data-typography-toggle="line-through"]');

const afterFigures = await clickAndReadStyle('[data-typography-figures="tabular-nums"]');
check(
  "clicking Tabular writes fontVariantNumeric",
  afterFigures.fontVariantNumeric === "tabular-nums",
  JSON.stringify(afterFigures.fontVariantNumeric)
);

// The document's `body` copy already carries `align: "justify"`. Writing an
// unrelated axis must not disturb it — the inspector writes per-axis, and a
// whole-style overwrite here would be invisible until someone looked at the text.
check(
  "writing one axis leaves the others alone",
  afterFigures.align === "justify",
  `align is ${JSON.stringify(afterFigures.align)}`
);

const clampedStyle = await clickAndReadStyle('[data-typography-truncate="ellipsis"]');
check(
  "clicking Ellipsis writes maxLines AND textOverflow",
  clampedStyle.maxLines === 2 && clampedStyle.textOverflow === "ellipsis",
  JSON.stringify({ maxLines: clampedStyle.maxLines, textOverflow: clampedStyle.textOverflow })
);

// "Off" must be the ABSENCE of the fields, not a sentinel value: a `maxLines`
// left behind at 0 or a `textOverflow` stranded without a count would both round
// through normalize as a capability in use while changing no pixel.
const offStyle = await clickAndReadStyle('[data-typography-truncate="off"]');
check(
  "turning truncation off removes both fields rather than storing a sentinel",
  offStyle.maxLines === undefined && offStyle.textOverflow === undefined,
  JSON.stringify({ maxLines: offStyle.maxLines, textOverflow: offStyle.textOverflow })
);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
