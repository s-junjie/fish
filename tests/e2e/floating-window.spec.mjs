import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const pageErrors = [];

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

const openverseManifest = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "src/plugins/openverse/plugin.json"), "utf-8")
);
const iconsManifest = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "src/plugins/icons/plugin.json"), "utf-8")
);
const openverseBundle = path.resolve(
  process.cwd(),
  "dist-plugins/fish.openverse",
  openverseManifest.version,
  "plugin.js"
);
const iconsBundle = path.resolve(
  process.cwd(),
  "dist-plugins/fish.icons",
  iconsManifest.version,
  "plugin.js"
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-floating-win-e2e-"));
const copyHtml = path.join(dir, "index.html");
fs.copyFileSync(html, copyHtml);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(pathToFileURL(copyHtml).href);
await page.waitForSelector('[data-testid="inspector-tab-design-system"]');
await page.click('[data-testid="inspector-tab-design-system"]');
await page.waitForSelector('[data-design-system-section="1"]');

const WIN = '[data-floating-window="true"]';
const HEADER = '[data-floating-window-header="true"]';

async function dragBy(startX, startY, dx, dy) {
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 6 });
  await page.mouse.up();
}

async function boxOf(selector) {
  return page.locator(selector).first().boundingBox();
}

// 1. Open Tokens Table
await page.click('[data-design-system-section="1"] button[aria-label="Tokens Table"]');
await page.waitForSelector(WIN, { timeout: 5000 });

const titlebarBox = await boxOf('[data-title-bar="true"]');
const tokenWinZ = await page.evaluate(() => {
  const win = document.querySelector('[data-floating-window="true"]');
  const tb = document.querySelector('[data-title-bar="true"]');
  return {
    win: Number(getComputedStyle(win).zIndex),
    tb: Number(getComputedStyle(tb).zIndex)
  };
});
check("tokens table sits below titlebar in z-index", tokenWinZ.win < tokenWinZ.tb, `${tokenWinZ.win} < ${tokenWinZ.tb}`);

// 2. Right-click canvas near the window so context menu overlaps it; menu must sit on top
const initialBox = await boxOf(WIN);
await page.mouse.click(initialBox.x - 10, initialBox.y + 40, { button: "right" });
await page.waitForSelector('[data-context-menu="true"]', { timeout: 5000 });

const menuOverlap = await page.evaluate(() => {
  const menu = document.querySelector('[data-context-menu="true"]');
  const win = document.querySelector('[data-floating-window="true"]');
  const mr = menu.getBoundingClientRect();
  const wr = win.getBoundingClientRect();
  const menuZ = Number(getComputedStyle(menu).zIndex);
  const winZ = Number(getComputedStyle(win).zIndex);
  // Sample center of menu where it overlaps or sits on screen
  const cx = mr.left + mr.width / 2;
  const cy = mr.top + mr.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  return {
    menuZ,
    winZ,
    hitInsideMenu: Boolean(hit && menu.contains(hit)),
    overlaps: mr.right > wr.left && mr.left < wr.right && mr.bottom > wr.top && mr.top < wr.bottom
  };
});
check(
  "context menu stacks above tokens table",
  menuOverlap.menuZ > menuOverlap.winZ && menuOverlap.hitInsideMenu,
  `${menuOverlap.menuZ} > ${menuOverlap.winZ}, hitInsideMenu=${menuOverlap.hitInsideMenu}`
);
await page.keyboard.press("Escape");

// 3. Drag header far up onto titlebar -> clamped at TITLE_BAR_HEIGHT
const headerBox = await boxOf(HEADER);
await dragBy(headerBox.x + headerBox.width / 2, headerBox.y + headerBox.height / 2, 0, -500);
const afterUpDrag = await boxOf(WIN);
check(
  "tokens table cannot be dragged onto titlebar",
  afterUpDrag.y >= titlebarBox.height,
  `y=${afterUpDrag.y}, titlebarH=${titlebarBox.height}`
);

// 4. All 8 resize handles work on tokens table and north handles respect titlebar
const handles = await page.evaluate(() =>
  [...document.querySelectorAll('[data-floating-window="true"] [data-resize-edge]')].map((el) =>
    el.getAttribute("data-resize-edge")
  )
);
check(
  "tokens table exposes all 8 edges and corners",
  ["n", "s", "e", "w", "nw", "ne", "sw", "se"].every((d) => handles.includes(d)),
  handles.join(",")
);

// Move window down slightly so north resize can be tested in both directions
const hdr2 = await boxOf(HEADER);
await dragBy(hdr2.x + hdr2.width / 2, hdr2.y + hdr2.height / 2, 0, 120);

const beforeResize = await boxOf(WIN);
const nwBox = await boxOf('[data-resize-edge="nw"]');
await dragBy(nwBox.x + nwBox.width / 2, nwBox.y + nwBox.height / 2, -40, -300);
const afterNw = await boxOf(WIN);
check(
  "nw corner expands width/height and clamps top at titlebar",
  afterNw.width > beforeResize.width && afterNw.height > beforeResize.height && afterNw.y >= titlebarBox.height,
  `w=${afterNw.width}>${beforeResize.width}, h=${afterNw.height}>${beforeResize.height}, y=${afterNw.y}`
);

const seBox = await boxOf('[data-resize-edge="se"]');
await dragBy(seBox.x + seBox.width / 2, seBox.y + seBox.height / 2, 40, -40);
const afterSe = await boxOf(WIN);
check(
  "se corner resizes width and height",
  afterSe.width > afterNw.width && afterSe.height < afterNw.height,
  `w=${afterSe.width}>${afterNw.width}, h=${afterSe.height}<${afterNw.height}`
);

const wBox = await boxOf('[data-resize-edge="w"]');
await dragBy(wBox.x + wBox.width / 2, wBox.y + wBox.height / 2, 50, 0);
const afterW = await boxOf(WIN);
check(
  "west edge shrinks width from the left while pinning right edge",
  afterW.width < afterSe.width && Math.abs(afterW.x + afterW.width - (afterSe.x + afterSe.width)) <= 1,
  `x=${afterW.x}, w=${afterW.width}`
);

// Close tokens table
await page.click(`${WIN} button[title="Close"]`);
await page.waitForSelector(WIN, { state: "detached", timeout: 5000 });

// 5. Open a "both" resizable plugin (openverse) and a "vertical" resizable plugin (icons)
async function installPlugin(bundlePath) {
  await page.click('[data-tool="resources"]');
  await page.waitForSelector('input[type="file"][name="resource-file"]', { state: "attached" });
  await page.setInputFiles('input[type="file"][name="resource-file"]', bundlePath);
  await page.waitForSelector(WIN, { timeout: 15000 });
}

await installPlugin(openverseBundle);
await page.waitForSelector(`${WIN} [data-fish-plugin="fish.openverse"]`, { timeout: 10000 });
const pluginZ = await page.evaluate(
  () => Number(getComputedStyle(document.querySelector('[data-floating-window="true"]')).zIndex)
);
check(
  "tokens table stacks one level above plugin windows and below menus",
  tokenWinZ.win > pluginZ && tokenWinZ.win < tokenWinZ.tb,
  `${pluginZ} < ${tokenWinZ.win} < ${tokenWinZ.tb}`
);
const openverseHandles = await page.evaluate(() =>
  [...document.querySelectorAll('[data-floating-window="true"] [data-resize-edge]')].map((el) =>
    el.getAttribute("data-resize-edge")
  )
);
check(
  "resize=both plugin exposes all 8 edges and corners",
  ["n", "s", "e", "w", "nw", "ne", "sw", "se"].every((d) => openverseHandles.includes(d)),
  openverseHandles.join(",")
);

const ovHdr = await boxOf(HEADER);
await dragBy(ovHdr.x + ovHdr.width / 2, ovHdr.y + ovHdr.height / 2, 0, -400);
const ovAfterDrag = await boxOf(WIN);
check(
  "plugin window cannot be dragged onto titlebar",
  ovAfterDrag.y >= titlebarBox.height,
  `y=${ovAfterDrag.y}`
);

const ovNe = await boxOf('[data-resize-edge="ne"]');
await dragBy(ovNe.x + ovNe.width / 2, ovNe.y + ovNe.height / 2, 50, 40);
const ovAfterNe = await boxOf(WIN);
check(
  "plugin ne corner resizes width and top edge",
  ovAfterNe.width > ovAfterDrag.width && ovAfterNe.y > ovAfterDrag.y,
  `w=${ovAfterNe.width}>${ovAfterDrag.width}, y=${ovAfterNe.y}>${ovAfterDrag.y}`
);

await page.click(`${WIN} button[title="Close"]`);
await page.waitForSelector(WIN, { state: "detached", timeout: 5000 });

await installPlugin(iconsBundle);
await page.waitForSelector(`${WIN} [data-fish-plugin="fish.icons"]`, { timeout: 10000 });
const iconsHandles = await page.evaluate(() =>
  [...document.querySelectorAll('[data-floating-window="true"] [data-resize-edge]')].map((el) =>
    el.getAttribute("data-resize-edge")
  )
);
check(
  "resize=vertical plugin exposes both top and bottom edges",
  iconsHandles.includes("n") && iconsHandles.includes("s") && iconsHandles.length === 2,
  iconsHandles.join(",")
);

const iconsStart = await boxOf(WIN);
const iconsN = await boxOf('[data-resize-edge="n"]');
await dragBy(iconsN.x + iconsN.width / 2, iconsN.y + iconsN.height / 2, 0, -20);
const iconsAfterN = await boxOf(WIN);
check(
  "resize=vertical plugin top edge resizes height upward without exceeding titlebar",
  iconsAfterN.height > iconsStart.height && iconsAfterN.y >= titlebarBox.height,
  `h=${iconsAfterN.height}>${iconsStart.height}, y=${iconsAfterN.y}`
);

check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
fs.rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
