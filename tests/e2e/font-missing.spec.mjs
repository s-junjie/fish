import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// A document set in a face this machine does not have. Three things have to hold
// at once, and each is invisible from the others:
//
//  1. The canvas still PAINTS the author's family name first in the stack, so the
//     face arrives the moment it exists and nothing is baked into the file.
//  2. The stored box is NOT re-measured with the substitute's advances. That is
//     the one that loses data: a `fit-content` paragraph re-measured in a wider
//     substitute overwrites the layout the author designed, and it does so only
//     on the machines that cannot show it — silently, into the saved file.
//  3. The author is TOLD. A substitute that looks like a typo is worse than an
//     error, so the layer row carries a mark naming the family.
//
// `NoSuchFishFace` is deliberately a name no machine has, in one word: the probe
// formats the family into a canvas `font` shorthand, and a multi-word family would
// make this spec measure the CSS parser as well as the behaviour.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const MISSING = "NoSuchFishFace";
const DOC = {
  version: "0.1",
  name: "Missing font",
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
          content: "This headline was set in a face this machine does not have, and it is long on purpose.",
          x: 20,
          y: 20,
          // The box the author saved. The substitute is much wider than this, so a
          // re-measure is unmistakable.
          width: 420,
          height: 96,
          sizing: { width: "fit-content", height: "fit-content" },
          style: { fontFamily: MISSING, fontSize: 32, color: "#FFFFFF" }
        },
        {
          id: "fine",
          type: "text",
          name: "Caption",
          content: "Set in the default family",
          x: 20,
          y: 200,
          width: 200,
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

await page.evaluate(async (doc) => {
  window.__FISH_BRIDGE__.applyDoc(window.__fish.normalize(doc).document);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))));
}, DOC);

const painted = await page.evaluate(() => {
  const marked = Array.from(document.querySelectorAll("[data-font-missing]")).map((node) => ({
    family: node.getAttribute("data-font-missing"),
    box: node.getAttribute("width") + "x" + node.getAttribute("height")
  }));
  const gone = document.querySelector('[data-layer-row="gone"]');
  const fine = document.querySelector('[data-layer-row="fine"]');
  const rowMark = gone?.querySelector("[data-layer-missing-font]");
  const stack = Array.from(document.querySelectorAll("foreignObject div")).find((node) =>
    /NoSuchFishFace/.test(getComputedStyle(node).fontFamily)
  );
  return {
    marked,
    rowMark: rowMark
      ? { family: rowMark.getAttribute("data-font-family"), title: rowMark.getAttribute("title") }
      : null,
    fineRowMarked: Boolean(fine?.querySelector("[data-layer-missing-font]")),
    stack: stack ? getComputedStyle(stack).fontFamily : null,
    doc: window.__FISH_BRIDGE__.getElements()
  };
});

const gone = painted.doc.find((el) => el.id === "gone");
const fine = painted.doc.find((el) => el.id === "fine");

check("the canvas marks the text it cannot paint", painted.marked.some((m) => m.family === MISSING), JSON.stringify(painted.marked));
check("the mark is only on the missing one", painted.marked.length === 1, `${painted.marked.length} marked`);
check(
  "the canvas paints the author's family, with a documented substitute behind it",
  painted.stack === `${MISSING}, system-ui, sans-serif`,
  String(painted.stack)
);

check("the layer row carries the warning", painted.rowMark?.family === MISSING, JSON.stringify(painted.rowMark));
check("the warning names the family in prose", /NoSuchFishFace/.test(painted.rowMark?.title ?? ""), painted.rowMark?.title);
check("a text in an installed family is not marked", painted.fineRowMarked === false);

// The data that would have been destroyed.
check(`the saved width is untouched (${gone?.width})`, gone?.width === 420, String(gone?.width));
check(`the saved height is untouched (${gone?.height})`, gone?.height === 96, String(gone?.height));
check("the document still names the author's family", gone?.style?.fontFamily === MISSING, gone?.style?.fontFamily);
check("the installed text was laid out normally", fine != null && fine.width !== 200, String(fine?.width));

check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
