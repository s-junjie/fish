/**
 * P0 acceptance probe for the HTML importer.
 *
 * Runs the importer inside a real browser, against a page deliberately built out
 * of the things the DSL can and cannot express, and checks the five criteria the
 * plan set for P0. The host page is styled HOSTILELY on purpose — a cursive font
 * stack at 40px with 6px letter spacing, all of it inherited — because that is
 * the failure the shadow-root isolation exists to prevent, and a probe that
 * cannot fail proves nothing.
 *
 * The ground truth is the same sample rendered in a clean iframe, so "did the
 * import reproduce the page" is answered against a browser rather than against
 * the importer's own opinion of itself.
 *
 *   node scripts/probe-html-import.mjs
 */

import { chromium } from "playwright";
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIEWPORT = 1280;
const TOLERANCE = 1;

const DATA_URI_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SAMPLE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { background: #ffffff; font-family: Helvetica, Arial, sans-serif; color: #111111; }

  /* 1. a flex row that MUST rebuild: space-between + gap, three text children */
  .row { display: flex; gap: 16px; justify-content: space-between; align-items: center;
         width: 640px; padding: 24px; background: #f8fafc; }

  /* 2. a card: radius + multi-value box-shadow */
  .card { width: 180px; height: 120px; margin: 24px; background: #ffffff;
          border-radius: 12px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.6); }

  /* 3. a bordered, padded flex row: the border has to fold into the padding */
  .bordered { display: flex; gap: 8px; padding: 10px; border: 2px solid #0f172a; width: 320px; margin: 0 24px; }
  .bordered > span { padding: 4px 8px; background: #e2e8f0; }

  /* 4. the deliberate misalignment: align-self is a DSL field now, so this
        container must REBUILD rather than downgrade */
  .offset { display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
            width: 400px; padding: 12px; margin: 24px; background: #fef3c7; }
  .offset > .a { align-self: center; width: 120px; height: 40px; background: #dbeafe; }
  .offset > .b { width: 120px; height: 40px; background: #bbf7d0; }

  /* 5. a bound the engine now RESOLVES: the browser clamps the first item, and
        so does the layout pass, so this container REBUILDS rather than
        downgrading itself. */
  .clamped { display: flex; gap: 8px; width: 320px; margin: 24px; }
  .clamped > .wide { flex: 1; max-width: 120px; height: 20px; background: #e5e7eb; }
  .clamped > .rest { flex: 1; height: 20px; background: #f3f4f6; }

  /* 5b. and one it cannot: flex-grow in a RATIO the DSL has no field for. Both
        items are "fill", and the engine divides the leftover evenly while the
        browser divides it 1:2 - so this container is the one that has to give
        up its layout. */
  .growline { display: flex; gap: 8px; width: 320px; margin: 24px; }
  .growline > .g1 { flex: 1 1 0; height: 20px; background: #a7f3d0; }
  .growline > .g2 { flex: 2 1 0; height: 20px; background: #6ee7b7; }

  /* 14. mixed content: a text node on either side of a block child. The DSL has
        no spelling for it — a frame holds boxes, a text holds runs, neither
        holds both — so the only correct outcome is that the text is NAMED in
        the report rather than vanishing. Last in the body, so every other
        criterion's body/N index is unmoved. */
  .mixed { width: 300px; margin: 24px; }
  .mixedblock { display: block; width: 120px; height: 24px; background: #e2e8f0; }

  /* 15. paint order: an overlay written BEFORE the thing it covers, lifted by
        z-index. The DSL has no z-index, so the walk carries it as the siblings'
        order — this is the a.back shape on brand-gold.html. */
  .stackpair { position: relative; width: 200px; height: 40px; margin: 24px; background: #f1f5f9; }
  .stackpair > .under { position: absolute; left: 0; top: 0; width: 60px; height: 40px; background: #7dd3fc; z-index: 9; }
  .stackpair > .over { width: 120px; height: 40px; background: #cbd5e1; }

  /* 5. things the DSL cannot say, all reported rather than guessed at */
  .scaled { transform: scale(1.2); width: 120px; height: 24px; background: #fecaca; margin: 24px; }
  .fixed { position: fixed; top: 10px; left: 10px; width: 40px; height: 40px; background: #f87171; }
  .clipped { clip-path: circle(50%); width: 40px; height: 40px; background: #4ade80; margin: 24px; }
  .sepia { filter: sepia(0.6); width: 40px; height: 40px; background: #60a5fa; margin: 24px; }
  .stacked { position: relative; z-index: 5; width: 40px; height: 40px; background: #c084fc; margin: 24px; }

  .thumb { width: 64px; height: 64px; margin: 24px; display: block; }
  .remote { width: 32px; height: 32px; margin: 0 24px; display: block; }
  .icon { display: block; width: 24px; height: 24px; margin: 0 24px; }
  .para { width: 420px; margin: 24px; font-size: 15px; line-height: 22px; }
  .nowrap { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 160px; margin: 0 24px; }

  /* 7. pseudo-elements, which have no node to measure until they are materialised */
  .hl { position: relative; width: 200px; height: 40px; margin: 24px; background: #f8fafc; }
  .hl::before { content: ""; position: absolute; inset: 0 0 auto; height: 1px; background: #0f172a; }

  .arrow { width: 120px; margin: 24px; background: #ffffff; }
  .arrow::after { content: "\\2192"; font-size: 14px; color: #0f172a; }

  .annrow { display: flex; align-items: center; gap: 10px; width: 400px; margin: 24px; }
  .annrow::after { content: ""; flex: 1; height: 1px; background: #cbd5e1; }
  .annrow > .micro { font-size: 10px; letter-spacing: .2em; text-transform: uppercase; }

  .nopseudo { width: 40px; height: 8px; margin: 24px; background: #fde68a; }
  .nopseudo::before { content: none; }

  .counter { width: 60px; height: 20px; margin: 24px; background: #e2e8f0; counter-reset: fish 3; }
  .counter::before { content: counter(fish); font-size: 12px; }

  /* 8. external bytes: one the probe can serve, one on another origin, one relative */
  .local { display: block; width: 20px; height: 20px; margin: 24px; }
  .relative { display: block; width: 20px; height: 20px; margin: 0 24px; }
  /* Tiling is the value that actually loses something here: the dialect paints
     one image over the box and cannot repeat it, so a repeating background is
     named. Leaving it off is what the dialect draws by default and is not a gap
     — the importer used to report the one and stay silent about the other. */
  .bgimg { width: 80px; height: 40px; margin: 24px; background-color: #f1f5f9;
           background-image: url("http://probe.local/probe-asset.png");
           background-size: cover; background-repeat: repeat; }

  /* 9. a ramp that fades to nothing, which is how every hairline is written */
  .fade { width: 120px; height: 8px; margin: 24px;
          background: linear-gradient(90deg, #333338 0%, transparent 100%); }

  /* 10. a grid no column COUNT can describe: three different tracks, three
        different rows, and children placed by line number rather than by flow */
  .shell { display: grid; grid-template-columns: 120px 1fr 80px;
           grid-template-rows: 30px 1fr 18px; gap: 4px;
           width: 400px; height: 120px; margin: 24px; background: #f8fafc; }
  .shell > .sbar { grid-column: 1 / 4; background: #0f172a; }
  .shell > .sside { grid-column: 1; grid-row: 2 / 4; background: #cbd5e1; }
  .shell > .smid { grid-column: 2; grid-row: 2 / 4; background: #e2e8f0; }
  .shell > .sfoot { grid-column: 3; grid-row: 3; background: #94a3b8; }

  .spanrow { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px;
             width: 300px; margin: 24px; }

  /* 11. list markers: a marker has no node, so it is named rather than rebuilt */
  .bullets { margin: 24px; padding-left: 32px; font-size: 15px; }
  .plainlist { margin: 24px; padding-left: 32px; font-size: 15px; list-style: none; }
  .spanrow > .stwo { grid-column: span 2; height: 20px; background: #e2e8f0; }
  .spanrow > .sone { height: 20px; background: #cbd5e1; }

  /* 16-22: places where the browser's serialization is NOT the spec's spelling.
        Every one of these used to import as the WRONG thing rather than as a
        missing one, and every one needs a real computed style to catch — which
        is why they live here and not in a unit test. Appended at the END of the
        body so every criterion above keeps its body/N index. */
  .defsicon { display: block; width: 32px; height: 32px; margin: 0 24px; }
  /* Chrome rewrites a corner of the form "to bottom right" into "to right
     bottom"; the old table only knew the authored order, so every corner
     gradient fell through to 180 degrees. */
  .corner { width: 100px; height: 60px; margin: 24px;
            background: linear-gradient(to bottom right, #ff0000, #0000ff); }
  /* A standalone rotate is NOT in the transform property: computed transform is
     "none" and the value sits on the rotate property, which nothing read. The
     element was sized from its rotated bounding box and then drawn upright. */
  .rotated { width: 80px; height: 40px; margin: 24px; rotate: 90deg; background: #fde047; }
  .dashed { display: block; width: 100px; height: 20px; margin: 0 24px; }
  /* Chrome answers rgb(128, 128, 128) for border-top-color even at width 0, so an
     hr styled with a background came out as the UA's grey rule. */
  .hrline { border: 0; background: #111111; height: 4px; width: 100px; margin: 24px; }
  /* A 50% radius on a non-square box is an ELLIPSE and the dialect carries one
     radius, so this is one of the few things that must be named, not built. */
  .ellipse { width: 200px; height: 60px; margin: 24px; background: #e0e7ff; border-radius: 50%; }
  /* Tailwind v4 writes oklch() by default; parseCssColor returned null for it, so
     these elements imported with NO fill at all and nothing in the report. */
  .wideg { width: 40px; height: 40px; margin: 24px; background-color: oklch(0.7 0.15 250); }
  /* A host that draws BOTH pseudos: the two are suppressed and materialised as
     one attribute, so a marker that only names one of them loses the other
     before it can be read. */
  .both { position: relative; width: 120px; height: 30px; margin: 24px; background: #ffffff; }
  .both::before { content: ""; position: absolute; top: 0; left: 12px; width: 1px; height: 20px; background: #0f172a; }
  .both::after { content: ""; position: absolute; top: 12px; left: 0; width: 20px; height: 1px; background: #0f172a; }
  /* A failed bitmap draws its alt text; with a percentage height that fallback
     measured 110px inside a 64px frame, painting only the top of the photo. The
     box here is 40×40 whatever the label says. */
  .altframe { width: 40px; height: 40px; margin: 24px; overflow: hidden; background: #7a5a41; }
  .altframe img { width: 100%; height: 100%; object-fit: cover; }
</style></head>
<body>
  <div class="row">
    <div class="label">Alpha</div>
    <div class="label">Beta</div>
    <div class="label">Gamma</div>
  </div>

  <div class="card"></div>

  <div class="bordered"><span>one</span><span>two</span></div>

  <div class="offset"><div class="a"></div><div class="b"></div></div>

  <div class="clamped"><div class="wide"></div><div class="rest"></div></div>

  <p class="para">The quick brown fox jumps over the lazy dog, and then keeps going for long enough to wrap onto a second line.</p>

  <div class="nowrap">A very long label that has to be cut off at the edge</div>

  <img class="thumb" src="${DATA_URI_PNG}" alt="inline bitmap">
  <img class="remote" src="https://example.invalid/nope.png" alt="remote bitmap">

  <svg class="icon" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="#334155"/></svg>

  <div class="scaled"></div>
  <div class="clipped"></div>
  <div class="sepia"></div>
  <div class="stacked"></div>
  <div class="fixed"></div>

  <div class="hl"></div>
  <div class="arrow"></div>
  <div class="annrow"><span class="micro">Colour</span></div>
  <div class="nopseudo"></div>
  <div class="counter"></div>

  <div class="fade"></div>
  <img class="local" src="http://probe.local/probe-asset.png" alt="served bitmap">
  <img class="relative" src="./missing.png" alt="relative bitmap">
  <div class="bgimg"></div>

  <div class="shell">
    <div class="sbar"></div>
    <div class="sside"></div>
    <div class="smid"></div>
    <div class="sfoot"></div>
  </div>
  <div class="spanrow"><div class="stwo"></div><div class="sone"></div></div>

  <ul class="bullets"><li>one</li><li>two</li></ul>
  <ul class="plainlist"><li>dash one</li></ul>

  <div class="growline"><div class="g1"></div><div class="g2"></div></div>

  <div class="mixed">loose text before<p class="mixedblock">a block</p>loose text after</div>

  <div class="stackpair"><div class="under"></div><div class="over"></div></div>

  <svg class="defsicon" viewBox="0 0 32 32">
    <defs><rect x="0" y="0" width="30" height="30" fill="#ff00ff"/></defs>
    <clipPath id="probe-clip"><rect x="0" y="0" width="6" height="6"/></clipPath>
    <path d="M8 8h16v16H8z" fill="#334155"/>
  </svg>

  <div class="corner"></div>
  <div class="rotated"></div>

  <svg class="dashed" viewBox="0 0 100 20">
    <line x1="2" y1="10" x2="98" y2="10" stroke="#0f172a" stroke-width="2" stroke-dasharray="4 4"/>
  </svg>

  <hr class="hrline">
  <div class="ellipse"></div>
  <div class="wideg"></div>
  <div class="both"></div>
  <div class="altframe"><img src="./missing-alt.png" alt="a long alt label that has to wrap inside the frame"></div>
</body></html>`;

/**
 * Criterion 12's fixture: the same page with the grid's own box widened.
 *
 * The browser's answer at this width is what a RESIZED import has to match —
 * `120px 1fr 80px` inside 600px puts 392px in the middle track, while an import
 * frozen at the width it was measured at keeps 192px and is 200px wrong. Every
 * other criterion here is measured at one width; this is the one that closes
 * that blind spot.
 */
const WIDE_WIDTH = 600;
const SAMPLE_WIDE = SAMPLE.replace("width: 400px; height: 120px;", `width: ${WIDE_WIDTH}px; height: 120px;`);
if (SAMPLE_WIDE === SAMPLE) throw new Error("the grid box in SAMPLE moved; criterion 12 has nothing to widen");

const bundle = await esbuild.build({
  stdin: {
    contents: `
      export { importHtmlDocument } from "./src/core/import/html-import";
      export { normalizeDesignDocument } from "./src/core/dsl/normalize/document";
      export { applyAutoLayout } from "./src/core/compile";
    `,
    resolveDir: root,
    sourcefile: "probe-entry.ts",
    loader: "ts"
  },
  bundle: true,
  format: "iife",
  globalName: "FishHtmlImport",
  target: "es2022",
  write: false,
  logLevel: "warning"
});
const code = bundle.outputFiles[0].text;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

// One bitmap the probe can actually serve, so "an external image was inlined" is
// a fact rather than an inference from the ones that failed. Deliberately NOT the
// same bytes as the inline thumbnail: two identical images collapse to one asset,
// which would make a count assertion prove nothing.
const SERVED_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const SERVED_BYTES = Buffer.from(SERVED_GIF.split(",")[1], "base64");
await page.route("**/probe-asset.png", (route) =>
  route.fulfill({ status: 200, contentType: "image/gif", body: SERVED_BYTES })
);

await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ content: code });

const payload = await page.evaluate(async ({ sample, sampleWide, viewport, wideWidth }) => {
  // Hostile inherited styles: everything here crosses a shadow boundary unless
  // the host blocks it, and each one would move every text box in the import.
  document.documentElement.style.fontFamily = '"Comic Sans MS", "Chalkboard SE", cursive';
  document.body.style.cssText =
    'font-family: "Comic Sans MS", "Chalkboard SE", cursive; font-size: 40px; line-height: 4; letter-spacing: 6px; color: rgb(255, 0, 0); word-spacing: 8px;';

  // Ground truth: the same sample, laid out by the browser with no app styles in
  // scope, measured by DOM path so the two trees can be lined up. A FUNCTION
  // because criterion 12 needs the truth at a SECOND width: what the browser does
  // to these tracks when the box is wider is the only answer "the import scales"
  // can be checked against.
  const groundTruth = async (html) => {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:absolute;left:-20000px;top:0;width:1280px;height:2000px;border:0";
  frame.srcdoc = html;
  document.body.appendChild(frame);
  await new Promise((resolve, reject) => {
    frame.addEventListener("load", resolve, { once: true });
    setTimeout(() => reject(new Error("ground-truth iframe never loaded")), 10000);
  });

  const truth = {};
  const pseudoTruth = {};
  const pseudoSize = {};
  const frameDoc = frame.contentDocument;
  const frameBody = frameDoc.body;
  const base = frameBody.getBoundingClientRect();
  truth.body = { x: 0, y: 0, width: base.width, height: base.height };
  const walkTruth = (el, prefix) => {
    Array.from(el.children).forEach((child, index) => {
      const key = `${prefix}/${index}`;
      const r = child.getBoundingClientRect();
      truth[key] = { x: r.left - base.left, y: r.top - base.top, width: r.width, height: r.height };
      for (const pseudo of ["before", "after"]) {
        const cs = frame.contentWindow.getComputedStyle(child, `::${pseudo}`);
        if (!cs.content || cs.content === "none" || cs.content === "normal" || cs.display === "none") continue;
        pseudoSize[`${key}~${pseudo}`] = {
          width: parseFloat(cs.width),
          height: parseFloat(cs.height),
          content: cs.content,
          position: cs.position
        };
        // A positioned pseudo's box comes out of the containing block, which for
        // `absolute` is the padding box of the nearest positioned ancestor — and
        // the pseudo's own ancestors start at its HOST, not at the host's parent.
        if (cs.position !== "absolute" && cs.position !== "fixed") continue;
        let box = child;
        while (box && frame.contentWindow.getComputedStyle(box).position === "static") box = box.parentElement;
        box = box || frameBody;
        const hcs = frame.contentWindow.getComputedStyle(box);
        const hr = box.getBoundingClientRect();
        const bl = parseFloat(hcs.borderLeftWidth);
        const bt = parseFloat(hcs.borderTopWidth);
        const cbLeft = hr.left + bl;
        const cbTop = hr.top + bt;
        const cbWidth = hr.width - bl - parseFloat(hcs.borderRightWidth);
        const cbHeight = hr.height - bt - parseFloat(hcs.borderBottomWidth);
        const num = (v) => (v === "auto" ? null : parseFloat(v));
        const left = num(cs.left);
        const right = num(cs.right);
        const top = num(cs.top);
        const bottom = num(cs.bottom);
        const width = left !== null && right !== null ? cbWidth - left - right : parseFloat(cs.width);
        const height = top !== null && bottom !== null ? cbHeight - top - bottom : parseFloat(cs.height);
        const x = left !== null ? cbLeft + left : right !== null ? cbLeft + cbWidth - right - width : cbLeft;
        const y = top !== null ? cbTop + top : bottom !== null ? cbTop + cbHeight - bottom - height : cbTop;
        pseudoTruth[`${key}~${pseudo}`] = { x: x - base.left, y: y - base.top, width, height };
      }
      walkTruth(child, key);
    });
  };
  walkTruth(frameBody, "body");
  frame.remove();
  return { truth, pseudoTruth, pseudoSize };
  };

  const { truth, pseudoTruth, pseudoSize } = await groundTruth(sample);
  const wide = await groundTruth(sampleWide);

  const result = await FishHtmlImport.importHtmlDocument(sample, { viewportWidth: viewport, rootName: "Sample" });

  const boxes = [];
  const walkEls = (els, ox, oy, parentId, out = boxes) => {
    for (const el of els) {
      const x = ox + el.x;
      const y = oy + el.y;
      out.push({
        id: el.id,
        parentId,
        type: el.type,
        name: el.name ?? null,
        x,
        y,
        width: el.width,
        height: el.height,
        hasLayout: Boolean(el.layout),
        layout: el.layout ?? null,
        cell: el.layoutCell ?? null,
        content: typeof el.content === "string" ? el.content : null,
        paintTypes: (el.fills || []).map((p) => p.type).join(","),
        // 16-22 read these: the colour a paint actually carries, the dash pattern,
        // the standalone rotation and the gradient angle. All four live on the
        // element rather than on its box, so a criterion that only looked at
        // coordinates could never see them go missing.
        fillSummary: (el.fills || []).map((p) => `${p.type}${p.color ? ":" + p.color : ""}`).join(" | "),
        strokeColor: el.stroke?.color ?? null,
        dashArray: Array.isArray(el.stroke?.dashArray) ? el.stroke.dashArray.join(",") : null,
        rotation: typeof el.rotation === "number" ? el.rotation : null,
        gradientAngle: (el.fills || []).find((p) => p.type === "linear-gradient")?.angle ?? null,
        imageFits: (el.fills || []).filter((p) => p.type === "image").map((p) => p.fit).join(","),
        pathLength: el.type === "path" ? String(el.d ?? "").length : 0
      });
      if (el.children) walkEls(el.children, x, y, el.id, out);
    }
  };
  walkEls(result.elements, 0, 0, null);

  /* Criterion 12's other half: the SAME import, widened AFTERWARDS.
     `applyAutoLayout` is what runs when a frame's width is dragged, so this is
     the path a user takes — not a second import at another viewport, which would
     only prove the importer is exact at each width and say nothing about whether
     one result survives being resized. */
  const shellEntry = result.report.sources.find((s) => s.path === "body/24");
  const widen = (els, id, width) =>
    els.map((el) =>
      el.id === id
        ? FishHtmlImport.applyAutoLayout({ ...el, width })
        : el.children
          ? { ...el, children: widen(el.children, id, width) }
          : el
    );
  const wideBoxes = [];
  if (shellEntry) walkEls(widen(result.elements, shellEntry.id, wideWidth), 0, 0, null, wideBoxes);

  const normalized = FishHtmlImport.normalizeDesignDocument({
    name: "Sample",
    canvas: { width: viewport, height: 2000, unit: "px", background: { type: "solid", color: "#FFFFFF" } },
    pages: [
      {
        id: "page_1",
        name: "Sample",
        canvas: { width: viewport, height: 2000, unit: "px", background: { type: "solid", color: "#FFFFFF" } },
        elements: result.elements
      }
    ],
    activePageId: "page_1",
    assets: result.assets
  });

  return {
    report: result.report,
    boxes,
    truth,
    wideTruth: wide.truth,
    wideBoxes,
    pseudoTruth,
    pseudoSize,
    elementCount: boxes.length,
    assetCount: result.assets.length,
    assetUris: result.assets.map((a) => a.uri.slice(0, 24)),
    repairs: normalized.repairs,
    normalizedCount: normalized.document.pages[0].children.length
  };
}, { sample: SAMPLE, sampleWide: SAMPLE_WIDE, viewport: VIEWPORT, wideWidth: WIDE_WIDTH });

await browser.close();

// ---------------------------------------------------------------------------
// criteria
// ---------------------------------------------------------------------------

const { report, boxes, truth } = payload;
const byId = new Map(boxes.map((b) => [b.id, b]));
const pathById = new Map(report.sources.map((s) => [s.id, s.path]));
const idByPath = new Map(report.sources.map((s) => [s.path, s.id]));

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

const delta = (a, b) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));

// 1 — text boxes reproduce the page
check(
  "1. text boxes within 1px of the browser",
  report.maxTextDelta <= TOLERANCE,
  `maxTextDelta = ${report.maxTextDelta}px`
);

// 2 — the flex row rebuilds
const rowId = idByPath.get("body/0");
const row = rowId ? byId.get(rowId) : null;
const rowChildren = boxes.filter((b) => b.parentId === rowId);
const rowDowngraded = report.downgraded.some((d) => d.id === rowId);
let rowWorst = 0;
let rowMissing = 0;
for (const child of rowChildren) {
  const key = pathById.get(child.id);
  const t = key ? truth[key] : null;
  if (!t) {
    rowMissing += 1;
    continue;
  }
  rowWorst = Math.max(rowWorst, delta(child, t));
}
check(
  "2. flex row (space-between + gap) rebuilds within 1px",
  Boolean(row) &&
    Boolean(row.hasLayout) &&
    !rowDowngraded &&
    rowChildren.length === 3 &&
    // Without this the criterion compares fewer than three children, `rowWorst`
    // never leaves 0, and a row whose children all went missing reports PASS.
    rowMissing === 0 &&
    rowWorst <= TOLERANCE,
  `layout=${row ? row.hasLayout : "missing"} downgraded=${rowDowngraded} children=${rowChildren.length} missing=${rowMissing} worstDelta=${rowWorst.toFixed(2)}px`
);

// 3 — the align-self container REBUILDS: `layoutAlignSelf` is a DSL field now,
//     so the misaligned child is placed by the engine rather than the container
//     giving up its layout to express one child's offset.
const offsetId = idByPath.get("body/3");
const offset = offsetId ? byId.get(offsetId) : null;
const offsetChildren = boxes.filter((b) => b.parentId === offsetId);
const offsetDowngraded = report.downgraded.some((d) => d.id === offsetId);
let offsetWorst = 0;
for (const child of offsetChildren) {
  const t = truth[pathById.get(child.id)];
  if (t) offsetWorst = Math.max(offsetWorst, delta(child, t));
}
check(
  "3. align-self container rebuilds, with its centred child exactly placed",
  Boolean(offset) && offset.hasLayout && !offsetDowngraded && offsetChildren.length === 2 && offsetWorst <= TOLERANCE,
  `layout=${offset ? offset.hasLayout : "missing"} downgraded=${offsetDowngraded} childDelta=${offsetWorst.toFixed(2)}px`
);

// 6 — the self-check is still live: a container the engine genuinely cannot
//     reproduce (flex-grow in a ratio, which has no field) downgrades itself,
//     and the downgrade is visually lossless.
const downgradedId = idByPath.get("body/28");
const downgraded = downgradedId ? byId.get(downgradedId) : null;
const downgradeEntry = report.downgraded.find((d) => d.id === downgradedId);
const downgradeChildren = boxes.filter((b) => b.parentId === downgradedId);
let downgradeWorst = 0;
for (const child of downgradeChildren) {
  const t = truth[pathById.get(child.id)];
  if (t) downgradeWorst = Math.max(downgradeWorst, delta(child, t));
}
check(
  "6. a container the engine cannot reproduce downgrades itself, losslessly",
  Boolean(downgraded) && !downgraded.hasLayout && Boolean(downgradeEntry) && downgradeChildren.length === 2 && downgradeWorst <= TOLERANCE,
  downgradeEntry
    ? `downgraded (maxDelta ${downgradeEntry.maxDelta}px), childDelta=${downgradeWorst.toFixed(2)}px`
    : `NOT downgraded; layout=${downgraded ? downgraded.hasLayout : "missing"} childDelta=${downgradeWorst.toFixed(2)}px`
);

// 13 — and the bound the engine DOES resolve. This container used to be the one
//      criterion 6 was about: `max-width: 120px` on a `flex: 1` item is now
//      clamped by the layout pass, so it rebuilds instead of giving up its
//      layout. "精确但不可重建" is the failure mode to watch for on every bound
//      the engine grows, and this is the assertion that it has not happened.
const clampedId = idByPath.get("body/4");
const clamped = clampedId ? byId.get(clampedId) : null;
const clampedDowngrade = report.downgraded.find((d) => d.id === clampedId);
const clampedWide = boxes.find((b) => b.parentId === clampedId && pathById.get(b.id) === "body/4/0");
check(
  "13. a max-width the engine now resolves rebuilds instead of downgrading",
  Boolean(clamped) && clamped.hasLayout && !clampedDowngrade && Math.round(clampedWide?.width ?? 0) === 120,
  `layout=${clamped ? clamped.hasLayout : "missing"} downgraded=${Boolean(clampedDowngrade)} ` +
    `wide=${Math.round(clampedWide?.width ?? 0)}px (browser clamps it to 120)`
);

// 4 — normalize is clean
check(
  "4. normalizeDesignDocument reports zero repairs",
  payload.repairs.length === 0,
  payload.repairs.length === 0
    ? "0 repairs"
    : `${payload.repairs.length}: ` + payload.repairs.slice(0, 4).map((r) => `${r.path} — ${r.message}`).join(" | ")
);

// 5 — the unmappable properties are reported by name, and the inline `<svg>`
//     that USED to be one of them is now converted rather than reported.
const wanted = ["transform", "position", "clip-path", "filter", "z-index", "img", "background-repeat"];
const reported = new Set(report.unmapped.map((u) => u.property));
const missing = wanted.filter((p) => !reported.has(p));
const vectorPaths = boxes.filter((b) => b.type === "path" && b.pathLength > 4);
check(
  "5. report.unmapped names the unmappable, and the inline <svg> became paths",
  missing.length === 0 && vectorPaths.length > 0 && !reported.has("inline-svg"),
  missing.length > 0
    ? `missing ${missing.join(", ")}`
    : `${report.unmapped.length} entries: ${[...reported].sort().join(", ")}; ${vectorPaths.length} path element(s)`
);

// 7 — `::before` / `::after` are rebuilt as real elements, positioned from the
//     page's own containing block, and the ones that cannot be are reported.
const { pseudoTruth, pseudoSize } = payload;
const pseudoBox = (path) => {
  const id = idByPath.get(path);
  return id ? byId.get(id) : null;
};

const hlBox = pseudoBox("body/15~before");
const hlTruth = pseudoTruth["body/15~before"];
const hlDelta = hlBox && hlTruth ? delta(hlBox, hlTruth) : Infinity;

const arrow = boxes.find((b) => b.type === "text" && (b.content ?? "").trim() === "\u2192");
const arrowText = arrow ? arrow.content.trim() : "";

const annBox = pseudoBox("body/17~after");
const annSize = pseudoSize["body/17~after"];
const annHostId = idByPath.get("body/17");
const annHost = annHostId ? byId.get(annHostId) : null;
const annSizeDelta = annBox && annSize ? Math.max(Math.abs(annBox.width - annSize.width), Math.abs(annBox.height - annSize.height)) : Infinity;
const annRightGap = annBox && annHost ? Math.abs(annBox.x + annBox.width - (annHost.x + annHost.width)) : Infinity;

const noPseudoHostId = idByPath.get("body/18");
const noPseudoChildren = boxes.filter((b) => b.parentId === noPseudoHostId);
const counterReported = report.unmapped.some((u) => u.property === "::before" && /counter\(/.test(u.value));

check(
  "7. a positioned ::before lands on its containing block, and an in-flow one on its row",
  Boolean(hlBox) &&
    hlDelta <= TOLERANCE &&
    arrowText === "\u2192" &&
    annSizeDelta <= TOLERANCE &&
    annRightGap <= TOLERANCE &&
    noPseudoChildren.length === 0 &&
    counterReported,
  `hairlineΔ=${hlDelta === Infinity ? "missing" : hlDelta.toFixed(2)}px, ::after text=${JSON.stringify(arrowText)}, ` +
    `flex spacer Δsize=${annSizeDelta === Infinity ? "missing" : annSizeDelta.toFixed(2)}px Δright=${annRightGap.toFixed(2)}px, ` +
    `content:none children=${noPseudoChildren.length}, counter() reported=${counterReported}` +
    (hlDelta > TOLERANCE ? `\n      got ${JSON.stringify(hlBox)} want ${JSON.stringify(hlTruth)}` : "")
);

// 23 — a host that draws BOTH pseudo-elements keeps both. One attribute names
//      which pseudos are suppressed, so materialising `::before` used to hide
//      `::after` before its computed content could be read.
const bothHost = boxes.find((b) => b.name === "div.both");
const bothPath = bothHost ? pathById.get(bothHost.id) : undefined;
const bothBefore = bothPath ? pseudoBox(`${bothPath}~before`) : null;
const bothAfter = bothPath ? pseudoBox(`${bothPath}~after`) : null;
const bothBeforeDelta = bothBefore && pseudoTruth[`${bothPath}~before`] ? delta(bothBefore, pseudoTruth[`${bothPath}~before`]) : Infinity;
const bothAfterDelta = bothAfter && pseudoTruth[`${bothPath}~after`] ? delta(bothAfter, pseudoTruth[`${bothPath}~after`]) : Infinity;
check(
  "23. a host that draws both ::before and ::after keeps both",
  Boolean(bothHost) &&
    Boolean(bothBefore) &&
    Boolean(bothAfter) &&
    bothBeforeDelta <= TOLERANCE &&
    bothAfterDelta <= TOLERANCE,
  `host=${bothPath ?? "missing"} ::before=${bothBefore ? "present" : "missing"}Δ=${bothBeforeDelta === Infinity ? "—" : bothBeforeDelta.toFixed(2)}px, ` +
    `::after=${bothAfter ? "present" : "missing"}Δ=${bothAfterDelta === Infinity ? "—" : bothAfterDelta.toFixed(2)}px`
);

// 8 — external bytes are brought across: a served bitmap and a served background
//     both land as asset-backed image paints, a relative path is reported with
//     the reason, and nothing is silently missing.
const localImg = pseudoBox("body/21");
const relativeImg = pseudoBox("body/22");
const bgImg = pseudoBox("body/23");
const bgImaged = bgImg ? bgImg.paintTypes.includes("image") : false;
const assetsAreData = payload.assetUris.length >= 2 && payload.assetUris.every((u) => u.startsWith("data:"));
const relativeReported = report.unmapped.some((u) => u.property === "img" && /relative path/.test(u.value));
// The relative bitmap never loads, so its ALT text is what the browser draws —
// that fallback is a text box and can be taller than the CSS box when the
// element's height is a percentage. This one sits in a 40×40 frame and must
// stay that size; the plain 20×20 neighbour is the fixed-height control.
const relativeDelta = relativeImg && truth["body/22"] ? delta(relativeImg, truth["body/22"]) : Infinity;
const altFrame = boxes.find((b) => b.name === "div.altframe");
const altImg = boxes.find((b) => b.parentId === altFrame?.id && b.type === "rect");
// The iframe draws the same alt fallback, so its own box is not the truth here;
// the authored CSS says the image fills its 40×40 frame.
const altDelta = altImg && altFrame ? delta(altImg, altFrame) : Infinity;

check(
  "8. an external bitmap is inlined, and the ones that cannot be say why",
  Boolean(localImg) &&
    localImg.paintTypes.includes("image") &&
    bgImaged &&
    bgImg.imageFits === "cover" &&
    assetsAreData &&
    relativeReported &&
    relativeDelta <= TOLERANCE &&
    altDelta <= TOLERANCE,
  `served <img> paints=${localImg ? localImg.paintTypes : "missing"}, background fit=${bgImg ? bgImg.imageFits : "missing"}, ` +
    `assets=${payload.assetCount} all data: ${assetsAreData}, relative path reported=${relativeReported}, ` +
    `missing bitmap box=${relativeImg ? Math.round(relativeImg.width) + "×" + Math.round(relativeImg.height) : "missing"} Δ=${relativeDelta === Infinity ? "missing" : relativeDelta.toFixed(2)}px, ` +
    `alt fallback box=${altImg ? Math.round(altImg.width) + "×" + Math.round(altImg.height) : "missing"} Δ=${altDelta === Infinity ? "missing" : altDelta.toFixed(2)}px`);

// 9 — a gradient that fades to `transparent` survives. It is the spelling every
//     hairline and every fade in a dark UI uses, and reading a transparent stop
//     as "no colour" dropped the whole ramp.
const fade = pseudoBox("body/20");
const fadeReported = report.unmapped.some((u) => u.path === "body/20" && u.property === "background-image");
check(
  "9. a gradient fading to `transparent` is converted, not reported",
  Boolean(fade) && fade.paintTypes.includes("linear-gradient") && !fadeReported,
  `paints=${fade ? fade.paintTypes : "missing"}, reported as unmappable=${fadeReported}`
);

// 10 — a grid whose tracks are all different and whose children are placed by
//      line number. A column COUNT cannot describe either, so this is the shape
//      that used to come out as an absolute-positioned pile.
const shellId = idByPath.get("body/24");
const shell = shellId ? byId.get(shellId) : null;
const shellChildren = boxes.filter((b) => b.parentId === shellId);
const shellKids = shellChildren.map((b) => {
  const t = truth[pathById.get(b.id)];
  return t ? delta(b, t) : Infinity;
});
const shellWorst = shellKids.reduce((worst, d) => Math.max(worst, d), 0);
const shellTracks = shell?.layout?.columnSizes?.length === 3 && shell?.layout?.rowSizes?.length === 3;
const shellDowngraded = report.downgraded.some((d) => d.id === shellId);

const spanRowId = idByPath.get("body/25");
const spanKid = byId.get(idByPath.get("body/25/0"));
const spanTruth = truth["body/25/0"];
const spanDelta = spanKid && spanTruth ? delta(spanKid, spanTruth) : Infinity;

check(
  "10. unequal tracks and explicit cell placement rebuild, span included",
  Boolean(shell) &&
    shellTracks &&
    !shellDowngraded &&
    shellChildren.length === 4 &&
    shellKids.every((d) => d <= TOLERANCE) &&
    spanKid?.cell?.columnSpan === 2 &&
    spanDelta <= TOLERANCE,
  `tracks=${shellTracks} downgraded=${shellDowngraded} children=${shellChildren.length} worstΔ=${shellWorst === Infinity ? "missing" : shellWorst.toFixed(2)}px, ` +
    `span cell=${JSON.stringify(spanKid?.cell ?? null)} Δ=${spanDelta === Infinity ? "missing" : spanDelta.toFixed(2)}px`
);

// 11 — a list marker is REPORTED, not approximated: its box cannot be derived
//      (Chrome places glyph and numeric markers by different rules), and a
//      bullet a few px off is a wrong element rather than an uneditable one.
const bulletMarkers = report.unmapped.filter((u) => u.property === "list-style");
const plainListReported = report.unmapped.some((u) => u.path.startsWith("body/27") && u.property === "list-style");
check(
  "11. a list marker is named, and a list that draws none is left alone",
  bulletMarkers.length === 2 && bulletMarkers.every((u) => u.value === "disc outside") && !plainListReported,
  `markers=${JSON.stringify(bulletMarkers.map((u) => u.value))} plain-list reported=${plainListReported}`
);

// 12 — ONE import, widened afterwards, still matches the browser. The shell's
//      middle track is `1fr`, so the change has to land there: the two fixed
//      tracks stay 120 and 80 and the flexible one grows. A track list that was
//      merely MEASURED in px cannot do this, which is why this criterion is red
//      until the tracks carry their ratio.
const wideKids = payload.wideBoxes.filter((b) => b.parentId === shellId);
let wideWorst = 0;
let wideMissing = 0;
for (const child of wideKids) {
  const t = payload.wideTruth[pathById.get(child.id)];
  if (!t) {
    wideMissing += 1;
    continue;
  }
  wideWorst = Math.max(wideWorst, delta(child, t));
}
const midKid = wideKids.find((b) => pathById.get(b.id) === "body/24/2");
check(
  `12. an import widened to ${WIDE_WIDTH}px still matches the browser — the 1fr track takes the change`,
  wideKids.length === 4 && wideMissing === 0 && wideWorst <= TOLERANCE,
  `children=${wideKids.length} missing=${wideMissing} worstΔ=${wideWorst === 0 && wideKids.length === 0 ? "missing" : wideWorst.toFixed(2)}px, ` +
    `middle track=${midKid ? Math.round(midKid.width) : "missing"}px (browser would put ${Math.round((payload.wideTruth["body/24/2"] ?? {}).width ?? 0)}px)`
);

// 14 — mixed content around a block child is PRESERVED as text elements, not dropped.
const mixedBox = boxes.find((b) => b.type === "frame" && pathById.get(b.id) === "body/29");
const mixedTexts = boxes.filter((b) => b.parentId === mixedBox?.id && b.type === "text");
const mixedNamedBoth = ["loose text before", "loose text after"].every((needle) =>
  mixedTexts.some((b) => (b.content ?? "").includes(needle))
);
check(
  "14. mixed content around a block child is preserved as text elements, not dropped",
  mixedNamedBoth && mixedTexts.length === 2,
  mixedTexts.length === 0
    ? "no text children found in mixed container"
    : mixedTexts.map((b) => `${b.id}: ${JSON.stringify(b.content)}`).join("; ")
);

// 15 — `z-index` becomes paint order. The renderer paints in array order and the
//      DSL has no z-index, so an overlay written BEFORE the shell it covers used
//      to be buried under it — `a.back` on brand-gold.html, visible on the page
//      and invisible in the canvas. The walk moves it after the siblings it
//      covers, and stops reporting the property once it has.
//
//      `.stacked` is the other half: it is `position: relative`, so moving it
//      would also move it, and the walk declines rather than shuffling an
//      in-flow sibling. That one must still be named.
const stackpair = boxes.find((b) => b.name === "div.stackpair");
const stackKids = boxes.filter((b) => b.parentId === stackpair?.id).map((b) => b.name);
const zPaths = report.unmapped.filter((u) => u.property === "z-index").map((u) => u.path);
const pathOf = (name) => pathById.get(boxes.find((b) => b.name === name)?.id);
const carried = !zPaths.includes(pathOf("div.under"));
const declined = zPaths.includes(pathOf("div.stacked"));
check(
  "15. an overlay written first is painted last; a z-index that could not be carried is still named",
  stackKids.length === 2 && stackKids[0] === "div.over" && stackKids[1] === "div.under" && carried && declined,
  stackKids.length === 0
    ? "div.stackpair did not import at all"
    : `${stackKids.join(" → ")}; overlay ${carried ? "carried" : "still reported"}, ` +
      `relative sibling ${declined ? "reported" : "silently dropped"}`
);

// 16 — `<defs>` / `<clipPath>` hold DEFINITIONS, not artwork. Their children's
//      computed `display` is `inline` and `getCTM()` answers for them, so nothing
//      in the importer's "is it invisible" test caught them: an icon that clipped
//      anything imported an extra black rectangle the size of the clip, painted
//      over the shape the author actually drew. The tell is the magenta the
//      `<defs>` rect is filled with — a colour used nowhere else on the page.
const defsIcon = boxes.find((b) => b.name === "svg.defsicon");
const defsKids = boxes.filter((b) => b.parentId === defsIcon?.id);
const defsMagenta = boxes.some((b) => /#FF00FF/i.test(b.fillSummary));
const clipRectDrawn = defsKids.some((b) => b.type === "path" && Math.round(b.width) === 6 && Math.round(b.height) === 6);
const drawnPath = defsKids.filter((b) => b.type === "path" && Math.round(b.width) === 16 && Math.round(b.height) === 16);
check(
  "16. shapes inside <defs>/<clipPath> are not drawn as artwork",
  Boolean(defsIcon) && defsKids.length === 1 && drawnPath.length === 1 && !defsMagenta && !clipRectDrawn,
  `children=${defsKids.length} (the 16×16 visible path=${drawnPath.length}), defs fill drawn=${defsMagenta}, ` +
    `6×6 clip rect drawn=${clipRectDrawn}`
);

// 17 — CSS points a corner gradient's line at the far CORNER, so its angle is the
//      box's own diagonal, not 45°. Chrome also rewrites the authored word order
//      (`to bottom right` → `to right bottom`), and the old table only knew the
//      authored one — every corner gradient silently became `to bottom` (180°).
const cornerBox = boxes.find((b) => b.name === "div.corner");
const cornerAngle = cornerBox?.gradientAngle ?? null;
const cornerWant = Math.round(((Math.atan2(100, -60) * 180) / Math.PI) * 100) / 100;
check(
  "17. a corner gradient keeps its true angle instead of collapsing to 180°",
  cornerAngle !== null && Math.abs(cornerAngle - cornerWant) < 0.5,
  `angle=${cornerAngle} want ${cornerWant} (a 100×60 box's diagonal; 180 is the bug)`
);

// 18 — `rotate:` is a standalone property, not part of `transform`: computed
//      `transform` is `none` and the value is on `rotate`. Reading only `transform`
//      meant the element was sized from its rotated AABB and then drawn upright.
//
//      And the box has to be the one BEFORE the turn. The DSL draws `rotation`
//      about the box's own centre, so storing the bound of the turn turns the
//      element twice: an 80×40 chevron turned 90° measures 40×80, and a 40×80 box
//      turned 90° is an 80×40 drawing. The centre is the only thing a turn leaves
//      alone, so that is what the box is checked against.
const rotatedBox = boxes.find((b) => b.name === "div.rotated");
const rotatedTruth = truth[pathById.get(rotatedBox?.id)];
const rotatedCentreGap =
  rotatedBox && rotatedTruth
    ? Math.max(
        Math.abs(rotatedBox.x + rotatedBox.width / 2 - (rotatedTruth.x + rotatedTruth.width / 2)),
        Math.abs(rotatedBox.y + rotatedBox.height / 2 - (rotatedTruth.y + rotatedTruth.height / 2))
      )
    : Infinity;
check(
  "18. a standalone `rotate:` becomes the rotation, about the box it turns",
  Boolean(rotatedBox) &&
    Math.abs((rotatedBox.rotation ?? 0) - 90) < 0.001 &&
    Math.round(rotatedBox.width) === 80 &&
    Math.round(rotatedBox.height) === 40 &&
    rotatedCentreGap <= TOLERANCE,
  `rotation=${rotatedBox ? rotatedBox.rotation : "missing"}, box=${rotatedBox ? `${Math.round(rotatedBox.width)}×${Math.round(rotatedBox.height)}` : "missing"} ` +
    `(want 80×40 — its own box, not the 40×80 bound of the turn), centreΔ=${rotatedCentreGap === Infinity ? "missing" : rotatedCentreGap.toFixed(2) + "px"}`
);

// 19 — a computed `stroke-dasharray` is unit-suffixed (`"4px, 4px"`), so the old
//      `split(/[\s,]+/).map(Number)` produced `[NaN, NaN]` and the dashes were
//      filtered away: every dashed icon imported solid, with nothing reported.
const dashedIcon = boxes.find((b) => b.name === "svg.dashed");
const dashedKid = boxes.find((b) => b.parentId === dashedIcon?.id && b.type === "path");
const dash = (dashedKid?.dashArray ?? "").split(",").filter(Boolean).map(Number);
check(
  "19. stroke-dasharray survives, unit-suffixed computed value included",
  dash.length === 2 && Math.abs(dash[0] - 4) < 0.01 && Math.abs(dash[1] - 4) < 0.01,
  `dashArray=${dashedKid ? JSON.stringify(dashedKid.dashArray) : "missing"} (computed is "4px, 4px")`
);

// 20 — the UA gives `<hr>` an `inset` border whose COLOUR Chrome keeps answering
//      as `rgb(128, 128, 128)` even after `border: 0`. Preferring that
//      unconditionally repainted every styled divider grey over the background
//      the author wrote; the two are told apart by WIDTH.
const ruleBox = boxes.find((b) => b.name === "hr.hrline");
check(
  "20. a borderless <hr> takes its background, not the UA's grey border colour",
  Boolean(ruleBox) && /#111111/i.test(ruleBox.strokeColor ?? ""),
  `stroke=${ruleBox ? ruleBox.strokeColor : "missing"} (border-top-color still computes to rgb(128,128,128))`
);

// 21 — an elliptical radius is the one shape here the dialect genuinely cannot
//      spell: `borderRadius` is a single number, so a 200×60 box's `50%` can only
//      be a circle. It must be NAMED, not approximated — a wrong radius is a
//      wrong element.
const ellipseBox = boxes.find((b) => b.name === "div.ellipse");
const ellipsePath = pathById.get(ellipseBox?.id);
const radiusNamed = report.unmapped.some((u) => u.path === ellipsePath && u.property === "border-radius");
check(
  "21. an elliptical border-radius is named rather than rounded into a circle",
  Boolean(ellipseBox) && radiusNamed,
  radiusNamed
    ? "reported as unmappable"
    : `${ellipsePath ?? "?"} has ${report.unmapped.filter((u) => u.path === ellipsePath).map((u) => u.property).join(",") || "no entry"}`
);

// 22 — `oklch()` is what Tailwind v4 writes by default. `parseCssColor` only knew
//      hex and `rgb()`, so these elements imported with NO fill at all and
//      nothing in `unmapped` — invisible in the canvas and invisible in the report.
const wideGamut = boxes.find((b) => b.name === "div.wideg");
check(
  "22. an oklch() background becomes a colour instead of vanishing",
  Boolean(wideGamut) && wideGamut.paintTypes.includes("solid"),
  `paints=${wideGamut ? wideGamut.paintTypes || "(none — the colour was dropped)" : "missing"}`
);

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const maxDelta = boxes.reduce((worst, box) => {
  // A turned element is deliberately NOT compared: the browser's rect is the
  // bound of its turn while the element's box is its own, so the two differ by
  // design and counting it here would report the fix as a 40px error.
  if (box.rotation !== null) return worst;
  const t = truth[pathById.get(box.id)];
  return t ? Math.max(worst, delta(box, t)) : worst;
}, 0);

console.log("\n=== HTML import probe ===");
console.log(`viewport        : ${VIEWPORT}`);
console.log(`elements        : ${payload.elementCount} (normalized ${payload.normalizedCount})`);
console.log(`assets          : ${payload.assetCount}`);
console.log(`unmapped        : ${report.unmapped.length}`);
console.log(`downgraded      : ${report.downgraded.length}`);
for (const d of report.downgraded) console.log(`   - ${d.name} (${d.id}) maxDelta ${d.maxDelta}px`);
console.log(`maxDelta (all)  : ${maxDelta.toFixed(2)}px`);
console.log(`maxTextDelta    : ${report.maxTextDelta}px`);

console.log("\n--- criteria ---");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);

if (report.unmapped.length > 0) {
  console.log("\n--- unmapped (first 20) ---");
  for (const u of report.unmapped.slice(0, 20)) console.log(`  ${u.path}  ${u.property}: ${u.value}`);
}

if (errors.length > 0) {
  console.log("\n--- page errors ---");
  for (const e of errors.slice(0, 8)) console.log(`  ${e}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "ALL CRITERIA PASS" : `${failed.length} CRITERION(S) FAILED`}\n`);
process.exit(failed.length === 0 ? 0 : 1);
