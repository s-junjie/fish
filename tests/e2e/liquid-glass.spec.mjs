import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Liquid Glass, measured rather than eyeballed.
 *
 * The material is nine parameters, and the claim this spec has to test is that
 * they mean what the model says they mean. So it does NOT assert on markup alone
 * — markup is exactly what passed while the effect was a fogged window:
 *
 *  1. the authoring surface is Figma's nine, in Figma's order, under Figma's
 *     names — not the three reverse-engineered knobs it replaced;
 *  2. the backdrop chain is `blur(Frost) url(#field)`, in that order;
 *  3. the displacement filter is laid out in user units over the map's box, and
 *     Dispersion really does produce three passes at three scales;
 *  4. **the field itself** — the baked PNG is decoded and every sample along a
 *     scanline through the left rim is compared against the deflection profile,
 *     which is the only measurement here that does not depend on what the
 *     backdrop happened to draw. A test that fires a stimulus and looks at the
 *     result measures the stimulus;
 *  5. the dark edge is a thin band at the border that follows `(1-u/darkW)^1.6`,
 *     not a tint over the panel;
 *  6. the rim is DIRECTIONAL: with Light angle -35 the top edge carries ink and
 *     the bottom edge does not;
 *  7. end to end: over a striped backdrop the bars really do slide inside the
 *     rim, by the amount the profile predicts, and by nothing when Refraction
 *     is 0.
 *
 * On measuring the last one: the displacement is evaluated AT THE DESTINATION,
 * so where a source edge at `p` lands is the fixed point of
 * `x = p + peak·profile(x/Depth)` — not `p + peak·profile(p/Depth)`, which is off
 * by a fifth of the throw at the far end of the band. And it is point-sampled,
 * so at 1x the answer is only resolved to the sample pitch (1/k doc px); the
 * page is rendered at 3x so the edge can be located to a tenth of a pixel.
 * Getting either wrong turns a working implementation into a 5px "shift".
 */
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const DPR = 3;
const results = [];
const pageErrors = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

/* The model, restated here on purpose: this spec pins the FORMULAE and the
   constants, so a change to them in `src/core/dsl/liquid-glass.ts` fails here
   rather than quietly redefining what "Depth" or "Dispersion" means. */
const PROFILE_A = 0.12;
const PROFILE_B = 1.8;
const PROFILE_PEAK_U = PROFILE_A / (PROFILE_A + PROFILE_B);
const PROFILE_NORM = Math.pow(PROFILE_PEAK_U, PROFILE_A) * Math.pow(1 - PROFILE_PEAK_U, PROFILE_B);
const profile = (u) =>
  u <= 0 || u >= 1 ? 0 : (Math.pow(u, PROFILE_A) * Math.pow(1 - u, PROFILE_B)) / PROFILE_NORM;
const PEAK_RATIO = 0.55;
const DISP_SPREAD = 0.5;
const SPREAD = (splay) => 0.1 + 0.9 * (splay / 100);

/* Figma's names, in Figma's order. Figma publishes neither the units nor the
   mapping; it does publish these. */
const FIGMA_PARAMS = [
  "Refraction",
  "Depth",
  "Dispersion",
  "Frost",
  "Splay",
  "Light angle",
  "Light intensity"
];

/* The panel is 400x240 with a 30px corner. Depth 19 sits well inside the short
   side, so the band from one rim never reaches the other. */
const DEPTH = 19;
const EFF_DEPTH = DEPTH;
const PANEL = { x: 260, y: 170, width: 400, height: 240, r: 30, depth: DEPTH };
const CANVAS = { width: 840, height: 580 };
const BAND_PITCH = 36;
const BAND_BAR = 14;
const peakOf = (refraction, depth) => (refraction / 100) * depth * PEAK_RATIO;

const glass = (over = {}) => ({
  type: "liquid-glass",
  frost: 0,
  refraction: 70,
  depth: DEPTH,
  dispersion: 0,
  lightAngle: -35,
  lightIntensity: 0,
  splay: 20,
  fill: 0,
  stroke: 0,
  enabled: true,
  ...over
});

const stripes = [
  {
    id: "band_bg",
    type: "rect",
    x: 0,
    y: 0,
    width: CANVAS.width,
    height: CANVAS.height,
    fills: [{ type: "solid", color: "#F6F6FA" }]
  }
];
const barStarts = [];
for (let x = 18; x < CANVAS.width - BAND_BAR; x += BAND_PITCH) {
  barStarts.push(x);
  stripes.push({
    id: `band_${x}`,
    type: "rect",
    x,
    y: 0,
    width: BAND_BAR,
    height: CANVAS.height,
    fills: [{ type: "solid", color: "#0A0A0F" }]
  });
}
/* The first bar with its whole left edge inside the rim: clearing the 1.9px dark
   edge keeps the edge under test out of the overlay's way. */
const BAR = barStarts.find((x) => x - PANEL.x > 4);
const BAR_INSIDE = BAR - PANEL.x;

const fixture = (effects) => ({
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: CANVAS.width, height: CANVAS.height },
      children: [
        ...stripes,
        {
          id: "panel",
          type: "rect",
          name: "Glass",
          x: PANEL.x,
          y: PANEL.y,
          width: PANEL.width,
          height: PANEL.height,
          borderRadius: PANEL.r,
          fillEnabled: false,
          effects
        }
      ]
    }
  ],
  activePageId: "p1"
});

const settle = (page) =>
  page.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80)))
      )
  );
const apply = (page, doc) =>
  page.evaluate(async (d) => {
    window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(d).document);
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80)))
    );
  }, doc);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: DPR
});
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

/* ------------------------------------------------ 1. the authoring surface */

await apply(page, fixture([glass()]));
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("panel"));
await page.waitForTimeout(250);
const opened = await page.evaluate(() => {
  const row = document.querySelector('[data-ui-panel="right"] [data-effect-row="0"]');
  if (!row) return { row: false };
  row.click();
  return { row: true };
});
await page.waitForTimeout(250);
const surface = await page.evaluate(() => {
  const row = document.querySelector('[data-ui-panel="right"] [data-effect-row="0"]');
  const panel = document.querySelector('[data-effect-panel]') || row?.nextElementSibling;
  if (!panel) return null;
  return [...panel.querySelectorAll("[data-scrub-label]")].map((n) => n.getAttribute("data-scrub-label"));
});
check("the effect row opens its parameter panel", opened.row && surface !== null, `${surface?.length ?? 0} field(s)`);
check(
  "the seven parameters are Figma's, in Figma's order",
  JSON.stringify(surface) === JSON.stringify(FIGMA_PARAMS),
  surface ? surface.join(", ") : "(no panel)"
);
check(
  "the reverse-engineered knobs are gone",
  !(surface || []).some((l) => ["Blur", "Saturation", "Brightness", "Radius"].includes(l)),
  "no Blur / Saturation / Brightness / Radius"
);

/* ------------------------------------------------- 2. the chain and graph */

const full = await page.evaluate(async (doc) => {
  window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(doc).document);
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80)))
  );
  const group = document.querySelector('[data-element-id="panel"]');
  const div = group?.querySelector("foreignObject > div");
  const filter = document.querySelector("#lg_refract_panel");
  const maps = filter ? [...filter.querySelectorAll("feDisplacementMap")] : [];
  const feImage = filter?.querySelector("feImage");
  const img = feImage
    ? {
        x: Number(feImage.getAttribute("x")),
        y: Number(feImage.getAttribute("y")),
        width: Number(feImage.getAttribute("width")),
        height: Number(feImage.getAttribute("height"))
      }
    : null;
  return {
    backdrop: div ? getComputedStyle(div).backdropFilter : null,
    box: group ? group.querySelector("foreignObject")?.getAttribute("width") : null,
    /* The div IS the element's box, never grown: a grown box needs a `clip-path`
       to stay on the shape, and Chromium flattens that to a rectangle under any
       clipping frame, so a rounded panel would sit on a square frosted plate. The
       pad therefore lives on the filter region below, and the shape clip here is
       `border-radius` — the one clip that survives. */
    divBox: div
      ? {
          width: parseFloat(getComputedStyle(div).width),
          height: parseFloat(getComputedStyle(div).height),
          radius: getComputedStyle(div).borderRadius,
          clip: getComputedStyle(div).clipPath
        }
      : null,
    region: filter
      ? {
          x: Number(filter.getAttribute("x")),
          y: Number(filter.getAttribute("y")),
          width: Number(filter.getAttribute("width")),
          height: Number(filter.getAttribute("height")),
          units: filter.getAttribute("filterUnits")
        }
      : null,
    img,
    dispScales: maps.map((m) => Number(m.getAttribute("scale"))),
    chan: {
      x: maps[0]?.getAttribute("xChannelSelector"),
      y: maps[0]?.getAttribute("yChannelSelector")
    },
    mapHref: feImage?.getAttribute("href") || feImage?.getAttribute("xlink:href") || ""
  };
}, fixture([glass({ frost: 10, dispersion: 22, lightIntensity: 45 })]));

/* Dispersions's fringe is the widest throw either channel makes, so the map is
   padded by the red throw; the ring is what keeps channel 0 (minus half the
   scale, i.e. a violent jump) out of the filter's reach.

   The pad is spelled on the FILTER, not on the div: growing the div by it would
   force a `clip-path` to keep the shape, which Chromium flattens to a rectangle.
   So the region and the map are anchored at `-pad` — past the border box the
   filter is applied to — while the div stays exactly the element's box. The two
   are one number read twice, which is what the assertion below pins. */
const padFor = (dispersion) =>
  Math.ceil(peakOf(70, DEPTH) * (1 + DISP_SPREAD * (dispersion / 100))) + 2;

check(
  "backdrop chain is blur(Frost) then the field",
  /^blur\(5px\) url\(["']?#lg_refract_panel["']?\)$/.test(full.backdrop || ""),
  full.backdrop || "(none)"
);
check("the glass group carries a backdrop div", full.box !== null, `foreignObject width ${full.box}`);
check("the filter is laid out in user units", full.region?.units === "userSpaceOnUse", JSON.stringify(full.region));
/* The pad is the map's overhang past the element's own box, which is the only
   place the geometry still records it: the foreignObject is the element's box
   and the feImage is the map's, so half their difference is the `-x` the filter
   is anchored at. Everything below then reads the map in the same space. */
const mapPad = full.region ? (full.region.width - Number(full.box)) / 2 : NaN;

check(
  "the filter region is the map's box, hung -pad around the un-grown div",
  full.region?.x === -mapPad &&
    full.region?.y === -mapPad &&
    full.img?.x === -mapPad &&
    full.img?.y === -mapPad &&
    full.region?.width === Number(full.box) + mapPad * 2 &&
    full.region?.height === PANEL.height + mapPad * 2 &&
    full.divBox?.width === Number(full.box) &&
    full.divBox?.height === PANEL.height &&
    /^30px/.test(full.divBox?.radius || "") &&
    (full.divBox?.clip ?? "none") === "none" &&
    mapPad === padFor(22),
  `region ${full.region?.x},${full.region?.y} ${full.region?.width}x${full.region?.height}, ` +
    `map ${full.img?.x},${full.img?.y}, div ${full.divBox?.width}x${full.divBox?.height} ` +
    `radius ${full.divBox?.radius} clip ${full.divBox?.clip}, pad ${mapPad}, expected ${padFor(22)}`
);
check(
  "Dispersion splits the throw across three passes",
  full.dispScales.length === 3 &&
    full.dispScales[0] > full.dispScales[1] &&
    full.dispScales[1] > full.dispScales[2] &&
    Math.abs(full.dispScales[1] - 2 * peakOf(70, DEPTH)) < 1e-9 &&
    Math.abs(full.dispScales[0] - 2 * peakOf(70, DEPTH) * (1 + DISP_SPREAD * 0.22)) < 1e-9 &&
    full.chan.x === "R" &&
    full.chan.y === "G",
  `scales ${full.dispScales.map((s) => s.toFixed(3)).join(" / ")}, channels ${full.chan.x}/${full.chan.y}`
);
check("the map is an embedded PNG", /^data:image\/png;base64,/.test(full.mapHref), `${full.mapHref.length} chars`);

/* ------------------------------------------- 3. the field, sample by sample */

const fieldProbe = await page.evaluate(async (doc) => {
  window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(doc).document);
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80)))
  );
  const feImage = document.querySelector("#lg_refract_panel feImage");
  const href = feImage?.getAttribute("href") || feImage?.getAttribute("xlink:href") || "";
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = href;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  /* Mid-height row of the map, so the left edge's normal is exactly -x and the
     row index cannot land in a corner. The map is baked at the VIEW scale, so a
     texel is 1/scale document px and every index below is a document coordinate
     times that — the same mapping the overlay probe needs, for the same reason.

     The map's box is not the element's box: it carries the lens pad on every
     side, which is what the filter's `-pad` anchor places it by. Measured as the
     overhang past the foreignObject, so it cannot drift from the renderer. */
  const fo = document.querySelector('[data-element-id="panel"] foreignObject');
  const pad = (Number(feImage.getAttribute("width")) - Number(fo.getAttribute("width"))) / 2;
  const scale = c.width / (400 + pad * 2); // 400 = PANEL.width, out of scope here
  const row = Math.round((120 + pad) * scale);
  const samples = [];
  for (let i = 0; i < Math.ceil(20 * scale); i++) {
    const x = (i + 0.5) / scale - pad; // distance inside the left edge
    samples.push({
      x,
      r: data[(row * c.width + i) * 4] / 255,
      g: data[(row * c.width + i) * 4 + 1] / 255
    });
  }
  return { w: c.width, h: c.height, pad, scale, samples };
}, fixture([glass()]));

let worst = 0;
const trace = [];
for (const s of fieldProbe.samples) {
  const u = s.x / EFF_DEPTH;
  const expectedR = 0.5 + 0.5 * profile(u); // inward normal is +x on the left edge
  const err = Math.max(Math.abs(s.r - expectedR), Math.abs(s.g - 0.5)) * 255;
  worst = Math.max(worst, err);
  if (s.x <= 6 && trace.length < 24) trace.push(`${s.x.toFixed(1)}px:${(s.r * 255).toFixed(0)}`);
}
check(
  "map geometry is the map's box, at or above one texel per document pixel",
  fieldProbe.pad === padFor(0) &&
    fieldProbe.scale >= 1 &&
    Math.abs(fieldProbe.h - (PANEL.height + fieldProbe.pad * 2) * fieldProbe.scale) <= 1,
  `${fieldProbe.w}x${fieldProbe.h} texels for ${PANEL.width + fieldProbe.pad * 2}x` +
    `${PANEL.height + fieldProbe.pad * 2} doc px, pad ${fieldProbe.pad}, scale ${fieldProbe.scale.toFixed(2)}`
);
check(
  "the baked field follows the deflection profile",
  worst <= 8,
  `worst error ${worst.toFixed(1)}/255 over 20 samples at the left rim (${trace.join(" ")})`
);
/* A field that is simply neutral would also be "close to 0.5" if the profile
   were wrong everywhere, so pin the peak too: near the outer rim the red channel
   must be at its furthest from neutral. */
const deepest = fieldProbe.samples.reduce(
  (best, s) => (Math.abs(s.r - 0.5) > Math.abs(best.r - 0.5) ? s : best),
  fieldProbe.samples[0]
);
check(
  "the peak sits near the outer rim",
  Math.abs(deepest.x / EFF_DEPTH - PROFILE_PEAK_U) < 0.08,
  `peak at ${deepest.x.toFixed(1)}px = ${(deepest.x / EFF_DEPTH).toFixed(2)} of Depth ${DEPTH} (eff ${EFF_DEPTH})`
);

/* ------------------------------------ 3b. the field's normal is smooth */

const ellipseFixture = (over) => ({
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: 520, height: 320 },
      children: [
        { id: "disc", type: "ellipse", name: "Disc", x: 60, y: 40, width: 240, height: 240,
          fillEnabled: false, effects: [glass(over)] }
      ]
    }
  ],
  activePageId: "p1"
});

const ovalFixture = (over) => ({
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: 520, height: 360 },
      children: [
        { id: "oval", type: "ellipse", name: "Oval", x: 60, y: 40, width: 348, height: 254,
          fillEnabled: false, effects: [glass(over)] }
      ]
    }
  ],
  activePageId: "p1"
});

const sharpRectFixture = (over) => ({
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: 320, height: 320 },
      children: [
        { id: "box", type: "rect", name: "Box", x: 40, y: 40, width: 240, height: 240,
          borderRadius: 0, cornerSmoothing: 0, fillEnabled: false, effects: [glass(over)] }
      ]
    }
  ],
  activePageId: "p1"
});

const smoothRectFixture = (over) => ({
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: 320, height: 320 },
      children: [
        { id: "sbox", type: "rect", name: "SmoothBox", x: 40, y: 40, width: 240, height: 240,
          borderRadius: 40, cornerSmoothing: 0.6, fillEnabled: false, effects: [glass(over)] }
      ]
    }
  ],
  activePageId: "p1"
});

/* Only where the profile is actually carrying ink is measured: at the very rim it
   is zero by construction, so a direction error there displaces nothing. */
const STEEP = 0.5; // radians, the turn that counts as a break
const normalStats = (fixture, id) =>
  page.evaluate(async ({ doc, id, steep }) => {
    window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(doc).document);
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120)))
    );
    const href = document.querySelector(`#lg_refract_${id} feImage`)?.getAttribute("href") || "";
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = href;
    });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const nx = (i) => data[i * 4] / 255 - 0.5;
    const ny = (i) => data[i * 4 + 1] / 255 - 0.5;
    const s = (i) => Math.hypot(nx(i), ny(i)) * 2; // the profile value, 0-1
    let worst = 0;
    let breaks = 0;
    let band = 0;
    for (let y = 1; y < c.height - 1; y++) {
      for (let x = 1; x < c.width - 1; x++) {
        const k = x + y * c.width;
        if (s(k) < 0.3) continue;
        band++;
        for (const k2 of [k + 1, k + c.width]) {
          if (s(k2) < 0.3) continue;
          const dot = nx(k) * nx(k2) + ny(k) * ny(k2);
          const cross = nx(k) * ny(k2) - ny(k) * nx(k2);
          const da = Math.abs(Math.atan2(cross, dot));
          if (da > steep) breaks++;
          if (da > worst) worst = da;
        }
      }
    }
    return { size: `${c.width}x${c.height}`, worstDeg: (worst * 180) / Math.PI, breaks, band };
  }, { doc: fixture, id, steep: STEEP });

const curved = await normalStats(ellipseFixture({ depth: 60, refraction: 100 }), "disc");
check(
  "a curved shape's normal turns smoothly, texel to texel",
  curved.band > 2000 && curved.worstDeg < 30 && curved.breaks === 0,
  `${curved.size}, worst turn ${curved.worstDeg.toFixed(1)}° over ${curved.band} texels of band, ` +
    `${curved.breaks} break(s) over ${((STEEP * 180) / Math.PI).toFixed(1)}°`
);

const ovalCurved = await normalStats(ovalFixture({ depth: 76, refraction: 80 }), "oval");
check(
  "a non-circular oval's normal turns smoothly even at deep bevels (no curve creases)",
  ovalCurved.band > 2000 && ovalCurved.worstDeg < 30 && ovalCurved.breaks === 0,
  `${ovalCurved.size}, worst turn ${ovalCurved.worstDeg.toFixed(1)}° over ${ovalCurved.band} texels of band, ` +
    `${ovalCurved.breaks} break(s)`
);

/* Depth 30 on a 240px square puts the whole inner box inside the band, so every
   texel of it is measured — the corners AND the diagonals that run out of them. */
const squared = await normalStats(sharpRectFixture({ depth: 30, refraction: 70 }), "box");
check(
  "a sharp corner's normal turns smoothly across the medial axis too",
  squared.band > 20000 && squared.worstDeg < 20 && squared.breaks === 0,
  `${squared.size}, worst turn ${squared.worstDeg.toFixed(1)}° over ${squared.band} texels of band, ` +
    `${squared.breaks} break(s)`
);

const smoothed = await normalStats(smoothRectFixture({ depth: 30, refraction: 70 }), "sbox");
check(
  "a smoothed squircle's normal turns smoothly across the rim too",
  smoothed.band > 20000 && smoothed.worstDeg < 25 && smoothed.breaks === 0,
  `${smoothed.size}, worst turn ${smoothed.worstDeg.toFixed(1)}° over ${smoothed.band} texels of band, ` +
    `${smoothed.breaks} break(s)`
);

/* ------------------------------------------------------ 4/5. rim overlays */

const overlays = await page.evaluate(async (doc) => {
  window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(doc).document);
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80)))
  );
  const group = document.querySelector('[data-element-id="panel"]');
  const images = [...group.querySelectorAll("image")];
  const read = async (href) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = href;
    });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  };
  if (images.length < 1) return { count: images.length };
  const light = await read(images[0].getAttribute("href"));
  const scale = light.width / 400;
  const at = (im, cellX, cellY) => {
    const j = Math.min(im.height - 1, Math.max(0, Math.round(cellY * scale - 0.5)));
    const i = Math.min(im.width - 1, Math.max(0, Math.round(cellX * scale - 0.5)));
    return im.data[(j * im.width + i) * 4 + 3];
  };
  const inward = (im, n, from) => {
    const out = [];
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / scale;
      out.push({
        t,
        a:
          from === "bottom"
            ? at(im, 200.5, 240 - 0.5 - t)
            : from === "left"
              ? at(im, t, 120.5)
              : at(im, 200.5, t)
      });
    }
    return out;
  };
  return {
    count: images.length,
    size: `${light.width}x${light.height}`,
    scale,
    lightTop: inward(light, Math.ceil(8 * scale) + 2, "top"),
    lightBottom: inward(light, 8, "bottom"),
    lightLeft: at(light, 0.5, 120.5),
    lightRight: at(light, 399.5, 120.5)
  };
}, fixture([glass({ lightIntensity: 45 })]));

check(
  "the panel carries a clean specular rim without a muddy dark ring",
  overlays.count === 1,
  `${overlays.count} overlay image(s), ${overlays.size}, baked at ${overlays.scale?.toFixed(2)}x`
);
check(
  "the light is directional, with a subtle opposite-edge reflection",
  overlays.lightTop &&
    overlays.lightTop[0].a > 3 * overlays.lightBottom[0].a &&
    overlays.lightBottom[0].a > 0 &&
    overlays.lightLeft > 2 * overlays.lightRight,
  `top ${overlays.lightTop?.[0].a} bottom ${overlays.lightBottom?.[0].a} ` +
    `left ${overlays.lightLeft} right ${overlays.lightRight} at Light angle -35`
);
/* The light is `intensity · env · fall`, and along the middle of the top edge
   `env` is constant (the normal does not turn), so the whole profile is the
   falloff — normalised to its first sample it is pinned exactly, which is what
   says "Splay spreads the light" rather than "there is a gradient here". */
const fallAt = (t) => {
  const lim = t / EFF_DEPTH / SPREAD(20);
  return lim <= 0 ? 1 : lim >= 1 ? 0 : Math.pow(1 - lim, 2.5);
};
const lightRef = overlays.lightTop ? overlays.lightTop[0].a / fallAt(overlays.lightTop[0].t) : 0;
const lightErr = overlays.lightTop
  ? Math.max(
      ...overlays.lightTop.map((s) => Math.abs(s.a - Math.round(lightRef * fallAt(s.t))))
    )
  : Infinity;
check(
  "the light follows Splay's falloff and is gone well inside Depth",
  lightErr <= 1 && overlays.lightTop?.slice(-1)[0].a === 0,
  `top ${overlays.lightTop?.map((s) => s.a).join("/")} vs ` +
    `${overlays.lightTop?.map((s) => Math.round(lightRef * fallAt(s.t))).join("/")} expected, ` +
    `worst ${lightErr}, tail ${overlays.lightTop?.slice(-1)[0].a}`
);

/* -------------------------------------- 5c. Depth 1 does not flood the panel */

const deepInside = await page.evaluate(async (doc) => {
  window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(doc).document);
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120)))
  );
  const group = document.querySelector('[data-element-id="panel"]');
  const images = [...group.querySelectorAll("image")];
  if (images.length < 1) return { count: images.length };
  const read = async (href) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = href;
    });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  };
  const light = await read(images[0].getAttribute("href"));
  const scale = light.width / 400;
  const at = (im, cellX, cellY) => {
    const j = Math.min(im.height - 1, Math.max(0, Math.round(cellY * scale - 0.5)));
    const i = Math.min(im.width - 1, Math.max(0, Math.round(cellX * scale - 0.5)));
    return im.data[(j * im.width + i) * 4 + 3];
  };
  return {
    count: images.length,
    light: [0.15, 2, 20].map((d) => at(light, 200.5, d)),
    mid: at(light, 200.5, 120.5)
  };
}, fixture([glass({ depth: 1, lightIntensity: 45 })]));

check(
  "Depth 1 confines the light to a rim instead of lighting the whole panel",
  deepInside.count === 1 &&
    deepInside.light[0] > 0 &&
    deepInside.light[1] === 0 &&
    deepInside.light[2] === 0 &&
    deepInside.mid === 0,
  `light at 0.15/2/20px in: ${deepInside.light?.join("/")}, centre ${deepInside.mid}`
);

/* --------------------------------------------- 5b. the bake follows the view */

/* The baked bitmaps are laid out in user units, so the canvas zoom magnifies
   them; a bake that ignored the view would be correct at 100 % and a staircase
   everywhere else. Pinned by re-baking the same panel at a different device
   scale and comparing the texel count, which is the only thing the view scale is
   allowed to change — the filter region and the image extents are in the same
   user units either way, and section 2 already checks those. */
const BAKE_SCALES = [1, 1.5, 2, 3, 4, 6, 8];
const MAX_BAKE_SIDE = 1152;
const bakedSide = (zoom, dpr, docSide) => {
  const target = Math.max(1, zoom) * Math.max(1, dpr);
  let s = BAKE_SCALES[BAKE_SCALES.length - 1];
  for (const v of BAKE_SCALES) if (v >= target) { s = v; break; }
  return Math.round(docSide * Math.max(1, Math.min(s, MAX_BAKE_SIDE / docSide)));
};
const mapSide = async (target) =>
  target.evaluate(async (doc) => {
    window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(doc).document);
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120)))
    );
    const bg = document.querySelector('[data-element-id="band_bg"]');
    const href = document.querySelector("#lg_refract_panel feImage")?.getAttribute("href") || "";
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = href;
    });
    return { side: img.naturalWidth, zoom: bg.getBoundingClientRect().width / 840 };
  }, fixture([glass()]));

const hiRes = await mapSide(page);
const lowDpr = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1
});
const lowPage = await lowDpr.newPage();
await lowPage.goto(pathToFileURL(html).href);
await lowPage.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);
const loRes = await mapSide(lowPage);
await lowDpr.close();

const DOC_SIDE = Math.max(PANEL.width, PANEL.height) + padFor(0) * 2;
/* The predicted side rounds the element and the two margins separately, so it
   can land a texel either side of the bake's own rounding. */
const expectSide = bakedSide(hiRes.zoom, DPR, DOC_SIDE);
check(
  "the bake is rasterised at the view scale, not at 1:1",
  Math.abs(hiRes.side - expectSide) <= 2 && hiRes.side > loRes.side,
  `${hiRes.side}px at ${(hiRes.zoom * DPR).toFixed(2)}x device (expected ${expectSide}) ` +
    `vs ${loRes.side}px at ${(loRes.zoom * 1).toFixed(2)}x`
);

/* --------------------------------------------------- 6. end to end, pixels */

const MARGIN = 6;

/* The foreignObject IS the panel box; the group's own rect can be grown by the
   element's filter region, which would move the clip and the zoom factor both.
   The geometry is re-read AFTER each apply, because applying a document can move
   the viewport under it — measuring once and reusing the number puts the "rim"
   wherever the canvas happened to be before the shot. */
async function shot(effects) {
  await apply(page, fixture(effects));
  /* Selection chrome is painted over the rim — a white band and a dark hairline
     a few px inside it. This probe reads the FIRST dark run inside the rim, so
     with the panel still selected it measures the chrome, not the glass. The
     bridge takes an id, so an empty one is how it clears. */
  await page.evaluate(() => window.__FISH_BRIDGE__.selectElement(""));
  await page.waitForTimeout(80);
  /* The mapping is read off the full-canvas backdrop, NOT off the panel: with no
     effects there is no panel `foreignObject` at all (the plate and the backdrop
     div only exist when there is glass), and a group whose only child was that
     div has no box either. The backdrop exists in every case. */
  const geom = await page.evaluate(() => {
    const bg = document.querySelector('[data-element-id="band_bg"]');
    const r = bg.getBoundingClientRect();
    return { left: r.left, top: r.top, k: r.width / 840 };
  });
  const rimX = geom.left + PANEL.x * geom.k;
  const top = geom.top + PANEL.y * geom.k;
  const clip = {
    x: Math.round(rimX - MARGIN),
    y: Math.round(top),
    width: 70,
    height: Math.round(PANEL.height * geom.k)
  };
  const img = decodePNG(await page.screenshot({ clip }));
  return { img, clip, rimX: (rimX - clip.x) * DPR, k: geom.k * DPR };
}

const shots = {
  none: await shot([]),
  glass: await shot([glass()]),
  zero: await shot([glass({ refraction: 0 })]),
  frosted: await shot([glass({ refraction: 0, frost: 6 })])
};

function lumaRow(img, y) {
  const out = [];
  for (let x = 0; x < img.w; x++) {
    const i = (y * img.w + x) * img.ch;
    out.push(0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]);
  }
  return out;
}

/** Sub-pixel x of the first light-to-dark crossing, in document px inside the rim. */
function firstEdge(shot) {
  const row = lumaRow(shot.img, Math.round(shot.img.h / 2));
  const from = Math.ceil(shot.rimX + 2 * shot.k);
  for (let x = from + 1; x < row.length; x++) {
    if (row[x - 1] > 128 && row[x] <= 128) {
      // Sample centres sit at i + 0.5 shot px, spaced 1/k doc px apart.
      const cross = x - 0.5 + (row[x - 1] - 128) / Math.max(1e-6, row[x - 1] - row[x]);
      return (cross - shot.rimX) / shot.k;
    }
  }
  return null;
}

const measured = {
  none: firstEdge(shots.none),
  glass: firstEdge(shots.glass),
  zero: firstEdge(shots.zero),
  frosted: firstEdge(shots.frosted)
};

/* Where the bar's left edge lands under convex magnification: the fixed point of
   x = p - peak·profile(x/Depth), pulling interior content outward toward the rim. */
const peak = peakOf(70, DEPTH);
let predicted = BAR_INSIDE;
for (let i = 0; i < 200; i++) predicted = BAR_INSIDE - peak * profile(predicted / EFF_DEPTH);

check(
  "the reference edge is where the document puts it",
  Math.abs(measured.none - BAR_INSIDE) < 0.2,
  `bar at ${BAR}, rim at ${PANEL.x}: measured ${measured.none?.toFixed(3)}, expected ${BAR_INSIDE} doc px in ` +
    `(rimX ${shots.none.rimX.toFixed(1)} shot px, ${shots.none.k.toFixed(3)} px/doc px)`
);
check(
  "the bars magnify outward toward the rim by the throw the profile predicts",
  measured.glass !== null &&
    Math.abs(measured.glass - predicted) < 0.35 &&
    BAR_INSIDE - measured.glass > 3,
  `measured ${measured.glass?.toFixed(3)}px, predicted ${predicted.toFixed(3)} (throw ${(BAR_INSIDE - predicted).toFixed(2)}px)`
);
check(
  "Refraction 0 moves nothing",
  measured.zero !== null && Math.abs(measured.zero - measured.none) < 0.2,
  `measured ${measured.zero?.toFixed(3)}px vs ${measured.none?.toFixed(3)}px without glass`
);
check(
  "Frost blurs without moving the edge: Refraction is the only thing that shifts",
  measured.frosted !== null && Math.abs(measured.frosted - measured.none) < 1.5,
  `measured ${measured.frosted?.toFixed(3)}px with Frost 6 and Refraction 0`
);

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
process.exit(results.every((r) => r.ok) && pageErrors.length === 0 ? 0 : 1);

/** Minimal PNG reader: zlib plus the five filter types, nothing else. */
function decodePNG(buf) {
  let pos = 8;
  const idat = [];
  let w = 0;
  let h = 0;
  let ct = 6;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const d = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = d.readUInt32BE(0);
      h = d.readUInt32BE(4);
      ct = d[9];
    } else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : 3;
  const stride = w * ch;
  const out = Buffer.alloc(w * h * ch);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      const x = line[i];
      let v;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, ch, data: out };
}
