import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// The updates panel is the workbench's only app-level surface, and this build
// was given no release endpoint — which is the state it will be in until one is
// published, and therefore the state most worth measuring.
//
// The claims worth making are not "a panel renders":
//
//   - the entry is a real icon button at the Icon-button size (20px square),
//     because DESIGN.md's size table is boxes and a dock-sized button next to
//     the 20px zoom step reads as a different control standing in the same row.
//   - a build with nowhere to check says SO. Silence here would read as "you are
//     up to date", which is a claim the app cannot make.
//   - nothing offers to write. With no release there is no primary action at
//     all, and no badge on the entry — the loudest signal the design has must
//     never mean "an update exists" when none does.
//   - the two controls that cannot work are disabled rather than live-and-failing,
//     and the disabled state actually reaches the pointer (no hover wash).

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
await page.waitForTimeout(400);

const entry = await page.evaluate(() => {
  const button = document.querySelector("[data-update-button]");
  if (!button) return null;
  const box = button.getBoundingClientRect();
  const bar = document.querySelector('[data-title-bar="true"]');
  return {
    w: Math.round(box.width),
    h: Math.round(box.height),
    insideBar: bar ? bar.contains(button) : false,
    label: button.getAttribute("aria-label"),
    badge: !!document.querySelector("[data-update-badge]")
  };
});
check("the title bar carries an updates entry", !!entry);
check("it is the Logo-button box — 28px square", entry && entry.w === 28 && entry.h === 28, JSON.stringify(entry));
check("it lives inside the title bar, not floating", entry?.insideBar === true);
check("it has no badge while there is no update", entry?.badge === false);

// A click guarded through evaluate: against a bundle without the hook this
// yields a readable FAIL instead of a 30s click timeout.
const opened = await page.evaluate(() => {
  const button = document.querySelector("[data-update-button]");
  if (!button) return false;
  button.click();
  return true;
});
check("the entry opens its panel", opened);
await page.waitForTimeout(250);

const panel = await page.evaluate(() => {
  const popover = document.querySelector("[data-update-popover]");
  if (!popover) return null;
  const box = popover.getBoundingClientRect();
  const status = popover.querySelector("[data-update-status]");
  const style = getComputedStyle(popover);
  return {
    w: Math.round(box.width),
    entryLeft: Math.round(document.querySelector("[data-update-button]").getBoundingClientRect().left),
    status: status?.textContent?.trim() ?? "",
    // Nothing may offer to write when there is no release to write.
    apply: !!popover.querySelector("[data-update-apply]"),
    checkRow: (() => {
      const row = popover.querySelector("[data-update-check]");
      return { disabled: row?.disabled ?? null };
    })(),
    autoCheck: (() => {
      const input = popover.querySelector('[data-check-row="update-auto-check"]');
      return { present: !!input, disabled: input?.disabled ?? null };
    })(),
    badge: !!document.querySelector("[data-update-badge]"),
    bg: style.backgroundColor,
    left: Math.round(box.left),
    right: Math.round(box.right),
    radius: style.borderTopLeftRadius
  };
});
check("the panel opens", !!panel);
check(
  "it names why there is nothing to check",
  !!panel && /release address/i.test(panel.status),
  JSON.stringify(panel?.status)
);
check("it offers no write action", panel?.apply === false);
check("it wears no badge", panel?.badge === false);
check("the manual check is disabled, not live-and-failing", panel?.checkRow.disabled === true);
check(
  "the launch-check toggle is present and interactive",
  panel?.autoCheck.present === true && panel?.autoCheck.disabled === false
);
// Left edge flush with the entry, not with the window: the entry now sits in
// the left cluster, so a right-anchored popover would extend off the left edge
// of the screen. It must open under the control that opened it and stay inside
// the viewport.
check(
  "it is a 288px popover, flush with its entry's left edge and on screen",
  panel?.w === 288 && panel.entryLeft === panel.left && panel.left >= 0 && panel.right <= 1600,
  JSON.stringify({ w: panel?.w, panelLeft: panel?.left, panelRight: panel?.right, entryLeft: panel?.entryLeft })
);

// The disabled state must reach the pointer: `hover:bg-raised` still matches on
// a disabled button, which is why Button neutralises it centrally.
const hover = await page.evaluate(async () => {
  const row = document.querySelector("[data-update-check]");
  row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  return getComputedStyle(row).backgroundColor;
});
check("a disabled row does not answer the pointer with a wash", hover === "rgba(0, 0, 0, 0)", hover);

if (process.env.TEST_SCREENSHOTS) {
  await page.screenshot({ path: "test-results/updates-panel.png", clip: { x: 0, y: 0, width: 620, height: 300 } });
}

await page.keyboard.press("Escape");
await page.waitForTimeout(200);
const closed = await page.evaluate(() => !document.querySelector("[data-update-popover]"));
check("Escape closes it", closed);

check("no console errors", errors.length === 0, errors.join("\n      "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);