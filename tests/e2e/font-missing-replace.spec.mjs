import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// The fix, for real: pick a family this machine has and the file stops claiming
// one it does not. Four things have to happen together, and a spec that checked
// one of them would pass while the file stayed broken:
//
//  1. Every place the name is stored is rewritten — layers, their runs, and the
//     shared text styles.
//  2. The marks clear: canvas nodes and layer rows stop saying the file is wrong.
//  3. The frozen boxes re-measure, because the family that froze them is gone.
//  4. The SELECTION scope touches only the selection, and leaves the style table
//     for the document scope — the two intentions Figma offers.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const MISSING = "NoSuchFishFace";
const DOC = {
  version: "0.1",
  name: "Missing font replace",
  canvas: { width: 900, height: 500 },
  styles: [
    {
      id: "s1",
      name: "Display",
      styleType: "text",
      style: { fontFamily: MISSING, fontSize: 32, lineHeight: 1.2 }
    }
  ],
  pages: [
    {
      id: "p1",
      name: "Page 1",
      children: [
        {
          id: "a",
          type: "text",
          name: "Poster",
          content: "Set in a face this machine does not have",
          x: 40,
          y: 40,
          width: 420,
          height: 48,
          sizing: { width: "fit-content", height: "fit-content" },
          style: { fontFamily: MISSING, fontSize: 32, color: "#FFFFFF" }
        },
        {
          id: "frame",
          type: "frame",
          name: "Card",
          x: 40,
          y: 120,
          width: 600,
          height: 200,
          children: [
            {
              id: "b",
              type: "text",
              name: "Body",
              content: "Also set in the missing face",
              x: 16,
              y: 16,
              width: 380,
              height: 40,
              sizing: { width: "fit-content", height: "fit-content" },
              style: { fontFamily: MISSING, fontSize: 18, color: "#FFFFFF" }
            }
          ]
        },
        {
          id: "c",
          type: "text",
          name: "Caption",
          content: "Set in the default family",
          x: 40,
          y: 380,
          width: 260,
          height: 28,
          sizing: { width: "fit-content", height: "fit-content" },
          style: { fontFamily: "system-ui", fontSize: 16, color: "#FFFFFF" }
        }
      ]
    }
  ]
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const load = async () => {
  await page.evaluate(async (doc) => {
    window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(doc).document);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))));
  }, DOC);
  await page.waitForTimeout(150);
};

const openFromRow = async () => {
  await page.locator('[data-layer-missing-font="a"]').click();
  await page.waitForSelector("[data-missing-fonts-dialog]");
};

const substitute = async () => {
  await page.locator('[data-missing-family="' + MISSING + '"] [data-font-trigger]').click();
  await page.waitForSelector("[data-font-panel]");
  await page.locator("[data-font-panel] button", { hasText: /^System UI$/ }).first().click();
  await page.waitForTimeout(100);
  await page.locator("[data-replace-fonts-confirm]").click();
  await page.waitForTimeout(250);
};

const snapshot = () =>
  page.evaluate(() => {
    const walk = (list) =>
      list.flatMap((el) => [el, ...(el.children ? walk(el.children) : [])]);
    const all = walk(window.__FISH_BRIDGE__.getElements());
    const flat = {};
    for (const el of all) {
      if (el.type === "text") flat[el.id] = { family: el.style?.fontFamily, width: el.width };
    }
    return {
      texts: flat,
      styles: (window.__FISH_BRIDGE__.getDoc().styles ?? []).map((s) => s.style?.fontFamily),
      canvasMarks: document.querySelectorAll("[data-font-missing]").length,
      rowMarks: document.querySelectorAll("[data-layer-missing-font]").length,
      rows: Array.from(document.querySelectorAll("[data-missing-family]")).map((n) =>
        n.getAttribute("data-missing-family")
      ),
      usage: Array.from(document.querySelectorAll("[data-missing-family-usage]")).map((n) => n.textContent),
      empty: Boolean(document.querySelector("[data-missing-fonts-dialog]"))
    };
  });

await load();

// The panel is reachable without a refused gesture: the row's mark opens it.
const beforeOpen = await snapshot();
check("the canvas marks both layers set in the missing face", beforeOpen.canvasMarks === 2, String(beforeOpen.canvasMarks));
check("the row marks both of them", beforeOpen.rowMarks === 2, String(beforeOpen.rowMarks));

await openFromRow();
const listed = await snapshot();
check("the row mark opens the panel", await page.locator("[data-missing-fonts-dialog]").isVisible());
check("the family is listed once, with everything it costs", listed.rows.length === 1 && listed.rows[0] === MISSING, JSON.stringify(listed.rows));
check(
  "the count includes the nested layer and the shared style",
  /2 text layers/.test(listed.usage[0] ?? "") && /1 text style/.test(listed.usage[0] ?? ""),
  listed.usage[0]
);
check(
  "the selection scope is empty until something is selected",
  /Selection \(0\)/.test(await page.locator('[data-font-scope] button').first().innerText())
);

// Document scope: the file's own fix.
await substitute();
const afterAll = await snapshot();
check("the row is gone once nothing names the family", afterAll.rows.length === 0, JSON.stringify(afterAll.rows));
check(
  "every layer was rewritten, including the one inside the frame",
  afterAll.texts.a?.family === "system-ui" && afterAll.texts.b?.family === "system-ui",
  JSON.stringify(afterAll.texts)
);
check("the shared text style was rewritten too", afterAll.styles[0] === "system-ui", JSON.stringify(afterAll.styles));
check("no canvas node is marked any more", afterAll.canvasMarks === 0, String(afterAll.canvasMarks));
check("no layer row is marked any more", afterAll.rowMarks === 0, String(afterAll.rowMarks));
check(
  "the frozen boxes re-measured with the new family's metrics",
  afterAll.texts.a?.width !== 420 && afterAll.texts.a?.width > 0,
  String(afterAll.texts.a?.width)
);

// Selection scope: the author's own fix, on the layers they picked.
await page.keyboard.press("Escape");
await load();
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("a"));
await openFromRow();
await page.locator('[data-font-scope] button', { hasText: /^Selection/ }).click();
await substitute();

const afterSelection = await snapshot();
check(
  "the selected layer was replaced",
  afterSelection.texts.a?.family === "system-ui",
  String(afterSelection.texts.a?.family)
);
check(
  "an unselected layer still names the missing family",
  afterSelection.texts.b?.family === MISSING,
  String(afterSelection.texts.b?.family)
);
check("the style table is the document's, so it is untouched", afterSelection.styles[0] === MISSING, String(afterSelection.styles[0]));
check("the family is still listed, with the use it has left", afterSelection.rows.length === 1, JSON.stringify(afterSelection.rows));
check(
  "and the remaining count is the layer that kept it",
  /1 text layer/.test(afterSelection.usage[0] ?? ""),
  afterSelection.usage[0]
);
check("the row mark stays only where the family is still named", afterSelection.rowMarks === 1, String(afterSelection.rowMarks));

check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
