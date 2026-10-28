import { chromium } from "playwright";
import { pathToFileURL } from "url";
import fs from "node:fs";
import path from "node:path";

// The plugin door of the Figma import dialog, driven as a person would drive it.
//
// The unit tests prove the shim and the envelope; this proves the thing they
// cannot see — that a FILE, picked off disk and handed to a real <input type=file>,
// travels through the dialog, lands pages in the document, paints, and asks
// Figma for absolutely nothing. The last one is the claim the whole plugin line
// rests on, and it is only observable from outside the app.
//
// The fixture is a literal envelope rather than something generated from a saved
// sample: a generated one would import whatever the generator decided, and this
// spec's job is to assert the bytes the designer actually hands over.

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

// The shape `figma-plugin/collect.js` writes: a DOCUMENT holding one CANVAS,
// whose children carry Figma's own field names. Small on purpose — the point is
// the path, not the file.
const EXPORT = {
  format: "fish.figma.export",
  version: 1,
  source: { plugin: "FISH Export", api: "1.0.0", scope: "selection", exportedAt: "2026-10-10T00:00:00.000Z" },
  document: {
    id: "fish:0",
    name: "Offline Kit",
    type: "DOCUMENT",
    children: [
      {
        id: "fish:1",
        name: "Card",
        type: "CANVAS",
        children: [
          {
            id: "9:1",
            name: "Card",
            type: "FRAME",
            absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 180 },
            size: { x: 320, y: 180 },
            clipsContent: true,
            cornerRadius: 12,
            fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
            children: [
              {
                id: "9:2",
                name: "Title",
                type: "TEXT",
                absoluteBoundingBox: { x: 24, y: 24, width: 160, height: 20 },
                characters: "Plugin door",
                style: { fontFamily: "Inter", fontSize: 16, fontWeight: 600, lineHeightPx: 20 },
                fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1, a: 1 } }]
              },
              {
                id: "9:3",
                name: "Mark",
                type: "VECTOR",
                absoluteBoundingBox: { x: 24, y: 60, width: 24, height: 24 },
                size: { x: 24, y: 24 },
                fillGeometry: [{ path: "M12 2 L22 12 L12 22 L2 12 Z", windingRule: "NONZERO" }],
                fills: [{ type: "SOLID", color: { r: 0.9, g: 0.4, b: 0.1, a: 1 } }]
              }
            ]
          }
        ]
      }
    ]
  },
  images: {},
  unreadable: { preserveRatio: 3 }
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};
const same = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);

const BUNDLE = path.resolve("scripts/fixtures/figma-bundle-sample.zip");
const exportPath = path.resolve("scratch/plugin-export-fixture.json");
fs.mkdirSync(path.dirname(exportPath), { recursive: true });
fs.writeFileSync(exportPath, JSON.stringify(EXPORT));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

// Every outbound request, so "spends no Figma quota" is measured and not assumed.
const figmaRequests = [];
page.on("request", (r) => {
  if (/figma/.test(new URL(r.url()).hostname)) figmaRequests.push(r.url());
});

// The app prefers the File System Access API, whose picker is a native OS dialog:
// Playwright cannot drive it, so the click would sit on a promise nothing answers.
// Taking the API away puts the app on the `<input type=file>` fallback — a real
// door (Firefox and Safari have no other), and the one this spec drives.
await page.addInitScript(() => {
  Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true, writable: true });
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

check(
  "no credential field exists anywhere in the app",
  (await page.locator("#figma-import-key, #figma-import-token").count()) === 0
);

/**
 * Import a file the way a person does.
 *
 * The menu item opens the OS picker — there is no dialog in between — so
 * `filechooser` IS the interaction, and Playwright can only take it by asking for
 * the event around the click. `.setFiles` then hands over a real path on disk.
 */
const importFile = async (file) => {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    (async () => {
      await page.getByTitle("Media tools").click();
      await page.getByText("Import Figma File...").click();
    })()
  ]);
  await chooser.setFiles(file);
};

// --- the single-file packaging --------------------------------------------------
const pagesBefore = await page.evaluate(() => window.__FISH_BRIDGE__.getDoc().pages.length);
await importFile(exportPath);
await page.waitForFunction((n) => window.__FISH_BRIDGE__.getDoc().pages.length > n, pagesBefore, { timeout: 20000 });
await page.waitForTimeout(800);

const landed = await page.evaluate(() => {
  const doc = window.__FISH_BRIDGE__.getDoc();
  const page_ = doc.pages.find((p) => p.id === doc.activePageId);
  const flat = [];
  (function walk(list) {
    for (const el of list) {
      flat.push({
        id: el.id,
        name: el.name,
        type: el.type,
        w: el.width,
        h: el.height,
        d: el.d ?? null,
        content: el.content ?? null,
        text: JSON.stringify(el.style ?? null)
      });
      if (el.children) walk(el.children);
    }
  })(page_.children);
  return { pageName: page_.name, flat };
});
same("the export's canvas became a page, by its own name", landed.pageName, "Card");
check("the frame arrived as a frame of the exported size", landed.flat[0]?.w === 320 && landed.flat[0]?.h === 180, JSON.stringify(landed.flat[0]));
check("the text kept its characters", landed.flat.find((e) => e.type === "text")?.content === "Plugin door");
check("the text kept the plugin's numeric font weight", (landed.flat.find((e) => e.type === "text")?.text ?? "").includes('"fontWeight":600'));
check(
  "the vector's geometry arrived verbatim, which is what a `data`→`path` slip loses",
  landed.flat.find((e) => e.type === "path")?.d === "M12 2 L22 12 L12 22 L2 12 Z"
);

// --- the toast can be read and dismissed by hand ---------------------------------
//
// The timer is the fallback, not the only way down: an import report is the hint
// a designer most wants to close by hand, because it is the one worth reading
// twice and the file is still loading. Without the button the only escape is
// waiting out a timeout that scales with the message.
const hintButton = page.locator("[data-hint] button");
check("the import left its report up as a toast", (await hintButton.count()) === 1);
await hintButton.click();
await page.waitForTimeout(200);
check("and the close button took it down at once", (await page.locator("[data-hint]").count()) === 0);

// --- the two claims the plugin line is made of ---------------------------------
const pagesAfter = await page.evaluate(() => window.__FISH_BRIDGE__.getDoc().pages.length);
check("the export added a page rather than overwriting the open one", pagesAfter === pagesBefore + 1, `before=${pagesBefore} after=${pagesAfter}`);
same("the import spent no Figma API call", figmaRequests, []);

// --- the PASTE: the same envelope, the other gesture -------------------------
//
// The plugin's Copy button puts the single-file envelope on the system
// clipboard, and a paste is a different gesture from a picked file: the
// designer is placing content onto the page they are working on. A payload
// that is ONE board therefore joins that page — no new page, no view torn away
// from their work — and a payload that is several boards still lands as pages,
// because no gesture can fold five boards into one.

/** Hand the clipboard text over the way the browser does: a paste event. */
const pasteExport = (envelope) =>
  page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    window.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
    );
  }, JSON.stringify(envelope));

const snapshot = () =>
  page.evaluate(() => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const active = doc.pages.find((p) => p.id === doc.activePageId);
    return {
      pages: doc.pages.length,
      names: doc.pages.map((p) => p.name),
      activePageId: doc.activePageId,
      activeName: active.name,
      topLevel: active.children.length,
      selected: window.__FISH_BRIDGE__.getSelectedIds().length
    };
  });

const oneBoardPasteBefore = await snapshot();
await pasteExport(EXPORT);
await page.waitForFunction(
  (n) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const active = doc.pages.find((p) => p.id === doc.activePageId);
    return !!active && active.children.length > n;
  },
  oneBoardPasteBefore.topLevel,
  { timeout: 20000 }
);
const oneBoard = await snapshot();

check(
  "a paste of one board added no page — it joined the open one",
  oneBoard.pages === oneBoardPasteBefore.pages,
  `before=${oneBoardPasteBefore.pages} after=${oneBoard.pages}`
);
check("and it left the open page open", oneBoard.activePageId === oneBoardPasteBefore.activePageId);
check(
  "and the board's layers landed on that page, on top of what was there",
  oneBoard.topLevel === oneBoardPasteBefore.topLevel + 1,
  `before=${oneBoardPasteBefore.topLevel} after=${oneBoard.topLevel}`
);
check(
  "and the pasted layers are the selection, all of them",
  oneBoard.selected === 3,
  JSON.stringify(oneBoard.selected)
);
await page
  .waitForFunction(() => document.body.innerText.includes("Pasted"), null, { timeout: 5000 })
  .catch(() => {});
check(
  "and the toast says where it landed, by that page's name",
  await page.evaluate(
    (name) => document.body.innerText.includes(`Pasted 3 layers into ${name}`),
    oneBoard.activeName
  ),
  await page.evaluate(() => document.body.innerText.slice(0, 200))
);
if (await page.locator("[data-hint] button").count()) await page.locator("[data-hint] button").click();

// Two boards pasted as one clipboard copy: pages of their own, one per board,
// landing on the first — the file door's behaviour, because the payload is a
// file's worth of pages whatever gesture carried it.
const TWO_BOARDS = {
  ...EXPORT,
  document: {
    ...EXPORT.document,
    children: [
      { ...EXPORT.document.children[0], name: "Alpha" },
      {
        id: "fish:2",
        name: "Beta",
        type: "CANVAS",
        children: [
          {
            id: "9:5",
            name: "Beta frame",
            type: "FRAME",
            absoluteBoundingBox: { x: 0, y: 0, width: 240, height: 120 },
            size: { x: 240, y: 120 },
            clipsContent: true,
            fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }]
          }
        ]
      }
    ]
  }
};

const twoBoardsBefore = await snapshot();
await pasteExport(TWO_BOARDS);
await page.waitForFunction((n) => window.__FISH_BRIDGE__.getDoc().pages.length > n + 1, twoBoardsBefore.pages, {
  timeout: 20000
});
const twoBoards = await snapshot();

check(
  "a paste of two boards made a page per board",
  twoBoards.pages === twoBoardsBefore.pages + 2,
  `before=${twoBoardsBefore.pages} after=${twoBoards.pages}`
);
check(
  "and it landed on the first of them",
  twoBoards.names.slice(-2).join(",") === "Alpha,Beta" && twoBoards.activeName === "Alpha",
  JSON.stringify(twoBoards.names)
);
// Looked up by id, not by "the active page": the paste switched the active page
// to the first board it made, so the page it came from is no longer active.
const cameFrom = await page.evaluate((id) => {
  const doc = window.__FISH_BRIDGE__.getDoc();
  return doc.pages.find((p) => p.id === id)?.children.length ?? -1;
}, twoBoardsBefore.activePageId);
check(
  "and the page it came from is untouched",
  cameFrom === twoBoardsBefore.topLevel,
  `before=${twoBoardsBefore.topLevel} after=${cameFrom}`
);
same("the paste door spent no Figma API call either", figmaRequests, []);

// --- the FOLDER: a zip with a real image in it --------------------------------
//
// The single-file assertions above all pass on an inline data URI, and an inline
// data URI is exactly what the folder replaced: nothing downsamples it. So the
// folder has to be driven with real, DECODABLE bytes, and then measured on the one
// thing the two packagings are allowed to differ on — that the images went through
// the app's own policy on the way in.
const folderPagesBefore = await page.evaluate(() => window.__FISH_BRIDGE__.getDoc().pages.length);
await importFile(BUNDLE);
await page.waitForFunction((n) => window.__FISH_BRIDGE__.getDoc().pages.length > n, folderPagesBefore, { timeout: 20000 });
await page.waitForTimeout(600);

const folder = await page.evaluate(() => {
  const doc = window.__FISH_BRIDGE__.getDoc();
  const active = doc.pages.find((p) => p.id === doc.activePageId);
  const painted = [];
  (function walk(list) {
    for (const el of list) {
      for (const fill of el.fills ?? []) if (fill.type === "image") painted.push({ assetId: fill.assetId, name: el.name });
      if (el.children) walk(el.children);
    }
  })(active.children);
  const assets = (doc.assets ?? []).filter((a) => painted.some((p) => p.assetId === a.id));
  return {
    pageName: active.name,
    painted: painted.length,
    assets: assets.map((a) => ({
      mime: /^data:([^;]+);/.exec(a.uri)?.[1] ?? null,
      bytes: a.uri.length,
      width: a.width ?? null,
      height: a.height ?? null
    }))
  };
});

same("the folder became the page its manifest named", folder.pageName, "Screens");

check("the folder's images reached the document as image fills", folder.painted > 0, JSON.stringify(folder.painted));
check(
  "every image was re-encoded on the way in, which is the whole point of the folder",
  folder.assets.length > 0 && folder.assets.every((a) => a.mime === "image/webp"),
  JSON.stringify(folder.assets)
);
check(
  "and none of them is still the 64px original",
  folder.assets.every((a) => a.bytes < 24935),
  JSON.stringify(folder.assets.map((a) => a.bytes))
);
check(
  "no asset was left without bytes",
  await page.evaluate(() => (window.__FISH_BRIDGE__.getDoc().assets ?? []).every((a) => Boolean(a.uri)))
);
same("the folder packaging spent no Figma API call either", figmaRequests, []);

// --- a file that is NOT an export says so -------------------------------------
//
// The dialog used to be the thing that explained a bad file, and it is gone: the
// picker now hands its result straight to the importer, so the WARNING is the only
// place a mistake can surface. Silence here would read as "the menu item did
// nothing", which is the failure this check exists for.
const badPath = path.resolve("scratch/not-a-figma-export.zip");
fs.writeFileSync(badPath, "this is neither a zip nor an export");

const badBefore = await page.evaluate(() => window.__FISH_BRIDGE__.getDoc().pages.length);
await importFile(badPath);
await page.waitForFunction(
  () => document.body.innerText.includes("is not a FISH Figma export"),
  null,
  { timeout: 5000 }
).catch(() => {});
const warned = await page.evaluate(() => document.body.innerText.includes("is not a FISH Figma export"));
check("an incorrect file raises a visible warning", warned, await page.evaluate(() => document.body.innerText.slice(0, 300)));
check(
  "and it added no page",
  (await page.evaluate(() => window.__FISH_BRIDGE__.getDoc().pages.length)) === badBefore
);
same("a refused file spent no Figma API call either", figmaRequests, []);

await page.locator('[data-ui-panel="left"]').screenshot({ path: "scratch/figma-plugin-import.png" });
await browser.close();

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\n${results.filter(Boolean).length} passed, ${results.filter((r) => !r).length} failed`);
process.exit(results.every(Boolean) && errors.length === 0 ? 0 : 1);
