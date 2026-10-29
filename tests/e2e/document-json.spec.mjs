import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// The document-JSON rows and the Import dialog. Unit tests prove the two
// serializers round-trip and that a merge re-ids correctly; nothing but this
// proves the MENU reaches them, that the export writes what the serializer
// returned, and that the two ways in are offered before anything is replaced.
//
// The merge claims are the ones worth making:
//   - the import lands beside what was already there, not over it;
//   - a two-page file brings in two pages, which is what "import into new
//     pages" claims;
//   - a replace still names the file it is about to overwrite, and is one undo.
//
// `showSaveFilePicker` / `showOpenFilePicker` are stubbed rather than left to the
// browser: the question is what gets WRITTEN and what gets READ, and a stub
// records both.

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const ELEMENTS = [
  { id: "dj_a", type: "rect", name: "Before", x: 0, y: 0, width: 400, height: 200, fills: [{ type: "solid", color: "#3E63DD" }] }
];

const INCOMING = {
  version: "0.1",
  name: "From JSON",
  canvas: { width: 1200, height: 800, unit: "px", background: { type: "solid", color: "#101010" } },
  activePageId: "pg_in_1",
  pages: [
    {
      id: "pg_in_1",
      name: "Landing",
      canvas: { width: 1200, height: 800, unit: "px", background: { type: "solid", color: "#101010" } },
      children: [{ id: "dj_z", type: "rect", name: "After", x: 40, y: 40, width: 200, height: 100, fills: [{ type: "solid", color: "#E0A02A" }] }]
    },
    {
      id: "pg_in_2",
      name: "Detail",
      canvas: { width: 1200, height: 800, unit: "px", background: { type: "solid", color: "#101010" } },
      children: [{ id: "dj_z3", type: "rect", name: "Detail Row", x: 0, y: 0, width: 300, height: 80 }]
    }
  ]
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  permissions: ["clipboard-read", "clipboard-write"]
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

// The two doors, installed before the app boots so the rows never see an absent
// picker. Each records what it was handed.
await page.addInitScript(() => {
  window.__exported = [];
  globalThis.showSaveFilePicker = async (opts) => {
    window.__exported.push({ suggestedName: opts?.suggestedName });
    return {
      name: opts?.suggestedName ?? "out.json",
      createWritable: async () => {
        let buf = "";
        return {
          write: async (chunk) => {
            buf += chunk;
          },
          close: async () => {
            window.__exported[window.__exported.length - 1].written = buf;
          }
        };
      }
    };
  };
  globalThis.__importFile = null;
  globalThis.showOpenFilePicker = async () => {
    const text = window.__importFile;
    if (text === null) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    return [{ name: "incoming.fish.json", getFile: async () => ({ text: async () => text }) }];
  };
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
await page.evaluate((elements) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements(JSON.parse(JSON.stringify(elements)));
}, ELEMENTS);
await page.waitForTimeout(300);

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const idle = async () => {
  await settle();
  await page.waitForTimeout(150);
  await settle();
};

const pageNames = () =>
  page.evaluate(() => window.__FISH_BRIDGE__.getDoc().pages.map((p) => p.name));
const activeNames = () =>
  page.evaluate(() => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const p = doc.pages.find((x) => x.id === doc.activePageId);
    return (p?.children ?? []).map((e) => e.name);
  });
const readClipboard = () => page.evaluate(() => navigator.clipboard.readText());

// ------------------------------------------------------------------- the rows
await page.click("[data-autosave-status]");
await idle();

const rows = await page.evaluate(() => {
  const pick = (sel) => {
    const n = document.querySelector(sel);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
      text: n.textContent.trim(),
      height: b.height,
      hit: !!hit && (hit === n || n.contains(hit))
    };
  };
  return {
    exportRow: pick("[data-title-bar-export-json]"),
    importRow: pick("[data-title-bar-import-json]"),
    history: pick("[data-title-bar-history]")
  };
});
check("the menu carries export, import and history", Object.values(rows).every(Boolean), JSON.stringify(rows));
check("each is a 26px menu row", Object.values(rows).every((r) => r && Math.abs(r.height - 26) < 0.5), JSON.stringify(Object.entries(rows).map(([k, r]) => `${k}:${r?.height}`)));
check("each is the topmost thing at its own centre", Object.values(rows).every((r) => r?.hit));

// The two transport rows are one section; Version History is the last row,
// alone. Asserted by position because the separation IS the meaning.
const grouping = await page.evaluate(() => {
  const menu = document.querySelector("[data-title-bar-new-file]")?.closest("div.flex.flex-col");
  if (!menu) return null;
  const rows = [...menu.children];
  const at = (sel) => rows.findIndex((c) => c.matches(sel));
  const rules = rows.map((c, i) => (c.tagName === "DIV" ? i : -1)).filter((i) => i >= 0);
  return {
    save: at("[data-title-bar-save-as]"),
    exportRow: at("[data-title-bar-export-json]"),
    importRow: at("[data-title-bar-import-json]"),
    history: at("[data-title-bar-history]"),
    last: rows.length - 1,
    rules
  };
});
check(
  "export and import are one unbroken section, bracketed by rules",
  grouping !== null &&
    grouping.save < grouping.exportRow &&
    grouping.exportRow < grouping.importRow &&
    !grouping.rules.some((r) => r > grouping.exportRow && r < grouping.importRow) &&
    grouping.rules.some((r) => r > grouping.save && r < grouping.exportRow) &&
    grouping.rules.some((r) => r > grouping.importRow && r < grouping.history),
  JSON.stringify(grouping)
);
check("Version History is the last row, after the rule", grouping !== null && grouping.history === grouping.last && grouping.history > grouping.rules[grouping.rules.length - 1], JSON.stringify(grouping));

// ------------------------------------------------------------------ export it
await page.click("[data-title-bar-export-json]");
await idle();

const exported = await page.evaluate(() => window.__exported.at(-1) ?? null);
check("Export writes a .fish.json file the user named", exported !== null && /\.fish\.json$/.test(exported.suggestedName ?? ""), JSON.stringify(exported?.suggestedName));

let fullDoc = null;
try {
  fullDoc = JSON.parse(exported?.written ?? "");
} catch {
  fullDoc = null;
}
check("what it wrote parses as JSON", fullDoc !== null);
check("it carries this tab's element", fullDoc?.pages?.some((p) => p.children?.some((e) => e.name === "Before")) === true);
check("and it is pretty-printed, like a #design-doc block", (exported?.written ?? "").includes("\n  "), (exported?.written ?? "").slice(0, 40).replace(/\n/g, "\\n"));

// --------------------------------------------------------------- the dialog
// A cancelled picker is not an error and must not open anything.
await page.click("[data-autosave-status]");
await idle();
await page.click("[data-title-bar-import-json]");
await idle();
check("a cancelled picker opens no dialog", await page.evaluate(() => !document.querySelector("[role=dialog]")));

await page.evaluate((json) => {
  window.__importFile = json;
}, JSON.stringify(INCOMING, null, 2));
await page.click("[data-autosave-status]");
await idle();
await page.click("[data-title-bar-import-json]");
await idle();

const dialog = await page.evaluate(() => {
  const d = document.querySelector("[role=dialog]");
  if (!d) return null;
  const card = d.querySelector("[data-import-from-json]");
  const b = card.getBoundingClientRect();
  const cs = getComputedStyle(card);
  return {
    title: d.querySelector(".text-displaySm")?.textContent?.trim(),
    fileName: d.textContent.includes("incoming.fish.json"),
    hasTextarea: !!d.querySelector("textarea"),
    radius: cs.borderRadius,
    shadow: cs.boxShadow,
    bg: cs.backgroundColor,
    width: Math.round(b.width)
  };
});
check("picking a file opens a dialog", dialog !== null, JSON.stringify(dialog));
check("it names the file that arrived", dialog?.fileName === true, JSON.stringify(dialog));
check("it no longer asks for a paste", dialog?.hasTextarea === false);
const shadowOk = dialog !== null && dialog.shadow !== "none" && /rgba\(0, 0, 0, 0?\.\d+\) 0px 2px 6px/.test(dialog.shadow);
check("it is a modal card — panel fill, panel radius, modal depth", dialog !== null && dialog.bg === "rgb(24, 24, 24)" && dialog.radius === "9px" && shadowOk, `${dialog?.bg} / r${dialog?.radius} / ${dialog?.shadow}`);

const offered = await page.evaluate(() => {
  const d = document.querySelector("[role=dialog]");
  return {
    status: d.querySelector("[data-import-from-json-status]")?.textContent?.trim(),
    merge: !!d.querySelector("[data-import-merge]"),
    replace: !!d.querySelector("[data-import-replace]"),
    focused: document.activeElement?.matches("[data-import-merge]"),
    // Two doors and a way out. A third action here would be one more thing the
    // user can do to a document by accident.
    buttons: [...d.querySelectorAll("button")].map((b) => b.textContent.trim())
  };
});
check("it asks before it acts, offering both ways in", offered.merge && offered.replace, JSON.stringify(offered));
check("and it offers exactly two doors, plus the way out", offered.buttons.length === 3 && offered.buttons.at(-1) === "Cancel", JSON.stringify(offered.buttons));
check("and it reports what arrived before anything is applied", /2 pages/.test(offered.status ?? ""), offered.status);
check("the non-destructive door takes the focus", offered.focused === true, JSON.stringify(offered));

// ------------------------------------------------------------------- merge
const before = await pageNames();
await page.click("[data-import-merge]");
await idle();

const merged = await page.evaluate(() => {
  const doc = window.__FISH_BRIDGE__.getDoc();
  const active = doc.pages.find((p) => p.id === doc.activePageId);
  return {
    names: doc.pages.map((p) => p.name),
    active: active?.name,
    activeElements: (active?.children ?? []).map((e) => e.name),
    ids: doc.pages.flatMap((p) => p.children.map((e) => e.id)),
    dialogGone: !document.querySelector("[role=dialog]")
  };
});
check("merging appends the file's two pages to the ones already here", merged.names.join("|") === [...before, "Landing", "Detail"].join("|"), merged.names.join("|"));
check("nothing already here is lost", merged.names.slice(0, before.length).join("|") === before.join("|"));
check("the import lands you on the first page it brought", merged.active === "Landing", merged.active);
check("that page holds the file's own elements", merged.activeElements.join(",") === "After", merged.activeElements.join(","));
check("imported elements are re-id'd, so they cannot shadow what is here", new Set(merged.ids).size === merged.ids.length, `${merged.ids.length} ids, ${new Set(merged.ids).size} distinct`);
check("the dialog closes behind it", merged.dialogGone === true);

await page.evaluate(() => window.__FISH_BRIDGE__.undo());
await idle();
check("one undo takes the whole merge back", (await pageNames()).join("|") === before.join("|"), (await pageNames()).join("|"));

// ------------------------------------------------------------------ replace
const beforeReplace = await pageNames();
await page.click("[data-autosave-status]");
await idle();
await page.click("[data-title-bar-import-json]");
await idle();
await page.click("[data-import-replace]");
await idle();

const replaced = await page.evaluate(() => {
  const doc = window.__FISH_BRIDGE__.getDoc();
  const active = doc.pages.find((p) => p.id === doc.activePageId);
  return {
    names: doc.pages.map((p) => p.name),
    activeElements: (active?.children ?? []).map((e) => e.name),
    painted: !!document.querySelector('[data-element-id="dj_z"]')
  };
});
check("replacing makes the file THE document", replaced.names.join("|") === "Landing|Detail", replaced.names.join("|"));
check("and its elements are painted", replaced.painted === true && replaced.activeElements.join(",") === "After", replaced.activeElements.join(","));

await page.evaluate(() => window.__FISH_BRIDGE__.undo());
await idle();
const undone = await pageNames();
check("one undo brings the whole document back", undone.join("|") === beforeReplace.join("|"), `${undone.join("|")} vs ${beforeReplace.join("|")}`);

check("no console errors", errors.length === 0, errors.join("\n      "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);