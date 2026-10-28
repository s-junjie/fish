import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "node:path";

// Every group heading in the inspector folds, and folding one is a claim about
// the PANEL's layout rather than about the document — so what is asserted here
// is where the fold's state lives, not what the controls do:
//
//  1. A heading is a button that says whether its group is open, and a folded
//     group keeps its heading, its leader rule and its trailing control. The
//     heading is the only thing left, so the group it belongs to is exactly one
//     row tall — folding must not leave the space it was holding.
//  2. A folded group always SHOWS its chevron; an open one reveals it on hover.
//     A fold with no visible affordance is a dead end, and a permanent chevron
//     competes with a strip whose whole job is to be a heading (DESIGN.md).
//  3. The fold survives picking another layer. This is the one that rots
//     silently: the panel keys two of its sections on the selection, so a fold
//     owned by the section — `useState` in the component — is thrown away and
//     re-created by the next click on the canvas, and every check above still
//     passes. It is why the state is module-level and keyed by a stable id.
//  4. Two groups fold independently: one fold may not take its neighbour with
//     it, which is what a single panel-wide "collapsed" flag would do.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const ELEMENTS = [
  { id: "A", type: "rect", name: "A", x: 0, y: 0, width: 100, height: 60, fills: [{ type: "solid", color: "#30A46C" }] },
  { id: "B", type: "rect", name: "B", x: 200, y: 0, width: 40, height: 40, fills: [{ type: "solid", color: "#8B5CF6" }] }
];

/** Every group the panel shows for a plain rect, by the id the fold is keyed on. */
const GROUPS = [
  "component",
  "transform-align",
  "transform-position",
  "layout",
  "appearance",
  "fills",
  "stroke",
  "effects",
  "link",
  "export"
];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const browser = await chromium.launch();
// 3× so the ink check below can resolve a 1px optical offset: at 1× a misaligned
// row and an aligned one can land on the same pixel row.
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
await page.evaluate((elements) => {
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements(JSON.parse(JSON.stringify(elements)));
}, ELEMENTS);

// Long enough for the chevron's own opacity transition (`duration-micro`) to
// have finished: a fold that is still animating reports a fractional opacity.
const settle = async () => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(260);
};
const select = async (id) => {
  await page.evaluate((elId) => window.__FISH_BRIDGE__.selectElement(elId), id);
  await settle();
};
const toggle = async (id) => {
  await page.locator(`[data-inspector-header="${id}"]`).click();
  await settle();
};

const state = () =>
  page.evaluate((groups) => {
    const panel = document.querySelector('[data-ui-panel="right"]');
    const header = (id) => panel.querySelector(`[data-inspector-header="${id}"]`);
    const chevronOpacity = (id) => {
      const span = header(id)?.querySelector('span[aria-hidden="true"]');
      return span ? getComputedStyle(span).opacity : null;
    };
    const box = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
    const found = Array.from(panel.querySelectorAll("[data-inspector-header]")).map((b) =>
      b.getAttribute("data-inspector-header")
    );
    return {
      found,
      missing: groups.filter((id) => !found.includes(id)),
      allButtons: Array.from(panel.querySelectorAll("[data-inspector-header]")).every((b) => b.tagName === "BUTTON"),
      // A group is folded when its heading says so; there is no other record.
      folded: Object.fromEntries(
        groups.map((id) => [id, header(id)?.getAttribute("data-collapsed") === "true"])
      ),
      expandedAttr: Object.fromEntries(
        groups.map((id) => [id, header(id)?.getAttribute("aria-expanded")])
      ),
      fillRows: panel.querySelectorAll('[data-paint-stack="fill"] [data-paint-row]').length,
      addFill: !!panel.querySelector('[title="Add Fill"]'),
      // The group's own box, and the heading ROW inside it (the button's parent;
      // the button itself is only the 9px label). Equal heights mean folding left
      // nothing behind it.
      fillGroupHeight: box(header("fills")?.parentElement?.parentElement),
      fillHeadingRowHeight: box(header("fills")?.parentElement),
      sizeFields: !!panel.querySelector('[data-inspector-section="size"]'),
      chevronOpacity: chevronOpacity("fills")
    };
  }, GROUPS);

await select("A");
const open = await state();

check(
  "every group heading is a fold button",
  open.found.length === GROUPS.length && open.allButtons,
  `found=${JSON.stringify(open.found)}`
);
check("and every one of them is expanded to start with", !Object.values(open.folded).some(Boolean));
check("the fill group lists its rows while open", open.fillRows >= 1, `rows=${open.fillRows}`);
check("an open group's chevron is hidden until the pointer is over it", open.chevronOpacity === "0", `opacity=${open.chevronOpacity}`);

await page.locator('[data-inspector-header="fills"]').hover();
await settle();
const hovered = await state();
check(
  "hovering the label reveals it",
  hovered.chevronOpacity === "1",
  `opacity=${hovered.chevronOpacity}`
);
await page.mouse.move(0, 0);
await settle();

/**
 * A heading row's INK, not its boxes.
 *
 * The label is UPPERCASE, so it draws no descender: at `text-micro`'s 9px with
 * `line-height: 1` its caps sit 1px ABOVE the centre of the line box that the
 * chevron, the leader rule and any trailing control are centred on. Every
 * `getBoundingClientRect` in this file therefore agreed while the pixels did
 * not — the chevron read low beside its own label — so this reads what was
 * painted. A threshold at 30% of the band's own range, rather than a luminance
 * named here, is what keeps it from encoding the panel's colours.
 */
const inkCentres = async (id) => {
  await page.locator(`[data-inspector-header="${id}"]`).hover();
  await settle();
  const parts = await page.evaluate((headerId) => {
    const btn = document.querySelector(`[data-inspector-header="${headerId}"]`);
    const row = btn.parentElement;
    const rect = (el) => {
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
    };
    const label = btn.querySelector("span:not([aria-hidden])");
    const rule = row.querySelector('[aria-hidden="true"].bg-gradient-to-r');
    const tail = row.lastElementChild;
    const trailing = tail === rule ? null : tail.querySelector("svg") ?? tail;
    return {
      label: rect(label),
      chevron: rect(btn.querySelector('span[aria-hidden="true"] svg')),
      rule: rect(rule),
      trailing: trailing && !trailing.classList.contains("h-0") ? rect(trailing) : null
    };
  }, id);

  const xs = [parts.chevron.left, parts.label.left, parts.label.right, parts.rule.left + 24];
  if (parts.trailing) xs.push(parts.trailing.right);
  const clip = {
    x: Math.floor(Math.min(...xs)) - 3,
    y: Math.floor(parts.label.top) - 6,
    width: Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs)) + 6,
    height: Math.ceil(parts.label.bottom) - Math.floor(parts.label.top) + 12
  };
  const shot = (await page.screenshot({ clip })).toString("base64");
  const bands = [
    ["chevron", clip.x, parts.label.left],
    ["label", parts.label.left, parts.label.right],
    ["rule", parts.rule.left, parts.rule.left + 24]
  ];
  if (parts.trailing) bands.push(["trailing", parts.trailing.left, parts.trailing.right]);

  return page.evaluate(
    async ({ shot, clip, bands }) => {
      const img = new Image();
      img.src = "data:image/png;base64," + shot;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const scale = c.width / clip.width;
      const lum = (x, y) => {
        const i = (y * c.width + x) * 4;
        return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      };
      const out = {};
      for (const [name, from, to] of bands) {
        const x0 = Math.max(0, Math.round((from - clip.x) * scale));
        const x1 = Math.min(c.width, Math.round((to - clip.x) * scale));
        let min = 255;
        let max = 0;
        for (let y = 0; y < c.height; y++) {
          for (let x = x0; x < x1; x++) {
            const l = lum(x, y);
            if (l < min) min = l;
            if (l > max) max = l;
          }
        }
        const cut = min + (max - min) * 0.3;
        let top = Infinity;
        let bottom = -Infinity;
        for (let y = 0; y < c.height; y++) {
          for (let x = x0; x < x1; x++) {
            if (lum(x, y) > cut) {
              if (y < top) top = y;
              if (y > bottom) bottom = y;
              break;
            }
          }
        }
        out[name] = top === Infinity ? null : +(clip.y + (top + bottom) / 2 / scale).toFixed(2);
      }
      return out;
    },
    { shot, clip, bands }
  );
};

const axis = await inkCentres("fills");
const off = (k) => (axis[k] === null ? NaN : +(axis[k] - axis.label).toFixed(2));
check(
  "the chevron, the rule and the trailing control sit on the label's caps, not on its line box",
  ["chevron", "rule", "trailing"].every((k) => Math.abs(off(k)) <= 0.5),
  `label ${axis.label} | chevron ${off("chevron")} | rule ${off("rule")} | trailing ${off("trailing")}`
);

// A folded group is its heading and nothing else — and it says so, twice: once
// for a screen reader (`aria-expanded`) and once for the DOM (`data-collapsed`).
await toggle("fills");
const folded = await state();
check("folding a group removes its body", folded.fillRows === 0, `rows=${folded.fillRows}`);
check(
  "the heading stays, and reports the fold",
  folded.folded.fills && folded.expandedAttr.fills === "false"
);
check(
  "the group is one heading tall — the body's space is gone with it",
  folded.fillGroupHeight === folded.fillHeadingRowHeight,
  `group ${open.fillGroupHeight}px → ${folded.fillGroupHeight}px, heading row ${folded.fillHeadingRowHeight}px`
);
check("a folded group always shows its chevron", folded.chevronOpacity === "1", `opacity=${folded.chevronOpacity}`);
check("and keeps its trailing control", folded.addFill === true);
check("the group below it is untouched", folded.folded.stroke === false);
check("and the group above it still has its body", folded.sizeFields === true);

await select("B");
const afterSwitch = await state();
check(
  "the fold survives picking another layer",
  afterSwitch.folded.fills === true && afterSwitch.fillRows === 0,
  `collapsed=${afterSwitch.folded.fills} rows=${afterSwitch.fillRows}`
);

await toggle("fills");
const reopened = await state();
check("clicking it again brings the body back", reopened.fillRows >= 1 && reopened.folded.fills === false);

await toggle("fills");
await toggle("stroke");
const twoFolds = await state();
check(
  "two groups fold independently",
  twoFolds.folded.fills && twoFolds.folded.stroke && twoFolds.addFill === true && twoFolds.sizeFields === true,
  `fills=${twoFolds.folded.fills} stroke=${twoFolds.folded.stroke}`
);

await browser.close();

if (errors.length > 0) {
  console.log("\n--- page errors ---");
  for (const e of errors.slice(0, 6)) console.log(`  ${e}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
