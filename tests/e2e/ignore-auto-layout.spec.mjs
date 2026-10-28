import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// "Ignore auto layout" — the one per-child escape hatch a stack has. Figma's
// name for it, CSS's `position: absolute`, three rules: the stack stops placing
// the child, `constraints` decide how it follows a resize, and it stops counting
// towards a hugging parent. The unit tests pin the layout maths; this pins the
// button and the round trip through the inspector, which no unit test can see.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__);

// A hugging column of three 50x50 boxes at a known slot each. `applyDoc` stores
// the tree verbatim, so the children carry the boxes `applyFlexLayout` gives them.
const seed = () =>
  page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    const base = bridge.getDoc();
    bridge.setElements([
        {
          id: "STACK",
          type: "frame",
          name: "Stack",
          x: 600,
          y: 300,
          width: 300,
          height: 150,
          sizing: { height: "fit-content" },
          fills: [{ type: "solid", color: "#F4F4F5" }],
          display: "flex",
          "flex-direction": "column",
          gap: 0,
          padding: 0,
          children: [
            { id: "a", type: "rect", name: "a", x: 0, y: 0, width: 50, height: 50, fills: [{ type: "solid", color: "#111111" }] },
            { id: "b", type: "rect", name: "b", x: 0, y: 50, width: 50, height: 50, fills: [{ type: "solid", color: "#222222" }] },
            { id: "c", type: "rect", name: "c", x: 0, y: 100, width: 50, height: 50, fills: [{ type: "solid", color: "#333333" }] }
          ]
        },
        {
          id: "PLAIN",
          type: "frame",
          name: "Plain",
          x: 600,
          y: 700,
          width: 300,
          height: 200,
          children: [
            { id: "p1", type: "rect", name: "p1", x: 20, y: 20, width: 60, height: 60, fills: [{ type: "solid", color: "#111111" }] }
          ]
        }
      ], { canvas: { ...base.canvas, width: 4000, height: 3000 } });
  });

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const state = () =>
  page.evaluate(() => {
    const els = window.__FISH_BRIDGE__.getElements();
    const stack = els.find((e) => e.id === "STACK");
    const by = (id) => stack.children.find((c) => c.id === id);
    return {
      height: stack.height,
      order: stack.children.map((c) => c.id),
      a: { x: by("a").x, y: by("a").y },
      b: { x: by("b").x, y: by("b").y, position: by("b").position ?? null },
      c: { x: by("c").x, y: by("c").y }
    };
  });
const toggle = () =>
  page.evaluate(() => {
    const btn = document.querySelector('[data-ignore-auto-layout="true"]');
    if (!btn) return null;
    return { pressed: btn.getAttribute("aria-pressed") === "true", disabled: btn.disabled };
  });
const clickToggle = async () => {
  await page.click('[data-ignore-auto-layout="true"]');
  await settle();
};
const alignRow = () =>
  page.evaluate(() => {
    const row = document.querySelector('[data-align-row="true"]');
    if (!row) return null;
    return [...row.querySelectorAll("button")].every((b) => b.disabled);
  });

// ------------------------------------------------------------------ the button
await seed();
await settle();

// The escape hatch is relative to a stack, so it is not offered to a layer that
// has none — a top-level frame, or a child of a plain frame.
for (const id of ["PLAIN", "p1"]) {
  await page.evaluate((i) => window.__FISH_BRIDGE__.selectElement(i), id);
  await settle();
  check(`no escape hatch for ${id}, which no stack places`, (await toggle()) === null, JSON.stringify(await toggle()));
}

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("b"));
await settle();
check("the button appears for a stack child", JSON.stringify(await toggle()) === JSON.stringify({ pressed: false, disabled: false }), JSON.stringify(await toggle()));
check("the align row is dead for an in-flow child", (await alignRow()) === true, JSON.stringify(await alignRow()));

// ------------------------------------------------------------------ turning on
await clickToggle();
const on = await state();
check("the child is marked absolute", on.b.position === "absolute", JSON.stringify(on.b));
check("it keeps the position the stack gave it", on.b.y === 50, JSON.stringify(on.b));
check("its siblings close the gap", on.a.y === 0 && on.c.y === 50, JSON.stringify({ a: on.a, c: on.c }));
check("the hugging frame no longer counts it", on.height === 100, `height ${on.height}`);
check("the button reads as pressed", (await toggle())?.pressed === true, JSON.stringify(await toggle()));
check("the align row comes back for a free layer", (await alignRow()) === false, JSON.stringify(await alignRow()));

// ------------------------------------------------------------------ arrow keys
const before = await state();
await page.keyboard.press("ArrowDown");
await settle();
const afterArrow = await state();
check("an arrow moves an absolute child instead of reordering", afterArrow.b.y === before.b.y + 1, JSON.stringify({ before: before.b, after: afterArrow.b }));
check("the stack's order is untouched", JSON.stringify(afterArrow.order) === JSON.stringify(before.order), JSON.stringify(afterArrow.order));

// ------------------------------------------------------------------ turning off
await clickToggle();
const off = await state();
check("turning it off puts the child back in the flow", off.b.position === null, JSON.stringify(off.b));
check("the stack packs it again", off.a.y === 0 && off.b.y === 50 && off.c.y === 100, JSON.stringify(off));
check("the hugging frame counts it again", off.height === 150, `height ${off.height}`);
check("the button reads as off", (await toggle())?.pressed === false, JSON.stringify(await toggle()));

// ------------------------------------------------- a resized frame moves it
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("c"));
await settle();
await page.evaluate(() => {
  // `right`/`bottom` constraints are the whole point of the field: the child is
  // placed by nothing, so its constraints are the only thing left to move it.
  const bridge = window.__FISH_BRIDGE__;
  const base = bridge.getDoc();
  bridge.setElements(bridge.getElements().map((e) =>
      e.id !== "STACK"
        ? e
        : {
            ...e,
            children: e.children.map((c) =>
              c.id === "c" ? { ...c, x: 250, position: "absolute", constraints: { horizontal: "right", vertical: "top" } } : c
            )
          }
    ));
});
await settle();
const placed = await state();
check("an absolute child lands where it was put", placed.c.x === 250, JSON.stringify(placed.c));
check("it takes no cell from the flow", placed.b.y === 50, JSON.stringify(placed));

// ---------------------------------------------- the constraints editor, reachable
// The widget used to be gated on `parent.display !== "flex"`, which hides it
// for a flex parent — the only parent an absolute child can have. So the field the
// button's own tooltip promises was unediteditable exactly where it applies.
const IN_FLOW_WHY =
  "The stack places this layer itself, so a constraint here would be overwritten on the next layout pass. Turn on Ignore auto layout to constrain it.";
const NO_PARENT_WHY =
  "This layer sits on the page. Constraints only decide how a layer inside a frame follows that frame.";

const constraintsBlock = () =>
  page.evaluate(() => {
    const widget = document.querySelector('[data-constraints-widget="true"]');
    if (!widget) return null;
    return {
      title: widget.closest("div[title]")?.getAttribute("title") ?? null
    };
  });

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("b"));
await settle();
const inFlowWidget = await constraintsBlock();
check(
  "the block is hidden for an in-flow stack child",
  inFlowWidget === null,
  JSON.stringify(inFlowWidget)
);

await clickToggle();
const absWidget = await constraintsBlock();
// "Editable" is not a class any more: the block used to be drawn greyed behind a
// `pointer-events-none` when the layer could not be constrained, and it is now
// simply not drawn. So it is present here, and the proof it is operable is the
// write two checks down — reading a class that no longer exists is how the
// check below spent two commits asserting something nothing could satisfy.
check(
  "turning on Ignore auto layout shows the field, with no reason in its tooltip",
  absWidget !== null && !absWidget.title,
  JSON.stringify(absWidget)
);

await page.selectOption('[data-constraints-axis="h"]', "right");
await settle();
const pinned = await page.evaluate(() => {
  const stack = window.__FISH_BRIDGE__.getElements().find((e) => e.id === "STACK");
  return stack.children.find((c) => c.id === "b").constraints;
});
check("the dropdown writes the constraint onto the child", pinned?.horizontal === "right", JSON.stringify(pinned));

await clickToggle();
const backInFlow = await constraintsBlock();
// The field is GONE, not greyed: a control that cannot be operated and says so
// is still a control to read past, and the section already has the button above
// it that turns it on. (`ConstraintsSection` returns null here; the same
// absence is asserted for a stack child two checks up.)
check("turning it off takes the editor away again", backInFlow === null, JSON.stringify(backInFlow));

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("p1"));
await settle();
const freeFrameWidget = await constraintsBlock();
check(
  "a child of a plain frame is editable: nothing places it but its constraints",
  freeFrameWidget !== null,
  JSON.stringify(freeFrameWidget)
);

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("STACK"));
await settle();
const onPage = await constraintsBlock();
check("a layer on the page has no constraints UI rendered", onPage === null, JSON.stringify(onPage));

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${r.detail ?? ""}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("pageErrors", errors.slice(0, 5));

await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
