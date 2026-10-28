import { activeElements } from "./_support/doc.mjs";
import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// The document assets page of the assets panel:
//   1. its chrome (switch + search) does not scroll away with the grid;
//   2. an image card is the same size as a component card;
//   3. a video asset is listed as a video — it must not be rendered as a broken <img>;
//   4. clicking an image card inserts an image, clicking a video card inserts a video;
//   5. a click with nothing selected centres it on the unobstructed canvas.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const same = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};
const yes = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
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

// A 1×1 PNG, and a video URI the browser can never decode as an image.
await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  bridge.setElements([
      {
        id: "c_chip",
        type: "component",
        name: "Chip",
        x: 0,
        y: 0,
        width: 120,
        height: 60,
        fills: [{ type: "solid", color: "#3B82F6" }],
        children: []
      }
    ], {
canvas: { ...base.canvas, width: 2000, height: 1200 },
assets: [
      // Enough cards to overflow the panel: the chrome assertions are only
      // meaningful when the grid can actually scroll.
      ...Array.from({ length: 14 }, (_, i) => ({
        id: `asset_png_${i}`,
        name: `photo-${i}.png`,
        uri: png,
        width: 640,
        height: 480
      })),
      { id: "asset_png", name: "hero.png", uri: png, width: 640, height: 480 },
      { id: "asset_mov", name: "clip.mp4", uri: "data:video/mp4;base64,AAAA", width: 1280, height: 720, duration: 3.5 }
    ]
});
});
await page.waitForTimeout(300);

await page.click('[data-testid="panel-tab-assets"]');
await page.waitForSelector('[data-asset-page="__doc__"]');
await page.waitForTimeout(300);

const docSource = () =>
  page.evaluate(() => {
    const root = document.querySelector('[data-asset-page="__doc__"]');
    const rectOf = (sel) => {
      const el = root.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width) };
    };
    const scroller = root.querySelector("[data-asset-scroll]");
    return {
      switch: rectOf('[data-asset-doctabs="true"]'),
      search: rectOf('[data-testid="assets-search"]'),
      scroller: scroller
        ? { scrollTop: Math.round(scroller.scrollTop), scrollHeight: Math.round(scroller.scrollHeight), height: Math.round(scroller.getBoundingClientRect().height) }
        : null,
      switchBefore: null
    };
  });

const before = await docSource();
yes("the page has a scroll region for the grid only", before.scroller !== null, JSON.stringify(before));
yes("the grid actually overflows it", before.scroller && before.scroller.scrollHeight > before.scroller.height, JSON.stringify(before.scroller));

await page.evaluate(() => {
  const scroller = document.querySelector('[data-asset-page="__doc__"] [data-asset-scroll]');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
});
await page.waitForTimeout(150);

const after = await docSource();
const scrollDelta = (el, from) => (el && from ? el.top - from.top : null);
yes("the scroll actually moved", after.scroller && after.scroller.scrollTop > 0, JSON.stringify(after.scroller));
yes("scrolling the grid leaves the switch put", scrollDelta(after.switch, before.switch) === 0, `${before.switch?.top} -> ${after.switch?.top}`);
yes("scrolling the grid leaves the search put", scrollDelta(after.search, before.search) === 0, `${before.search?.top} -> ${after.search?.top}`);

// --- card geometry: an image card must be a component card -------------------
const geometry = async (tab) =>
  page.evaluate((which) => {
    const root = document.querySelector('[data-asset-page="__doc__"]');
    const node = root.querySelector(which === "components" ? "[data-asset-component]" : "[data-asset-asset]");
    if (!node) return null;
    const preview = node.querySelector("[data-asset-preview]");
    if (!preview) return null;
    const r = preview.getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
  }, tab);

const switchTo = async (label) => {
  await page.evaluate((l) => {
    const tab = [...document.querySelectorAll('[data-asset-doctabs="true"] button')].find((b) => b.textContent?.trim() === l);
    tab?.click();
  }, label);
  await page.waitForTimeout(250);
};

await switchTo("Components");
const compBox = await geometry("components");
await switchTo("Images");
const imgBox = await geometry("images");

yes("an image card renders", imgBox !== null, "no [data-asset-asset]");
yes("the image preview box is measured", imgBox && imgBox.width > 0, JSON.stringify(imgBox));
yes("an image preview matches a component preview", JSON.stringify(imgBox) === JSON.stringify(compBox), `${JSON.stringify(imgBox)} vs ${JSON.stringify(compBox)}`);

// --- a video asset is a video, not a broken <img> ----------------------------
const videoCell = await page.evaluate(() => {
  const cell = document.querySelector('[data-asset-asset="asset_mov"]');
  if (!cell) return { found: false };
  const img = cell.querySelector("img");
  const badge = cell.querySelector("[data-asset-video]");
  return {
    found: true,
    kind: cell.getAttribute("data-asset-kind"),
    hasImg: Boolean(img),
    badge: badge ? badge.textContent?.trim() : null
  };
});
yes("the video asset is listed", videoCell.found, JSON.stringify(videoCell));
yes("the video asset is marked as video", videoCell.kind === "video", JSON.stringify(videoCell));
yes("the video asset renders no <img>", videoCell.hasImg === false, JSON.stringify(videoCell));
yes("the video card carries its duration", Boolean(videoCell.badge), JSON.stringify(videoCell));

const imgCell = await page.evaluate(() => {
  const cell = document.querySelector('[data-asset-asset="asset_png"]');
  return cell ? { kind: cell.getAttribute("data-asset-kind"), hasImg: Boolean(cell.querySelector("img")) } : null;
});
same("the image asset stays an image", imgCell, { kind: "image", hasImg: true });

// --- inserting from a card inserts the right kind of element ------------------
const doc = () => page.evaluate(() => window.__FISH_BRIDGE__.getDoc());
const elements = async () => activeElements(await doc());

// The window is not the canvas: the side panels float over it, so "centre" has
// to mean the box left over once their edges are taken out. Measured here the
// same way the app measures it (`[data-ui-panel]` names the edge each one is
// anchored to), because a card click is the one gesture with no pointer to aim.
const canvasCentre = () =>
  page.evaluate(() => {
    const root = document.querySelector("[data-canvas-root]").getBoundingClientRect();
    let left = 0;
    let top = 0;
    let right = root.width;
    let bottom = root.height;
    for (const panel of document.querySelectorAll("[data-ui-panel]")) {
      const b = panel.getBoundingClientRect();
      const l = b.left - root.left;
      const r = b.right - root.left;
      const t = b.top - root.top;
      const bo = b.bottom - root.top;
      if (Math.min(r, right) <= Math.max(l, left) || Math.min(bo, bottom) <= Math.max(t, top)) continue;
      if (panel.dataset.uiPanel === "left") left = Math.max(left, r);
      else if (panel.dataset.uiPanel === "right") right = Math.min(right, l);
      else if (panel.dataset.uiPanel === "dock") bottom = Math.min(bottom, t);
      else if (panel.dataset.uiPanel === "top") top = Math.max(top, bo);
    }
    return { cx: root.left + (left + right) / 2, cy: root.top + (top + bottom) / 2 };
  });

const paintedCentre = (id) =>
  page.evaluate((elId) => {
    const node = document.querySelector(`[data-element-id="${CSS.escape(elId)}"]`);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }, id);

const centred = async (el) => {
  const want = await canvasCentre();
  const got = await paintedCentre(el.id);
  const off = got ? Math.hypot(got.cx - want.cx, got.cy - want.cy) : Infinity;
  // A couple of px of slop: the document rounds its top-left to whole units.
  return { ok: Boolean(got) && off <= 2.5, detail: `off by ${got ? off.toFixed(1) : "-"}px, want ${JSON.stringify(want)}, got ${JSON.stringify(got)}` };
};

await page.click('[data-asset-asset="asset_png"]');
await page.waitForTimeout(300);
const afterImage = await elements();
const imageEl = afterImage.find((e) => e.type !== "component" && e.type !== "componentSet" && e.id.startsWith("c_chip") === false);
yes("clicking an image card inserts an image", Boolean(imageEl), JSON.stringify(afterImage.map((e) => e.type)));
if (imageEl) {
  const shot = await centred(imageEl);
  yes("the image lands on the centre of the unobstructed canvas", shot.ok, shot.detail);
}

await page.click('[data-asset-asset="asset_mov"]');
await page.waitForTimeout(300);
const afterVideo = await elements();
const videoEl = afterVideo.find((e) => e.type === "video");
yes("clicking a video card inserts a video element", Boolean(videoEl), JSON.stringify(afterVideo.map((e) => e.type)));
if (videoEl) {
  same("the video element points at the asset", videoEl.assetId, "asset_mov");
  const shot = await centred(videoEl);
  yes("the video lands on the centre of the unobstructed canvas", shot.ok, shot.detail);
}

const panelShot = await page.$('[data-ui-panel="left"]');
await panelShot.screenshot({ path: "/tmp/fish-assets-panel.png" });
console.log("screenshot: /tmp/fish-assets-panel.png");

await browser.close();
console.log(`\n${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (errors.length) console.log("console errors:\n" + errors.join("\n"));
process.exit(results.every((r) => r.ok) && errors.length === 0 ? 0 : 1);