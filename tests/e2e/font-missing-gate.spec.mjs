import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// A text whose family is not on this machine cannot be TYPED INTO, and the
// reason is geometric rather than cosmetic: its box is frozen at the size the
// file was saved with (see `resolveTextSizing`), so a caret would let the author
// type past its own edges and the saved geometry would stop describing the text.
//
//  1. Double-clicking such a text opens the missing-font panel and NOT an editor.
//  2. The panel says which layer was refused and which family refused it.
//  3. A text this machine CAN paint still edits on the same double click.
//  4. New text is editable immediately, because new text is `system-ui`.
//
// `NoSuchFishFace` is a name no machine has, in one word — the resolver formats
// the family into a canvas `font` shorthand, so a multi-word name would grade the
// CSS parser as well as the behaviour.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const MISSING = "NoSuchFishFace";
const DOC = {
  version: "0.1",
  name: "Missing font gate",
  canvas: { width: 800, height: 400 },
  pages: [
    {
      id: "p1",
      name: "Page 1",
      children: [
        {
          id: "gone",
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
          id: "fine",
          type: "text",
          name: "Caption",
          content: "Set in the default family",
          x: 40,
          y: 160,
          width: 260,
          height: 28,
          sizing: { width: "fit-content", height: "fit-content" },
          style: { fontFamily: "system-ui", fontSize: 16, color: "#FFFFFF" }
        },
        {
          // Pinned on BOTH axes, but uses the missing face: canvas editing is
          // refused regardless of sizing.
          id: "pinned",
          type: "text",
          name: "Pinned",
          content: "Pinned in the missing face",
          x: 40,
          y: 240,
          width: 380,
          height: 80,
          style: { fontFamily: MISSING, fontSize: 20, color: "#FFFFFF" }
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

await page.evaluate(async (doc) => {
  window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(doc).document);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))));
}, DOC);

const centerOf = async (selector) => {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const editorOpen = () => page.evaluate(() => Boolean(document.querySelector('[contenteditable="true"]')));
const dialogOpen = () => page.evaluate(() => Boolean(document.querySelector("[data-missing-fonts-dialog]")));

// 1. The refused gesture.
const missingPoint = await centerOf('[data-font-missing="' + MISSING + '"]');
await page.mouse.dblclick(missingPoint.x, missingPoint.y);
await page.waitForTimeout(150);

check("double-click on a missing-font text does not open the editor", (await editorOpen()) === false);
check("it opens the missing-font panel instead", await dialogOpen());

const familyListed = await page.evaluate((family) => {
  return Boolean(document.querySelector(`[data-missing-family="${family}"]`));
}, MISSING);
check("the missing family is listed in the dialog", familyListed);

const usage = await page.evaluate(() =>
  Array.from(document.querySelectorAll("[data-missing-family-usage]")).map((n) => n.textContent)
);
check("the row counts the text layers that use it", usage.some((line) => /2 text layers/.test(line ?? "")), JSON.stringify(usage));

// The document is untouched: refusing an edit may not rewrite anything.
const afterRefusal = await page.evaluate(() => window.__FISH_BRIDGE__.getElements());
const goneAfter = afterRefusal.find((el) => el.id === "gone");
check(
  "the refused edit left the box exactly as saved",
  goneAfter?.width === 420 && goneAfter?.height === 48,
  `${goneAfter?.width}x${goneAfter?.height}`
);

// 2. Escape closes the panel and nothing else.
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
check("Escape closes the panel", (await dialogOpen()) === false);

// 3. A text this machine can paint still edits.
const canvasFine = await page.evaluate(() => {
  // The missing text's own stack (`NoSuchFishFace, system-ui, sans-serif`)
  // contains `system-ui` too, so this excludes it explicitly.
  const node = Array.from(document.querySelectorAll("foreignObject div")).find((n) => {
    const family = getComputedStyle(n).fontFamily;
    return family.includes("system-ui") && !family.includes("NoSuchFishFace");
  });
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 };
});
if (!canvasFine) {
  check("the installed text is on the canvas", false);
} else {
  await page.mouse.dblclick(canvasFine.x, canvasFine.y);
  await page.waitForTimeout(200);
  check("double-click on a text in an installed family still edits", await editorOpen());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
}

// 4. A box in a missing family, regardless of sizing: also refused from editing.
const pinnedPoint = await page.evaluate(() => {
  const node = Array.from(document.querySelectorAll("foreignObject div")).find((n) =>
    (n.textContent ?? "").includes("Pinned in the missing face")
  );
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return { x: r.x + Math.min(30, r.width / 2), y: r.y + r.height / 2 };
});
check("the pinned text is on the canvas", Boolean(pinnedPoint));
if (pinnedPoint) {
  await page.mouse.dblclick(pinnedPoint.x, pinnedPoint.y);
  await page.waitForTimeout(200);
  check("a pinned box in the missing family is also refused", (await editorOpen()) === false && (await dialogOpen()) === true);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
}

// 5. New text is editable immediately — it is `system-ui`, not a named face.
await page.mouse.click(5, 400);
await page.keyboard.press("t");
await page.mouse.move(600, 300);
await page.mouse.down();
await page.mouse.move(800, 360, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(250);

const created = await page.evaluate(() => {
  const texts = window.__FISH_BRIDGE__.getElements().filter((el) => el.type === "text");
  return texts.map((el) => ({ id: el.id, family: el.style?.fontFamily ?? null }));
});
check(
  "a new text layer carries the default family",
  created.some((el) => el.family === "system-ui"),
  JSON.stringify(created)
);
check("a new text layer is editable straight away", await editorOpen());

check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
