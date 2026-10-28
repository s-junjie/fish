import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// The comment loop, driven the way a person drives it:
//   1. the comment tool owns the right rail — the inspector is gone while it is
//      armed, and the comment list is there instead;
//   2. a comment pinned next to that rail can still be SUBMITTED — the card is
//      portalled, so the press that lands on Send reaches Send, not the panel;
//   3. posting closes the window; the pin is the receipt;
//   4. a pin drags onto another layer and re-binds to it;
//   5. resolving drops the pin, and opening the thread from the rail puts it
//      back so the card is never over an unmarked spot;
//   6. a press outside closes the card and starts no new comment;
//   7. leaving comment mode brings the inspector back.
//
// (2) is the regression this spec exists for: the card used to be painted inside
// the canvas, which carries `contain: layout paint` — a clip AND a stacking
// context — so it could never outrank the `z-20` rails and the Send button sat
// behind the inspector with the press landing on the inspector's scroller.

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const yes = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
};

const WIDTH = 1600;
const HEIGHT = 1000;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

// A page-sized layer so a press anywhere on the canvas resolves to a layer, plus
// a second block to drag a pin onto.
await page.evaluate(() => {
  window.__FISH_BRIDGE__.setElements(
    [
      {
        id: "cmt_target",
        type: "rect",
        name: "Target Block",
        x: 0,
        y: 0,
        width: 4000,
        height: 3000,
        fills: [{ type: "solid", color: "#E5E5E5" }]
      },
      {
        id: "cmt_other",
        type: "rect",
        name: "Other Block",
        x: 360,
        y: 400,
        width: 380,
        height: 250,
        fills: [{ type: "solid", color: "#B794FF" }]
      }
    ],
    { canvas: { width: 4000, height: 3000 } }
  );
});
await page.waitForTimeout(400);

const state = () =>
  page.evaluate(() => {
    const rail = document.querySelector("[data-comment-rail]");
    const inspector = document.querySelector('[data-ui-panel="right"][data-inspector-activity="true"]');
    return {
      rail: Boolean(rail),
      inspectorVisible: Boolean(inspector) && !inspector.className.includes("translate-x-full"),
      rows: document.querySelectorAll("[data-comment-row]").length,
      rowLabels: [...document.querySelectorAll("[data-comment-row]")].map((r) =>
        r.textContent.replace(/\s+/g, " ").slice(0, 30)
      ),
      pins: document.querySelectorAll("[data-comment-pin]").length,
      popover: document.querySelectorAll("[data-ui-panel=comment-popover]").length,
      composer: document.querySelectorAll("[data-ui-panel=comment-composer]").length
    };
  });

yes("no comment rail before the tool is armed", !(await state()).rail);

await page.keyboard.press("c");
await page.waitForTimeout(400);
const armed = await state();
yes("C opens the comment rail", armed.rail);
yes("the inspector gives its slot to the rail", !armed.inspectorVisible);

// Just left of the rail: the pin here used to put the composer under it.
const clickX = WIDTH - 288 - 40;
const clickY = 420;
await page.mouse.click(clickX, clickY);
await page.waitForTimeout(400);

const composer = page.locator("[data-ui-panel=comment-composer]");
yes("a press in comment mode opens a composer", (await composer.count()) === 1);

// The marker must survive the window opening: centred on the press, and not
// covered by the card. Both were wrong — an inline `transform` silently
// replaced the `-translate-x-1/2` utility, so every pin hung from its top-left
// corner and the card then landed half on top of it.
const marker = await page.evaluate(() => {
  const pin = document.querySelector("[data-comment-draft-pin]").getBoundingClientRect();
  const card = document.querySelector("[data-ui-panel=comment-composer]").getBoundingClientRect();
  const overlapX = Math.min(pin.right, card.right) - Math.max(pin.left, card.left);
  const overlapY = Math.min(pin.bottom, card.bottom) - Math.max(pin.top, card.top);
  return {
    pin: { cx: pin.x + pin.width / 2, cy: pin.y + pin.height / 2 },
    overlaps: overlapX > 0 && overlapY > 0
  };
});
yes(
  "the pin is centred on the press",
  Math.abs(marker.pin.cx - clickX) <= 1 && Math.abs(marker.pin.cy - clickY) <= 1,
  JSON.stringify(marker.pin)
);
yes("the window does not cover the pin", !marker.overlaps, JSON.stringify(marker));

const topmost = await page.evaluate(() => {
  const composer = document.querySelector("[data-ui-panel=comment-composer]");
  const send = [...composer.querySelectorAll("button")].find((b) => b.textContent.trim() === "Send");
  if (!send) return { found: false };
  const r = send.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { found: true, reachesSend: Boolean(hit && (hit === send || send.contains(hit))) };
});
yes("the composer's Send is the topmost element under the pointer", topmost.reachesSend, JSON.stringify(topmost));

await composer.locator("textarea").fill("Make this block brand amber");
await composer.locator("button", { hasText: /^Send$/ }).click();
await page.waitForTimeout(500);

const created = await state();
yes("submitting pins the comment", created.pins === 1, JSON.stringify(created));
yes("submitting closes the window", created.popover === 0 && created.composer === 0, JSON.stringify(created));
yes("the rail lists the new thread", created.rows === 1);

// Drag the pin onto the other block: the target follows the pin, not the press
// that created it.
const pinCentre = () =>
  page.evaluate(() => {
    const r = document.querySelector("[data-comment-pin]").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

const otherCentre = await page.evaluate(() => {
  const r = document.querySelector('[data-element-id="cmt_other"]').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
yes(
  "the drop target is on screen (a press here can hit it)",
  otherCentre.x > 300 && otherCentre.x < WIDTH - 300 && otherCentre.y > 100 && otherCentre.y < HEIGHT - 100,
  JSON.stringify(otherCentre)
);
const from = await pinCentre();
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(otherCentre.x, otherCentre.y, { steps: 10 });
await page.waitForTimeout(150);
const highlight = await page.locator("[data-comment-drop-target]").count();
await page.mouse.up();
await page.waitForTimeout(400);
yes("the layer under the pin is highlighted while dragging", highlight === 1, String(highlight));
const dragged = await state();
yes(
  "dragging the pin re-binds the thread to the layer it landed on",
  dragged.rowLabels[0]?.startsWith("Other Block"),
  JSON.stringify(dragged.rowLabels)
);
const moved = await pinCentre();
yes(
  "the pin ends where it was dropped",
  Math.abs(moved.x - otherCentre.x) < 2 && Math.abs(moved.y - otherCentre.y) < 2,
  `${JSON.stringify(moved)} vs ${JSON.stringify(otherCentre)}`
);

// Resolve: resolving closes the card and drops the pin; opening the thread from the rail puts it back.
await page.locator("[data-comment-row]").first().click();
await page.waitForTimeout(400);
await page.locator("[data-ui-panel=comment-popover] button[aria-label=Resolve]").click();
await page.waitForTimeout(400);
const resolved = await state();
yes("the resolved thread is still listed", resolved.rows === 1, JSON.stringify(resolved));
yes("resolving closes the card automatically", resolved.popover === 0, JSON.stringify(resolved));
yes("closing the card drops the resolved pin", resolved.pins === 0, JSON.stringify(resolved));

await page.locator("[data-comment-filter] button", { hasText: "Resolved" }).click();
await page.waitForTimeout(250);
await page.locator("[data-comment-row]").first().click();
await page.waitForTimeout(400);
const reopened = await state();
yes("the rail opens a resolved thread on the canvas", reopened.popover === 1, JSON.stringify(reopened));
yes("an opened resolved thread shows its pin again", reopened.pins === 1, JSON.stringify(reopened));

// A press outside closes the card and does nothing else.
await page.mouse.click(240, 760);
await page.waitForTimeout(400);
const dismissed = await state();
yes("a press outside closes the card", dismissed.popover === 0, JSON.stringify(dismissed));
yes("that press does not start a new comment", dismissed.composer === 0, JSON.stringify(dismissed));

// Leaving comment mode gives the inspector back.
await page.keyboard.press("v");
await page.waitForTimeout(500);
const left = await state();
yes("leaving comment mode restores the inspector", !left.rail && left.inspectorVisible, JSON.stringify(left));
yes("leaving comment mode closes the card", left.popover === 0, JSON.stringify(left));

// Tab (hide-UI) takes the pins and cards with the rails: the canvas becomes the
// artwork alone. State is kept, so Tab back restores the open card.
await page.keyboard.press("c");
await page.waitForTimeout(300);
await page.locator("[data-comment-filter] button", { hasText: "Resolved" }).click();
await page.waitForTimeout(250);
await page.locator("[data-comment-row]").first().click();
await page.waitForTimeout(400);
const preHide = await state();
// The card auto-focused its reply field, and the Tab shortcut ignores presses
// from editable inputs — blur first so the toggle actually runs.
await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
await page.keyboard.press("Tab");
await page.waitForTimeout(400);
const duringHide = await page.evaluate(() => ({
  pins: document.querySelectorAll("[data-comment-pin]").length,
  cards: document.querySelectorAll("[data-ui-panel=comment-popover],[data-ui-panel=comment-composer]").length
}));
yes(
  "hide-UI takes the pins and cards with it",
  duringHide.pins === 0 && duringHide.cards === 0,
  JSON.stringify(duringHide)
);
await page.keyboard.press("Tab");
await page.waitForTimeout(400);
const restored = await state();
yes(
  "Tab back restores the open card and its pin",
  restored.pins === preHide.pins && restored.popover === preHide.popover,
  `${JSON.stringify(restored)} vs ${JSON.stringify(preHide)}`
);

await page.screenshot({ path: "/tmp/fish-comments-e2e.png" });
await browser.close();
console.log(`\n${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (errors.length) console.log("console errors:\n" + errors.join("\n"));
process.exit(results.every((r) => r.ok) && errors.length === 0 ? 0 : 1);
