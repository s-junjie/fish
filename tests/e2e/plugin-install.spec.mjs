import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The whole plugin story, in a browser, from `file://`, with no server anywhere.
//
//   1. a fresh shell lists nothing — it does not know which plugins exist
//   2. a file that is not signed is refused, by name
//   3. each signed bundle installs, and ITS OWN component renders
//   4. a DIFFERENT html file — literally another copy on disk — finds all four
//      installed and opens one without being handed a bundle again
//
// Step 4 is the entire product promise ("install once, every file on this
// computer"), and it is the only test that can fail when someone quietly changes
// the loader back to "fetch it every time": with a server in the loop, or with a
// cache keyed by file, steps 1-3 still pass.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

/** Each panel is identified by text only it renders, so "the panel opened" cannot pass on the header alone. */
const PLUGINS = [
  { dir: "fish.icons", name: "Icon Explorer", marker: "Search thousands of icons..." },
  { dir: "fish.openverse", name: "Openverse Stock Photos", marker: "Search photos (e.g. architecture, nature)..." },
  { dir: "fish.wikimedia", name: "Wikimedia Commons", marker: "Search Commons photos (e.g. architecture, nature)..." },
  { dir: "fish.pixabay", name: "Pixabay Photos", marker: "Pixabay API key" },
  { dir: "fish.cutout", name: "Background Remover", marker: "No Image Selected" }
].map((p) => ({ ...p, path: path.resolve(process.cwd(), "dist-plugins", p.dir, "1.0.0", "plugin.js") }));

const results = [];
const pageErrors = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

for (const p of PLUGINS) {
  if (!fs.existsSync(p.path)) {
    console.error(`missing ${path.relative(process.cwd(), p.path)} — run npm run plugin:build`);
    process.exit(1);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-plugin-e2e-"));
const first = path.join(dir, "a.html");
const second = path.join(dir, "b.html");
const bogus = path.join(dir, "not-ours.js");
fs.copyFileSync(html, first);
fs.copyFileSync(html, second);
fs.writeFileSync(bogus, "export const apiVersion = '1'; export const Component = () => null;\n");

const PANEL = 'div[class*="z-[45]"]';
/** The wrapper is the dismissal anchor and has no box of its own; the menu inside does. */
const PLUGIN_MENU = '[data-plugin-menu] [role="menu"]';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

async function openResources(page) {
  await page.click('[data-tool="resources"]');
  await page.waitForSelector('input[placeholder]');
}

async function install(page, file) {
  // By NAME, not by `accept`: `.json` contains `.js`, so `accept*=".js"` also
  // matches the document-import input that comes first in the DOM — the bundle was
  // being handed to the JSON loader, which refused it as "not a FISH JSON document".
  await page.setInputFiles('input[type="file"][name="resource-file"]', file);
}

const a = await context.newPage();
a.on("pageerror", (e) => pageErrors.push(`a: ${String(e)}`));
await a.goto(pathToFileURL(first).href);
await a.waitForSelector('[data-tool="resources"]');

const styleApi = await a.evaluate(() => typeof window.__FISH_HOST__?.styles?.inject);
check("host bridge exposes plugin style injection", styleApi === "function");

await openResources(a);
const listedBefore = await a.locator('button:has-text("Icon Explorer")').count();
check("a fresh shell lists no plugins at all", listedBefore === 0, `${listedBefore} row(s)`);

await install(a, bogus);
await a.waitForSelector("text=/not a signed plugin/i", { timeout: 5000 }).catch(() => {});
const refused = await a.locator("text=/not a signed plugin/i").count();
check("a file with no signature is refused", refused > 0);

for (const plugin of PLUGINS) {
  await install(a, plugin.path);
  await a.waitForSelector(PANEL, { timeout: 15000 });
  const title = await a.locator(PANEL).first().innerText();
  // The header shows the name from the signed manifest; the marker proves the
  // external Component drew its own body rather than the boundary's error text.
  const body = await a
    .locator(`${PANEL} input[placeholder="${plugin.marker}"], ${PANEL} :text-is("${plugin.marker}")`)
    .count();
  check(
    `${plugin.name}: installs and renders its own panel`,
    title.includes(plugin.name) && body > 0,
    title.split("\n")[0]
  );

  const scoped = await a.locator(`${PANEL} [data-fish-plugin="${plugin.dir}"]`).count();
  check(`${plugin.name}: marks its content root for scoped CSS`, scoped === 1);

  if (plugin.dir === "fish.icons") {
    // The panel covers the toolbar it was opened from, but nothing the user pops
    // open on top of it: a menu has to be able to paint over a panel.
    const z = await a.evaluate(() => {
      const num = (el) => (el ? Number(getComputedStyle(el).zIndex) : NaN);
      return {
        panel: num(document.querySelector('div[class*="z-[45]"]')),
        toolbar: num(document.querySelector('[data-tool="resources"]')?.closest('[class*="z-40"]')),
        menu: num(document.querySelector('[class*="z-50"]'))
      };
    });
    check("the panel sits above the toolbar", z.panel > z.toolbar, `${z.panel} > ${z.toolbar}`);
    check("menus sit above the panel", z.menu > z.panel, `${z.menu} > ${z.panel}`);
  }
  // The popover closed itself on install; the panel stays. Reopen for the next one.
  const close = a.locator(`${PANEL} button[title="Close"]`);
  if (await close.count()) await close.first().click();
  await openResources(a);
}

const stored = await a.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open("fish-plugins");
      req.onerror = () => resolve(-1);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("bundles")) return resolve(0);
        const all = db.transaction("bundles", "readonly").objectStore("bundles").getAll();
        all.onsuccess = () => resolve(all.result.length);
        all.onerror = () => resolve(-1);
      };
    })
);
check("all bundles are in the browser's store", stored === PLUGINS.length, `${stored} row(s)`);

// Removing one: the row leaves the list, the panel it was showing leaves with it.
await a.locator('button:has-text("Background Remover")').first().click();
await a.waitForSelector(PANEL, { timeout: 15000 });
await openResources(a);
await a.locator('button:has-text("Background Remover")').first().click({ button: "right" });
await a.waitForSelector(PLUGIN_MENU, { timeout: 5000 });
const menuText = await a.locator(PLUGIN_MENU).innerText();
check("a row offers Remove on right click", /remove plugin/i.test(menuText), menuText.replace(/\n/g, " | "));

await a.locator(`${PLUGIN_MENU} button:has-text("Remove plugin")`).first().click();
await a
  .waitForSelector('button:has-text("Background Remover")', { state: "detached", timeout: 5000 })
  .catch(() => {});
const rowGone = await a.locator('button:has-text("Background Remover")').count();
check("the removed plugin leaves the list", rowGone === 0);
await a.waitForSelector(PANEL, { state: "detached", timeout: 5000 }).catch(() => {});
const panelGone = await a.locator(PANEL).count();
check("and its panel closes with it", panelGone === 0);

const storedAfter = await a.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open("fish-plugins");
      req.onerror = () => resolve(-1);
      req.onsuccess = () => {
        const all = req.result.transaction("bundles", "readonly").objectStore("bundles").getAll();
        all.onsuccess = () => resolve(all.result.length);
        all.onerror = () => resolve(-1);
      };
    })
);
check("the bundle is gone from the store", storedAfter === PLUGINS.length - 1, `${storedAfter} row(s)`);

const b = await context.newPage();
b.on("pageerror", (e) => pageErrors.push(`b: ${String(e)}`));
await b.goto(pathToFileURL(second).href);
await b.waitForSelector('[data-tool="resources"]');
await openResources(b);

// The list is filled by a storage read, so it is legitimately empty on the first
// frame — wait for it rather than sampling the moment the popover opens.
await b.waitForSelector('button:has-text("Openverse Stock Photos")', { timeout: 10000 });
const listedAfter = await b.locator('button:has-text("Icon Explorer")').count();
check("another file on disk finds them in the list", listedAfter > 0);

await b.locator('button:has-text("Openverse Stock Photos")').first().click();
await b.waitForSelector(PANEL, { timeout: 15000 });
const reopened = await b
  .locator(`${PANEL} input[placeholder="Search photos (e.g. architecture, nature)..."]`)
  .count();
check("and opens one without being handed the bundle again", reopened > 0);

check("no uncaught errors in either page", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
fs.rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
