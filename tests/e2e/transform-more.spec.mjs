import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Tilt and shear used to occupy two captioned rows of the Position group at
// rest. They now live behind one More button, like Typography's secondary type
// controls. What matters is that folding them did not fold away the VALUES: the
// five wells must still read the layer, still write to it, and still get out of
// the way on Escape.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok: !!ok });
};

const POPOVER = '[data-transform-more-popover="true"]';
const TILT_X = '[title="Perspective tilt about the X axis"] input';
const SKEW_X = '[title="Shear across — leans the layer the way italics lean"] input';

const DOC = {
  version: "0.1",
  canvas: { width: 600, height: 400 },
  pages: [
    {
      id: "p1",
      name: "Page 1",
      children: [
        {
          id: "card",
          type: "rect",
          name: "Card",
          x: 40,
          y: 40,
          width: 160,
          height: 100,
          fills: [{ type: "solid", color: "#30A46C" }],
          rotateX: 12,
          rotateY: -8,
          perspective: 600,
          skewX: 10,
          skewY: 4
        }
      ]
    }
  ]
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

await page.evaluate(async (doc) => {
  const bridge = window.__FISH_BRIDGE__;
  bridge.applyDoc(window.__fish.normalize(doc).document);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 90))));
  bridge.selectElement("card");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 90))));
}, DOC);

const atRest = await page.evaluate(({ tiltX, skewX }) => ({
  more: !!document.querySelector('[data-transform-more="true"]'),
  popover: !!document.querySelector('[data-transform-more-popover="true"]'),
  tiltField: !!document.querySelector(tiltX),
  skewField: !!document.querySelector(skewX),
  rotation: !!document.querySelector('[title="Rotation"]'),
  expanded: document.querySelector('[data-transform-more="true"]')?.getAttribute("aria-expanded")
}), { tiltX: TILT_X, skewX: SKEW_X });

check("the Position group keeps a More button at rest", atRest.more && atRest.rotation);
check("tilt and shear are not in the panel at rest", !atRest.tiltField && !atRest.skewField);
check("the popover is closed and says so", !atRest.popover && atRest.expanded === "false");

await page.click('[data-transform-more="true"]');
await page.waitForSelector(POPOVER);

const open = await page.evaluate(({ popover, tiltX, skewX }) => {
  const panel = document.querySelector(popover);
  return {
    title: panel?.getAttribute("aria-label"),
    keys: [...panel.querySelectorAll("input")].map((i) => i.getAttribute("data-scrub-field")),
    tilt: !!panel.querySelector(tiltX),
    skew: !!panel.querySelector(skewX),
    values: [...panel.querySelectorAll("input")].map((i) => Number(i.value)),
    expanded: document.querySelector('[data-transform-more="true"]')?.getAttribute("aria-expanded")
  };
}, { popover: POPOVER, tiltX: TILT_X, skewX: SKEW_X });

check("the popover names itself", open.title === "Transform settings", open.title);
check("both groups are in the popover, five wells", open.tilt && open.skew && open.keys.length === 5, open.keys.join(","));
check("the wells read the layer's values", JSON.stringify(open.values) === JSON.stringify([12, -8, 600, 10, 4]), JSON.stringify(open.values));
check("the button reports itself open", open.expanded === "true");

await page.locator(`${POPOVER} ${TILT_X}`).fill("25");
await page.locator(`${POPOVER} ${TILT_X}`).press("Enter");
await page.waitForTimeout(140);
const afterTilt = await page.evaluate(() => window.__FISH_BRIDGE__.getDoc().pages[0].children[0]);
check("editing tilt in the popover writes rotateX", afterTilt.rotateX === 25, String(afterTilt.rotateX));
check("editing tilt leaves the shear alone", afterTilt.skewX === 10, String(afterTilt.skewX));

await page.locator(`${POPOVER} ${SKEW_X}`).fill("18");
await page.locator(`${POPOVER} ${SKEW_X}`).press("Enter");
await page.waitForTimeout(140);
const afterSkew = await page.evaluate(() => window.__FISH_BRIDGE__.getDoc().pages[0].children[0]);
check("editing skew in the popover writes skewX", afterSkew.skewX === 18, String(afterSkew.skewX));

await page.keyboard.press("Escape");
await page.waitForTimeout(120);
check("Escape closes the popover", (await page.locator(POPOVER).count()) === 0);
check("closing does not clear the selection", await page.evaluate(() => !!document.querySelector('[data-transform-more="true"]')));

check("no page errors", errors.length === 0, errors[0] ?? "");

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
