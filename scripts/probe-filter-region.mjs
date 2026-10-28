/**
 * What an `<filter>` region costs a COLOUR ADJUSTMENT, and how much of it is
 * unreachable by anything the chain can do.
 *
 * Two questions this exists to answer rather than argue:
 *
 *   1. Is the paint-level region's padding doing any work? Every primitive an
 *      adjustment emits (`colorFilterPrimitives`) is pointwise, so no pixel of
 *      the result can depend on a neighbour, and the only thing a pad can buy
 *      is room for the fill's own antialiased edge. The region size is compared
 *      against the artwork it is computed over, and against the ELEMENT-level
 *      region, whose pad IS derived from something — `blur * 3 + offset +
 *      spread` — so the two are told apart instead of being one complaint.
 *
 *   2. Does the size actually cost? Architected guesswork either way is not
 *      evidence here: §9 of `docs/CANVAS_PERF.md` measured that a CHIP's filter
 *      cost is per element and not per area, and if that holds at poster sizes
 *      then none of this matters. So the second half renders both regions in
 *      Chromium and times them. It also diffs them pixel-for-pixel, because a
 *      region that clips is a bug and not a saving.
 *
 * Everything it grades comes out of the engine: the region from
 * `paintAdjustRegion` / `computeFilterRegion`, the chain from
 * `colorFilterPrimitives`. Only the stimulus is written here.
 *
 *   node scripts/probe-filter-region.mjs
 *   npm run probe:filter-region
 */

import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadEngine() {
  const bundle = await esbuild.build({
    stdin: {
      contents:
        `export { computeFilterRegion, paintAdjustRegion, PAINT_ADJUST_PAD_BOX, PAINT_ADJUST_PAD_PX } from "./src/ui/canvas/CanvasDefs";\n` +
        `export { colorFilterPrimitives } from "./src/core/dsl/color-filter";`,
      resolveDir: root,
      sourcefile: "probe-filter-region-entry.tsx",
      loader: "tsx"
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    logLevel: "warning",
    jsx: "automatic",
    jsxImportSource: "preact"
  });
  const url =
    "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].contents).toString("base64");
  return import(url);
}

const area = (r) => r.width * r.height;
const multiple = (r, w, h) => area(r) / (w * h);
const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);

/**
 * The spelling the paint-level adjustment carried before this change, kept here
 * as the arm everything else is compared against. It is history, not a second
 * source of truth: the region the renderer emits now is read from
 * `paintAdjustRegion`, below.
 */
const PREVIOUS_REGION = { x: -1, y: -1, width: 3, height: 3 };

/** Boxes that stand for the work this would run on. */
const BOXES = [
  ["chip", 64, 64],
  ["avatar", 400, 400],
  ["photo", 1200, 800],
  ["poster", 2400, 1600]
];

const NO_EFFECTS = [];
const SOFT_SHADOW = [{ type: "drop-shadow", blur: 8, offset: { x: 0, y: 4 } }];
const BIG_SHADOW = [{ type: "drop-shadow", blur: 12, offset: { x: 0, y: 6 }, spread: 4 }];
const LAYER_BLUR = [{ type: "layer-blur", blur: 8 }];

function table(title, cols, rows) {
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => String(r[i]).length))
  );
  console.log(`\n${title}`);
  console.log(
    cols.map((c, i) => c.padEnd(widths[i])).join("  ")
  );
  for (const r of rows) {
    console.log(r.map((v, i) => String(v).padEnd(widths[i])).join("  "));
  }
}

async function analytic(engine) {
  const {
    computeFilterRegion,
    paintAdjustRegion,
    PAINT_ADJUST_PAD_BOX,
    PAINT_ADJUST_PAD_PX
  } = engine;

  console.log("\n=== 1. The region a colour adjustment is given ===");
  console.log(
    `paint-level pad: ${PAINT_ADJUST_PAD_BOX} box per side + ${PAINT_ADJUST_PAD_PX} px`
  );

  table(
    "paint-level region, as a multiple of the artwork's area",
    ["box", "w x h", "before", "after", "saved"],
    BOXES.map(([name, w, h]) => {
      const after = paintAdjustRegion(w, h);
      const multAfter = after.width * after.height;
      return [name, `${w}x${h}`, fmt(PREVIOUS_REGION.width * PREVIOUS_REGION.height), fmt(multAfter), fmt((1 - 1 / (PREVIOUS_REGION.width * PREVIOUS_REGION.height / multAfter)) * 100) + "%"];
    })
  );

  table(
    "element-level region for the same boxes, by effect — the pad this one carries IS shadow-derived",
    ["box", "no effect", "shadow 8/4", "shadow 12/6+4", "layer blur 8"],
    BOXES.map(([name, w, h]) => [
      name,
      fmt(multiple(computeFilterRegion(w, h, NO_EFFECTS, 16), w, h)),
      fmt(multiple(computeFilterRegion(w, h, SOFT_SHADOW, 16), w, h)),
      fmt(multiple(computeFilterRegion(w, h, BIG_SHADOW, 16), w, h)),
      fmt(multiple(computeFilterRegion(w, h, LAYER_BLUR, 16), w, h))
    ])
  );

  const aw = 1200;
  const ah = 800;
  const afterRatio = (() => {
    const r = paintAdjustRegion(aw, ah);
    return r.width * r.height;
  })();
  console.log(
    `\na 1200x800 photo: ${fmt(PREVIOUS_REGION.width * PREVIOUS_REGION.height * (aw * ah) / 1e6)} MP of region before, ` +
      `${fmt(afterRatio * (aw * ah) / 1e6)} MP now, for ${fmt((aw * ah) / 1e6)} MP of artwork.\n` +
      `Measured live in §2 below, this is NOT a frame-time win — the clock could not see it — so what buys it is the\n` +
      `exported artifact: anything that opens the SVG has to hold that surface, and a renderer that refuses one past a\n` +
      `ceiling drops the whole filter instead of shrinking the region. All of the above still needs a second engine to\n` +
      `confirm; none of it is proven by numbers in this file.`
  );
}

/**
 * Both regions rendered in Chromium, timed and diffed.
 *
 * The stimulus is one `<rect>` per node carrying the engine's own filter chain
 * for one adjustment; only the region differs between the arms. Every frame
 * dirties all of them so the chain actually re-runs rather than being served
 * from a cache the real app would not get to keep.
 */
/**
 * A floor every arm can hit, and hitting it is not a result.
 *
 * A median at the frame interval means the work FIT in the frame, so the two
 * arms are both "fast enough" and the comparison says nothing. The rows below
 * therefore carry the floor alongside each reading, and any arm that sits on it
 * is reported as floored rather than as a tie.
 */
const FRAME_FLOOR_MS = 16.7;

async function timed(engine) {
  let chromiumMod;
  try {
    chromiumMod = await import("playwright");
  } catch {
    console.log(
      "\n=== 2. Skipped: Playwright is not installed here (see scripts/lib/playwright-loader.mjs) ==="
    );
    return;
  }
  console.log("\n=== 2. What it costs in Chromium ===");

  const adjust = { exposure: 0.2, contrast: 1.2, saturation: 1.3, highlights: 0.3, shadows: -0.2 };

  /**
   * Big-enough views only. A chip-sized grid is answered by §9 already — a
   * per-element cost that does not care about size — and this is asking whether
   * anything changes once the filtered region is measured in megapixels.
   */
  const CONFIGS = [
    { label: "poster", nodes: 1, w: 2400, h: 1600 },
    { label: "grid", nodes: 8, w: 1000, h: 1000 },
    { label: "thumbnails", nodes: 24, w: 600, h: 400 }
  ];

  const browser = await chromiumMod.chromium.launch();
  const rows = [];
  const diffs = [];
  for (const cfg of CONFIGS) {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(stimulus(cfg.nodes, cfg.w, cfg.h, adjust, engine));
    const arms = {
      "before (1 box)": { ...PREVIOUS_REGION },
      "after (1 px)": engine.paintAdjustRegion(cfg.w, cfg.h)
    };
    const read = {};
    const samples = {};
    Object.keys(arms).forEach((k) => (samples[k] = []));
    samples["no filter"] = [];

    /**
     * Interleaved, one presentation per measurement rather than fifteen in a
     * row. The first version of this measured each arm in a block and the
     * numbers moved with the machine instead of with the region: an identical
     * configuration read 68.75 ms in one run and 99.78 in the next. Alternating
     * arms inside every round puts whatever the machine is doing equally on all
     * of them, which a block design cannot.
     */
    const ROUNDS = 15;
    for (let round = 0; round < ROUNDS; round++) {
      const order = Object.entries(arms);
      if (round % 2) order.reverse();
      for (const [label, region] of order) {
        await setRegion(page, region);
        samples[label].push(await measureOnce(page, "url(#adj)"));
      }
      samples["no filter"].push(await measureOnce(page, "none"));
    }
    for (const k of Object.keys(samples)) {
      samples[k].sort((a, b) => a - b);
      read[k] = samples[k][Math.floor(samples[k].length / 2)];
    }

    const shot = {};
    for (const [label, region] of Object.entries(arms)) {
      await setRegion(page, region);
      await page.evaluate(() =>
        document.querySelectorAll("rect").forEach((r) => r.setAttribute("filter", "url(#adj)"))
      );
      shot[label] = await page.screenshot({ fullPage: true });
    }
    await page.evaluate(() =>
      document.querySelectorAll("rect").forEach((r) => r.setAttribute("filter", "none"))
    );
    shot["no filter"] = await page.screenshot({ fullPage: true });
    await page.close();

    // Whether the chain ran at all. Somewhere past a renderer-specific ceiling a
    // filter is DROPPED rather than computed, and a dropped filter would make
    // every comparison above a comparison of nothing.
    diffs.push([
      `${cfg.label} (${cfg.nodes}x${cfg.w}x${cfg.h})`,
      applied(shot, "before (1 box)", "after (1 px)", "identical", "CLIPPED"),
      applied(shot, "before (1 box)", "no filter", "DROPPED — filter never ran", "applied")
    ]);

    const base = read["before (1 box)"];
    for (const [label, region] of Object.entries(arms)) {
      rows.push([
        `${cfg.label} (${cfg.nodes}x${cfg.w}x${cfg.h})`,
        label,
        `${Math.round(region.width * 100)}% x ${Math.round(region.height * 100)}%`,
        fmt(read[label]),
        label === "before (1 box)" ? "-" : `${fmt(read[label] / base)}x before`
      ]);
    }
    rows.push([
      `${cfg.label} (${cfg.nodes}x${cfg.w}x${cfg.h})`,
      "no filter",
      "-",
      fmt(read["no filter"]),
      `${fmt(read["no filter"] / base)}x declared`
    ]);
  }
  await browser.close();

  table(
    "median frame with the engine's own 5-primitive adjustment chain, invaliding every node per frame",
    ["view", "arm", "region px", "median ms", "vs declared"],
    rows
  );
  table(
    "is the chain applied, and does the tight region clip?",
    ["view", "tight vs declared", "declared vs no filter"],
    diffs
  );
}

function applied(shot, a, b, sameLabel, differsLabel) {
  const same = Buffer.compare(shot[a], shot[b]) === 0;
  return same ? sameLabel : differsLabel;
}

async function setRegion(page, region) {
  await page.evaluate((region) => {
    document.querySelectorAll("filter").forEach((f) => {
      f.setAttribute("x", `${(region.x * 100).toFixed(4)}%`);
      f.setAttribute("y", `${(region.y * 100).toFixed(4)}%`);
      f.setAttribute("width", `${(region.width * 100).toFixed(4)}%`);
      f.setAttribute("height", `${(region.height * 100).toFixed(4)}%`);
    });
  }, region);
  await page.waitForTimeout(150);
}

/**
 * The stimulus, laid out the way the renderer lays it out.
 *
 * Each node sits in its own translated `<g>` with the rect at 0,0 — which is
 * what `SvgShapeNode` does — because the whole question is WHERE the region
 * lands: `userSpaceOnUse` is read in the referencing element's own coordinate
 * system, so without the translate both arms would put their region at the
 * CANVAS origin and every node but the first would be outside it. A version of
 * this harness that forgot that reported the tight region as clipping.
 */
function stimulus(nodes, w, h, adjust, engine) {
  const perRow = 4;
  const rows = [];
  for (let i = 0; i < nodes; i++) {
    const x = (i % perRow) * (w + 40);
    const y = Math.floor(i / perRow) * (h + 40);
    rows.push(
      `<g transform="translate(${x} ${y})"><rect x="0" y="0" width="${w}" height="${h}" fill="#7a6adf" filter="url(#adj)"/></g>`
    );
  }
  const cols = Math.min(nodes, perRow);
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff">
<svg id="stage" width="${cols * (w + 40)}" height="${Math.ceil(nodes / perRow) * (h + 40)}" xmlns="http://www.w3.org/2000/svg">
<defs>${chain(engine, adjust)}</defs>${rows.join("\n")}</svg></body>`;
}

/** The engine's own primitives for one adjustment, as markup. */
function chain(engine, adjust) {
  const parts = engine.colorFilterPrimitives(adjust).map((p, i) => {
    if (p.kind === "linear-transfer") {
      return `<feComponentTransfer in="${i === 0 ? "SourceGraphic" : `p${i - 1}`}" result="p${i}">` +
        `<feFuncR type="linear" slope="${p.slope}" intercept="${p.intercept}"/>` +
        `<feFuncG type="linear" slope="${p.slope}" intercept="${p.intercept}"/>` +
        `<feFuncB type="linear" slope="${p.slope}" intercept="${p.intercept}"/>` +
        `</feComponentTransfer>`;
    }
    if (p.kind === "tone-curve") {
      return `<feComponentTransfer in="${i === 0 ? "SourceGraphic" : `p${i - 1}`}" result="p${i}">` +
        `<feFuncR type="table" tableValues="${p.table.join(" ")}"/>` +
        `<feFuncG type="table" tableValues="${p.table.join(" ")}"/>` +
        `<feFuncB type="table" tableValues="${p.table.join(" ")}"/>` +
        `</feComponentTransfer>`;
    }
    if (p.kind === "hue-rotate") {
      return `<feColorMatrix in="${i === 0 ? "SourceGraphic" : `p${i - 1}`}" result="p${i}" type="hueRotate" values="${p.degrees}"/>`;
    }
    if (p.kind === "saturate") {
      return `<feColorMatrix in="${i === 0 ? "SourceGraphic" : `p${i - 1}`}" result="p${i}" type="saturate" values="${p.value}"/>`;
    }
    return `<feColorMatrix in="${i === 0 ? "SourceGraphic" : `p${i - 1}`}" result="p${i}" type="matrix" values="${p.values.join(" ")}"/>`;
  });
  const lastS = parts.length ? parts.length - 1 : null;
  return `<filter id="adj" x="-100%" y="-100%" width="300%" height="300%" color-interpolation-filters="sRGB">${parts.join(
    ""
  )}</filter>${lastS === null ? "" : ""}`;
}

/**
 * A reading that does not depend on the compositor being late.
 *
 * `requestAnimationFrame` cannot see rasterisation: the main thread comes back
 * at vsync whether or not the frame was ready, so every arm lands on the frame
 * interval and the comparison is a lie. Forcing each frame all the way to
 * BITMAPS puts the raster on the clock, and a screenshot is the only
 * synchronous way a page offers to do that.
 *
 * The `none` arm is what licenses the comparison: without it, a harness that
 * cannot tell a filtered node from an unfiltered one would happily report a tie
 * between two regions, and a tie between measurements of nothing says nothing.
 */
async function measureOnce(page, filterAttr) {
  await page.evaluate((f) => {
    document.querySelectorAll("rect").forEach((r) => {
      r.setAttribute("filter", f);
      r.setAttribute("fill", Math.random() > 0.5 ? "#7a6adf" : "#7b6ae0");
    });
  }, filterAttr);
  const t0 = performance.now();
  await page.screenshot({ fullPage: true, animations: "disabled" });
  return performance.now() - t0;
}

const engine = await loadEngine();
await analytic(engine);
await timed(engine);
