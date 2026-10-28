#!/usr/bin/env node
// Phase-1 render probe: does an instance REALLY inherit its master's box?
//
// String assertions cannot answer this — inheritance is resolved at render time
// by `resolveInstanceBox`, and the failure modes are silent (a fill that paints
// nothing, a shadow that vanishes, a gradient def indexed from the wrong stack).
// So this splices a purpose-built document into the built shell and measures the
// rendered SVG in Chromium.
//
// Usage: node scripts/probe-instance-inherit.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";

const SHELL = path.resolve("dist/index.html");
if (!fs.existsSync(SHELL)) {
  console.error("dist/index.html missing — run `npx vite build` first");
  process.exit(1);
}

const GRADIENT = { type: "linear-gradient", from: "#FF0000", to: "#0000FF", angle: 90 };

const canvas = { width: 1440, height: 900, background: { type: "solid", color: "#1e1e1e" }, unit: "px" };

const card = {
  id: "cmp_card",
  type: "component",
  name: "Card",
  x: 40,
  y: 40,
  width: 220,
  height: 120,
  fills: [{ type: "solid", color: "#FFFFFF" }, GRADIENT],
  strokes: [{ color: "#000000", width: 2 }],
  borderRadius: 12,
  clipContent: true,
  effects: [{ type: "drop-shadow", color: "rgba(0,0,0,0.5)", offset: { x: 0, y: 6 }, blur: 12 }],
  children: [
    {
      id: "cmp_label",
      type: "text",
      x: 16,
      y: 16,
      width: 120,
      height: 24,
      content: "Card",
      style: { fontFamily: "Inter", fontSize: 16, color: "#111111" }
    }
  ]
};

const instances = [
  { id: "inst_inherit", x: 340, y: 40 },
  { id: "inst_nofill", x: 620, y: 40, fills: [] },
  { id: "inst_own", x: 340, y: 220, fills: [{ type: "solid", color: "#00FF00" }], effects: [] },
  { id: "inst_owneffects", x: 620, y: 220, effects: [{ type: "layer-blur", blur: 4 }] }
].map((o) => ({
  id: o.id,
  type: "instance",
  name: `${o.id} Instance`,
  componentId: "cmp_card",
  width: 220,
  height: 120,
  ...o,
  x: o.x,
  y: o.y
}));

const doc = {
  version: "0.1",
  id: "probe_doc",
  name: "Instance Inheritance Probe",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  canvas,
  pages: [{ id: "page_1", name: "Page 1", canvas, children: [card, ...instances] }],
  activePageId: "page_1"
};

const DOC_RE = /<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i;
const shellHtml = fs.readFileSync(SHELL, "utf-8");
if (!DOC_RE.test(shellHtml)) {
  console.error("shell has no #design-doc block");
  process.exit(1);
}
const block = `<script id="design-doc" type="application/json">\n${JSON.stringify(doc).replace(/</g, "\\u003c")}\n  </script>`;
const out = path.join(os.tmpdir(), "fish-instance-inherit-probe.html");
fs.writeFileSync(out, shellHtml.replace(DOC_RE, () => block));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto("file://" + out, { waitUntil: "load" });
await page.waitForSelector("[data-element-id]", { timeout: 60000 });
await page.waitForTimeout(2500);

const facts = await page.evaluate((ids) => {
  const paintedFills = (el) =>
    Array.from(el.querySelectorAll("path"))
      .map((p) => p.getAttribute("fill"))
      .filter((f) => f && f !== "transparent" && f !== "none");
  const out = { instances: {}, defs: {} };
  for (const id of ids) {
    const g = document.querySelector(`g[data-element-id="${id}"]`);
    out.instances[id] = g
      ? {
          hasNode: true,
          filter: g.getAttribute("filter"),
          paintedFills: paintedFills(g),
          childNodes: g.querySelectorAll("[data-element-id]").length,
          textNodes: g.querySelectorAll("foreignObject, text").length
        }
      : { hasNode: false };
  }
  const defIds = [
    "grad_fill_inst_inherit_1",
    "grad_fill_inst_inherit_0",
    "filter_inst_inherit",
    "clip_inst_inherit",
    "filter_inst_owneffects",
    "filter_inst_own",
    "clip_inst_nofill"
  ];
  for (const id of defIds) {
    const el = document.getElementById(id);
    out.defs[id] = el ? { exists: true, children: el.children.length } : { exists: false };
  }
  return out;
}, instances.map((i) => i.id));

const dumpArg = process.argv.find((a) => a.startsWith("--dump="));
if (dumpArg) {
  const id = dumpArg.slice("--dump=".length);
  const html = await page.evaluate((elId) => {
    const g = document.querySelector(`g[data-element-id="${elId}"]`);
    return g ? g.outerHTML.replace(/></g, ">\n<") : "not found";
  }, id);
  console.log(html + "\n");
}

const shotPath = path.resolve("figma-imports/probe-instance-inherit.png");
fs.mkdirSync(path.dirname(shotPath), { recursive: true });
const clipArg = process.argv.find((a) => a.startsWith("--clip="));
const clip = clipArg
  ? (() => {
      const [x, y, width, height] = clipArg.slice("--clip=".length).split(",").map(Number);
      return { x, y, width, height };
    })()
  : { x: 250, y: 60, width: 660, height: 300 };
// Cropped: at panel scale a missing child is invisible to the eye, and "the box is
// the right size" says nothing about what is painted inside it.
await page.screenshot({ path: shotPath, clip });
console.log(`screenshot: ${shotPath}\n`);

await browser.close();

const failures = [];const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label} — ${detail}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
};

const inst = facts.instances;

// P0-2: the instance paints what the master paints, resolved from the SAME stack
// (the gradient sits at index 1 of the master's fill stack, so a def indexed from
// a different stack would render shifted or not at all).
check(
  "P0-2 inherited fill paints the master's gradient at the right stack index",
  inst.inst_inherit.paintedFills.includes("url(#grad_fill_inst_inherit_1)"),
  inst.inst_inherit.paintedFills.join(", ") || "no fill painted"
);
check(
  "P0-2 the matching gradient def exists and agrees on the index",
  facts.defs.grad_fill_inst_inherit_1.exists && !facts.defs.grad_fill_inst_inherit_0.exists,
  `_1=${facts.defs.grad_fill_inst_inherit_1.exists} _0=${facts.defs.grad_fill_inst_inherit_0.exists}`
);

// P0-4: the master's shadow reaches the instance.
check(
  "P0-4 inherited effects are applied to the instance group",
  inst.inst_inherit.filter === "url(#filter_inst_inherit)",
  String(inst.inst_inherit.filter)
);
check(
  "P0-4 the instance's own filter def is emitted from the master's effects",
  facts.defs.filter_inst_inherit.exists && facts.defs.filter_inst_inherit.children >= 4,
  `${facts.defs.filter_inst_inherit.children} primitives`
);
check(
  "P0-4 clipContent is inherited and the clip def is emitted",
  facts.defs.clip_inst_inherit.exists,
  ""
);

// P0-3: an explicit empty stack means "paint nothing" and must not fall back.
check(
  "P0-3 an instance with fills: [] paints no fill",
  inst.inst_nofill.paintedFills.length === 0,
  inst.inst_nofill.paintedFills.join(", ") || "none"
);

// The instance's own fields still win.
check(
  "own fill overrides the master's",
  inst.inst_own.paintedFills.length === 1 && /00FF00|rgb\(0,\s*255,\s*0\)/i.test(inst.inst_own.paintedFills[0]),
  inst.inst_own.paintedFills.join(", ")
);
check(
  "an explicit effects: [] suppresses the master's effects",
  !inst.inst_own.filter && !facts.defs.filter_inst_own.exists,
  `filter=${inst.inst_own.filter}`
);
check(
  "the instance's own effects are used instead of the master's",
  inst.inst_owneffects.filter === "url(#filter_inst_owneffects)" &&
    facts.defs.filter_inst_owneffects.exists,
  String(inst.inst_owneffects.filter)
);

// Children still resolve through the instance — for every instance, not just the
// one that inherits everything: an override on the instance's own box must not
// drop the master's children.
for (const id of ["inst_inherit", "inst_nofill", "inst_own", "inst_owneffects"]) {
  check(
    `the master's children are still resolved for ${id}`,
    inst[id].childNodes >= 1 && inst[id].textNodes >= 1,
    `${inst[id].childNodes} node(s), ${inst[id].textNodes} text/foreignObject`
  );
}
check("no console/page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(`\n${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}`);
for (const f of failures) console.log("  " + f);
process.exit(failures.length === 0 ? 0 : 1);
