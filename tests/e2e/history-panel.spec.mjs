import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// The version history is a two-line list row: an identity line and a metadata
// line. Both used to be set at nearly the same rank (and an unnamed version's
// identity WAS its timestamp, printed twice), so the claims worth making here
// are measurable ones — which line is bigger, which is brighter, that the row's
// actions are one ⋯ menu with delete in its own group, and that a rename lands
// in the name's own slot instead of opening a second row of controls.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const VIEW = { width: 1600, height: 1000 };
/** 10.5px / 9.5px / ink / ink-dim — the row and meta steps of the scale. */
const NAME_SIZE = "10.5px";
const META_SIZE = "9.5px";
const NAME_COLOR = "rgb(236, 243, 248)";
const META_COLOR = "rgb(155, 164, 171)";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEW });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

const edit = (id) =>
  page.evaluate((el) => {
    window.__FISH_BRIDGE__.insertElement(el);
  }, {
    id,
    type: "rect",
    name: id,
    x: 40,
    y: 40,
    width: 120,
    height: 80,
    fills: [{ type: "solid", color: "#3E63DD" }]
  });

const openHistory = async () => {
  await page.click("[data-autosave-status]");
  await page.waitForTimeout(250);
  await page.click("[data-title-bar-history]");
  await page.waitForTimeout(350);
};

const closeHistory = async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
};

const rows = () =>
  page.evaluate(() => {
    const panel = document.querySelector("[data-history-panel]");
    if (!panel) return null;
    return [...panel.querySelectorAll("li")].map((li) => {
      const name = li.querySelector("span.text-row");
      const meta = li.querySelector("div.text-meta");
      const ns = name ? getComputedStyle(name) : null;
      const ms = meta ? getComputedStyle(meta) : null;
      const actions = [...li.querySelectorAll("button")].map((b) => {
        const r = b.getBoundingClientRect();
        return { label: b.getAttribute("aria-label"), w: Math.round(r.width), h: Math.round(r.height) };
      });
      return {
        name: name ? (name.textContent || "").trim() : null,
        nameSize: ns?.fontSize,
        nameColor: ns?.color,
        meta: meta ? (meta.textContent || "").trim() : null,
        metaSize: ms?.fontSize,
        metaColor: ms?.color,
        actions
      };
    });
  });

// A version is committed ~800ms after a history push, and the identity the
// timeline keys on is only settled once a second push has run — so retry the
// edit until the panel actually has a row rather than assuming one wait is one
// version.
let list = [];
for (let attempt = 0; attempt < 4 && list.length === 0; attempt++) {
  await edit(`hist_${attempt}`);
  await page.waitForTimeout(1500);
  await openHistory();
  list = (await rows()) ?? [];
  if (list.length === 0) await closeHistory();
}
check("the panel has a version to read", list.length > 0, `${list.length} row(s)`);
if (list.length === 0) {
  await browser.close();
  process.exit(1);
}

const panelGeometry = await page.evaluate(() => {
  const panel = document.querySelector("[data-history-panel]");
  if (!panel) return null;
  const pr = panel.getBoundingClientRect();
  return { panelBottom: Math.round(pr.bottom), viewportBottom: window.innerHeight };
});
check("the panel reaches the bottom edge now that the statusbar is gone",
  panelGeometry !== null && panelGeometry.panelBottom === panelGeometry.viewportBottom,
  JSON.stringify(panelGeometry));

const first = list[0];
check("an unnamed version is not named after its own timestamp",
  Boolean(first.name) && !/\d{1,2}:\d{2}/.test(first.name),
  `name="${first.name}"`);
check("the identity line is the bigger, brighter one",
  first.nameSize === NAME_SIZE && first.nameColor === NAME_COLOR,
  `name ${first.nameSize} ${first.nameColor}`);
check("the metadata line is the smaller, dimmer one",
  first.metaSize === META_SIZE && first.metaColor === META_COLOR,
  `meta ${first.metaSize} ${first.metaColor}`);
check("the metadata line carries the time and the size",
  /\d{1,2}:\d{2}/.test(first.meta || "") && /\d(\.\d+)? (B|KB|MB)/.test(first.meta || ""),
  first.meta);

const labels = first.actions.map((a) => a.label);
check("the row's only action is one 20px icon box",
  first.actions.length === 1 && first.actions[0].h <= 20 && first.actions[0].w <= 20,
  JSON.stringify(first.actions));
check("that control is named for assistive tech",
  labels[0] === "Version actions", JSON.stringify(labels));
check("the panel carries no Name/Save button — rename is not a control",
  labels.every((l) => !/name|save/i.test(l || "")),
  JSON.stringify(labels));

// ── the actions are one ⋯ menu, with delete in its own group ────────────────
const menuChildren = () =>
  page.evaluate(() => {
    const menu = document.querySelector("[data-context-menu]");
    if (!menu) return null;
    return [...menu.children].map((c) =>
      c.tagName === "BUTTON" ? c.getAttribute("data-context-item") : "separator"
    );
  });

const openRowMenu = async (index) => {
  // The ⋯ is a toggle, so a click can also SHUT a menu left open by an earlier
  // step. Re-read once instead: an Escape here would close the whole panel now
  // that the panel being open is the mode.
  const read = async () => {
    const btn = await page.$(`[data-history-panel] li:nth-child(${index + 1}) button`);
    if (!btn) return null;
    await btn.click();
    await page.waitForTimeout(220);
    return menuChildren();
  };
  const opened = await read();
  return opened ?? read();
};

const unnamedMenu = await openRowMenu(0);
check("the ⋯ offers Restore and Export",
  unnamedMenu && unnamedMenu[0] === "restore" && unnamedMenu[1] === "export",
  JSON.stringify(unnamedMenu));
check("Delete sits alone behind a separator",
  unnamedMenu && JSON.stringify(unnamedMenu) === JSON.stringify(["restore", "export", "separator", "delete"]),
  JSON.stringify(unnamedMenu));

// The control that opened the menu counts as inside it, so the same ⋯ closes
// what it opened — without that the menu can only ever be re-opened.
await page.click("[data-history-panel] li:nth-child(1) button");
await page.waitForTimeout(200);
check("the ⋯ toggles the menu shut instead of reopening it",
  !(await page.evaluate(() => !!document.querySelector("[data-context-menu]"))));

// ── rename: double-click the name, edit it where it lives ───────────────────
const nameSpan = await page.$("[data-history-panel] li span.text-row");
await nameSpan.dblclick();
await page.waitForTimeout(250);
const field = await page.evaluate(() => {
  const input = document.querySelector("[data-history-rename]");
  if (!input) return null;
  const s = getComputedStyle(input);
  return {
    focused: document.activeElement === input,
    size: s.fontSize,
    bg: s.backgroundColor,
    border: s.borderColor,
    inputsInRow: input.closest("li").querySelectorAll("input").length,
    buttonsInRow: [...input.closest("li").querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))
  };
});
check("double-click opens a field in the name's own slot",
  field && field.focused && field.inputsInRow === 1 && field.size === NAME_SIZE,
  JSON.stringify(field));
check("that field is the recessed well with the commit hairline",
  field && field.bg === "rgb(10, 10, 10)" && field.border === "rgb(232, 163, 61)",
  `bg ${field?.bg} border ${field?.border}`);
check("renaming adds no extra row of controls",
  field && JSON.stringify(field.buttonsInRow) === JSON.stringify(labels),
  JSON.stringify(field?.buttonsInRow));

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
let after = await rows();
check("Escape leaves the label alone",
  after[0].name === first.name, `${first.name} -> ${after[0].name}`);

// Re-query: the escape re-render may have replaced the span.
const nameSpanAgain = await page.$("[data-history-panel] li span.text-row");
await nameSpanAgain.dblclick();
await page.waitForTimeout(250);
await page.fill("[data-history-rename]", "Checkpoint");
await page.keyboard.press("Enter");
await page.waitForTimeout(450);
after = await rows();
check("Enter commits the label into the name line",
  (after[0].name || "").includes("Checkpoint"), `name="${after[0].name}"`);
const namedMenu = await openRowMenu(0);
check("a named version keeps the time line and drops Delete",
  after[0].meta === first.meta &&
    JSON.stringify(namedMenu) === JSON.stringify(["restore", "export"]),
  `${after[0].meta} / ${JSON.stringify(namedMenu)}`);

// ── a restore is recorded too, and is named from its kind, not its clock ────
const restoreMenu = await openRowMenu(0);
const restoreItem = await page.$('[data-context-item="restore"]');
check("the restore action is present in the menu",
  !!restoreItem && Array.isArray(restoreMenu), JSON.stringify(restoreMenu));
if (restoreItem) {
  await restoreItem.click();
  await page.waitForTimeout(1400);
  // History mode ends with the restore it performed: the panel left open would
  // keep the document read-only, and there is nothing left to browse.
  check("restore closes the history panel behind it",
    !(await page.$("[data-history-panel]")));
  check("and says so",
    await page.evaluate(() =>
      [...document.querySelectorAll("div")].some((d) => d.textContent === "Version restored")
    ));
  await openHistory();
  await page.waitForTimeout(300);
  after = (await rows()) ?? [];
  check("restore records both what it replaced and what it left, by kind",
    after.length >= 3 &&
      after[0].name === "Restored" &&
      after[1].name === "Before restore" &&
      after.every((r) => r.name && !/\d{1,2}:\d{2}/.test(r.name)),
    JSON.stringify(after.map((r) => [r.name, r.meta])));
}

// ── history mode: the panel open IS the mode, a row click is the preview ────
const docState = () =>
  page.evaluate(() => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const active = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0];
    return { name: doc.name, count: active.children.length, ids: active.children.map((e) => e.id) };
  });

const probe = (id) =>
  page.evaluate((el) => window.__FISH_BRIDGE__.insertElement(el), {
    id,
    type: "rect",
    name: id,
    x: 200,
    y: 200,
    width: 40,
    height: 40,
    fills: [{ type: "solid", color: "#3E63DD" }]
  });

const has = (state, id) => state.ids.includes(id);

const clickRow = async (namePart) => {
  const handle = await page.evaluateHandle((part) => {
    const list = [...document.querySelectorAll("[data-history-row]")];
    return list.find((r) => (r.querySelector("span.text-row")?.textContent ?? "").includes(part)) ?? null;
  }, namePart);
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  await handle.dispose();
  return true;
};

const waitForPreviewing = (wanted) =>
  page
    .waitForFunction(
      (w) => !!document.querySelector("[data-history-row][data-previewing]") === w,
      wanted,
      { timeout: 4000 }
    )
    .then(() => true)
    .catch(() => false);

// The dock's own hide/show is a 260ms slide, so both readings wait it out.
const dockOpacity = (wanted) =>
  page
    .waitForFunction(
      (w) =>
        getComputedStyle(document.querySelector('[data-ui-panel="dock"]')).opacity === w,
      wanted,
      { timeout: 2000 }
    )
    .then(() => true)
    .catch(() => false);

const locked = await docState();
check("history mode stows the tool dock — nothing in it can act on this document",
  await dockOpacity("0"));
await probe("gate_ro_1");
const afterProbe = await docState();
check("with the panel open an edit does not reach the document",
  afterProbe.count === locked.count && !has(afterProbe, "gate_ro_1"),
  `${locked.count} -> ${afterProbe.count}`);

await page.evaluate(() => {
  const bridge = window.__FISH_BRIDGE__;
  bridge.applyDoc({ ...bridge.getDoc(), name: "Replaced while read-only" });
  bridge.undo();
});
const afterReplace = await docState();
check("nor a wholesale replacement or an undo",
  afterReplace.count === locked.count && afterReplace.name === locked.name,
  `count ${afterReplace.count} name "${afterReplace.name}"`);

// Leaving the panel is the whole exit.
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("closing the panel leaves history mode", !(await page.$("[data-history-panel]")));
check("and brings the tool dock back", await dockOpacity("1"));
await probe("gate_live");
const writable = await docState();
check("and the document takes edits again", has(writable, "gate_live"), JSON.stringify(writable.ids));
// That edit armed the version timer; let it land before the row count is
// taken as "browsing minted nothing".
await page.waitForTimeout(900);

// Reopen: locked again before any row is clicked, view still the live document.
await openHistory();
await page.waitForTimeout(350);
await probe("gate_ro_2");
const reopened = await docState();
check("reopening locks it again with no version selected",
  reopened.count === writable.count && !has(reopened, "gate_ro_2"),
  `${writable.count} -> ${reopened.count}`);

const rowsBefore = (await rows()).length;
const entered = await clickRow("Checkpoint");
await waitForPreviewing(true);
const previewed = await docState();
check("clicking a row loads that version onto the canvas",
  entered && !has(previewed, "gate_live"),
  `entered=${entered} count=${previewed.count}`);
// The wash arrives through a colour transition, so it is read when it has
// settled rather than the instant the attribute lands.
const washSettled = await page
  .waitForFunction(
    () => {
      const row = document.querySelector("[data-history-row][data-previewing]");
      return !!row && getComputedStyle(row).backgroundColor === "rgba(232, 163, 61, 0.12)";
    },
    { timeout: 2000 }
  )
  .then(() => true)
  .catch(() => false);
check("the previewing row wears the selection wash", washSettled);

await probe("gate_ro_3");
const stillLocked = await docState();
check("a version on screen is still not writable",
  stillLocked.count === previewed.count && !has(stillLocked, "gate_ro_3"),
  `${previewed.count} -> ${stillLocked.count}`);

// The second approved exit: click the row you are viewing.
await clickRow("Checkpoint");
const leftByClick = await waitForPreviewing(false);
const backLive = await docState();
check("clicking the viewed row again returns to the live document",
  leftByClick && has(backLive, "gate_live"),
  `exit=${leftByClick} ids=${JSON.stringify(backLive.ids)}`);
check("browsing minted no version",
  (await rows()).length === rowsBefore,
  `${rowsBefore} -> ${(await rows()).length}`);

// And the first: Esc, still inside the panel.
await clickRow("Checkpoint");
await waitForPreviewing(true);
await page.keyboard.press("Escape");
const leftByEsc = await waitForPreviewing(false);
const afterEsc = await docState();
check("Escape returns to the live document with the panel still open",
  leftByEsc && has(afterEsc, "gate_live"),
  `exit=${leftByEsc} ids=${JSON.stringify(afterEsc.ids)}`);

await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("the second Escape closes the panel", !(await page.$("[data-history-panel]")));
await probe("gate_final");
const final = await docState();
check("and the document is writable again", has(final, "gate_final"), JSON.stringify(final.ids));

// Tab stows the panel the way it stows every other panel: off the screen,
// with the mode still on — leaving history mode would be a different gesture.
await openHistory();
await page.waitForTimeout(350);
// Nothing may be holding focus in a field: an editable target keeps its own Tab.
await page.evaluate(() => document.activeElement?.blur?.());

const panelBox = () =>
  page.evaluate(() => {
    const el = document.querySelector("[data-history-panel]");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), vw: window.innerWidth };
  });

await page.keyboard.press("Tab");
await page.waitForTimeout(400);
const stowed = await panelBox();
check("Tab slides the panel off with the rest of the chrome",
  !!stowed && stowed.left >= stowed.vw, JSON.stringify(stowed));
await probe("gate_stowed");
check("without leaving history mode", !(await docState()).ids.includes("gate_stowed"));

await page.keyboard.press("Tab");
await page.waitForTimeout(400);
const returned = await panelBox();
check("and Tab brings it back", !!returned && returned.left < returned.vw, JSON.stringify(returned));
await probe("gate_returned");
check("still read-only behind it", !(await docState()).ids.includes("gate_returned"));

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Escape is still the way out", !(await page.$("[data-history-panel]")));
await probe("gate_after_tab");
check("and the document is writable again after Tab",
  (await docState()).ids.includes("gate_after_tab"));

await browser.close();
const clean = errors.length === 0;
if (!clean) console.log(`FAIL  no console/page errors\n      ${errors.join("\n      ")}`);
process.exit(results.every((r) => r.ok) && clean ? 0 : 1);
