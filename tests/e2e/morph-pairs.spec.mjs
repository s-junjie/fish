import { chromium } from "playwright";
import { pathToFileURL } from "url";
import fs from "node:fs";
import path from "node:path";

// The morph pairing lines, as a reader sees them: which layer of this slide
// becomes which layer of the next one, drawn on the canvas while the slide that
// morphs is selected. Asserted by geometry rather than by presence — a line
// between the wrong two boxes is worse than no line at all, and only the
// endpoints can tell them apart.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");

const VIEW = { width: 1600, height: 1000 };

// Under `tests/fixtures/`, not `demo/`: `demo/` is gitignored, so a fixture read
// from there is a spec that passes on the machine that wrote it and cannot start
// on anyone else's checkout. Every other spec here carries its document inline.
const deck = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "tests/fixtures/morph-deck.json"), "utf8"));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
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
await page.evaluate((doc) => window.__FISH_BRIDGE__.applyDoc(doc), deck);
await page.waitForTimeout(400);

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const idle = async () => {
  await settle();
  await page.waitForTimeout(150);
  await settle();
};

// The section renders nothing at all when the selection has no slide, so it is
// absent from the stack rather than empty inside it — an empty first child would
// hand the next section the stack's own gap.
const sectionEmpty = () =>
  page.evaluate(() => {
    const g = document.querySelector("[data-inspector-section='slide']");
    return !g || g.textContent.trim() === "";
  });
const sectionText = async () => (await page.locator("[data-inspector-section='slide']").innerText().catch(() => "")) ?? "";

const armedTransition = () =>
  page.evaluate(() => {
    const g = document.querySelector("[data-inspector-section='slide']");
    const on = g?.querySelector("[data-slide-transition][aria-pressed='true']");
    return on ? on.getAttribute("data-slide-transition") : null;
  });

const lines = () =>
  page.evaluate(() => {
    const g = document.querySelector("[data-morph-pairs]");
    if (!g) return null;
    return Array.from(g.querySelectorAll("line")).map((l) => ({
      x1: Number(l.getAttribute("x1")),
      y1: Number(l.getAttribute("y1")),
      x2: Number(l.getAttribute("x2")),
      y2: Number(l.getAttribute("y2")),
      stroke: l.getAttribute("stroke")
    }));
  });

const linesToggle = () =>
  page.evaluate(() => document.querySelector("[data-morph-lines-toggle]")?.getAttribute("data-morph-lines-toggle") ?? null);

// Slide 2 carries no transition, so nothing should be drawn for it, and nothing
// should be drawn before a slide is selected at all.
check("nothing is drawn before a slide is selected", (await lines()) === null);
check("no Slide section before a slide is selected", await sectionEmpty());

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("s2"));
await idle();
check("a slide with no transition draws nothing", (await lines()) === null);
// A cut is a slide's default state, not the absence of a slide: the panel has to
// be there to offer the other four.
check("but it still carries the section", (await sectionEmpty()) === false);
check("with the cut armed", (await armedTransition()) === "none", String(await armedTransition()));

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("s1"));
await idle();
const drawn = await lines();
check("the morphing slide draws its pairs", Array.isArray(drawn) && drawn.length === 4, `drew ${drawn ? drawn.length : 0} lines, expected 4`);

// Headline, Card, Image and Panel are depth 0; Dot rides inside the paired
// Panel. Since Panel is already paired, its internal elements do not pair.
// Card sits at 48,210 on slide 1 (slide at 80,120) and at 150,130 on slide 2
// (slide at 800,120), so its line runs between the two CENTRES — horizontally as
// well as vertically, which is the case that catches a start box wandering off.
const card = { x1: 248, y1: 378, x2: 1160, y2: 340 };
const found = (drawn ?? []).find(
  (l) =>
    Math.abs(l.x1 - card.x1) < 1 &&
    Math.abs(l.y1 - card.y1) < 1 &&
    Math.abs(l.x2 - card.x2) < 1 &&
    Math.abs(l.y2 - card.y2) < 1
);
check("Card's line runs between the two centres it should", Boolean(found), JSON.stringify(drawn));

// Slide 1's `Image` is a RECT and slide 2's is an ELLIPSE. They pair, because
// the identity that carries is the name alone: the box and the alpha travel, and
// the shape the audience ends on is the one the author drew there.
const types = await page.evaluate(() => {
  const find = (id) => {
    const doc = window.__FISH_BRIDGE__.getDoc();
    const walk = (els) => {
      for (const e of els) {
        if (e.id === id) return e;
        const hit = e.children ? walk(e.children) : null;
        if (hit) return hit;
      }
      return null;
    };
    return walk(window.__FISH_BRIDGE__.getElements());
  };
  return { from: find("s1-image")?.type, to: find("s2-image")?.type };
});
check("the two slides hold that name as different shapes", types.from === "rect" && types.to === "ellipse", JSON.stringify(types));

const image = { x1: 80 + 320 + 120, y1: 120 + 210 + 48, x2: 800 + 380 + 100, y2: 120 + 312 + 22 };
const imageLine = (drawn ?? []).find(
  (l) =>
    Math.abs(l.x1 - image.x1) < 1 &&
    Math.abs(l.y1 - image.y1) < 1 &&
    Math.abs(l.x2 - image.x2) < 1 &&
    Math.abs(l.y2 - image.y2) < 1
);
check("and they still draw a line between them", Boolean(imageLine), JSON.stringify(drawn));

// Dot rides inside a paired Panel: since Panel already has a pair, its internal elements
// are not paired and get no line.
const dot = { x1: 142, y1: 452, x2: 1342, y2: 340 };
const dotLine = (drawn ?? []).find(
  (l) =>
    Math.abs(l.x1 - dot.x1) < 1 &&
    Math.abs(l.y1 - dot.y1) < 1 &&
    Math.abs(l.x2 - dot.x2) < 1 &&
    Math.abs(l.y2 - dot.y2) < 1
);
check("an internal element inside an already-paired frame gets no line", !dotLine, JSON.stringify(drawn));

// Badge exists only on slide 1 and Note only on slide 2, so neither may have a
// line: they fade where they stand instead of travelling.
const strayEnds = (drawn ?? []).filter(
  (l) => Math.abs(l.x1 - (80 + 400 + 90)) < 1 || Math.abs(l.x2 - (800 + 48 + 150)) < 1
);
check("an unmatched layer gets no line", strayEnds.length === 0, JSON.stringify(strayEnds));

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("s2"));
await idle();
check("the lines leave with the selection", (await lines()) === null);

// ------------------------------------------------------------- the Slide section
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("s1"));
await idle();
// `uppercase` is a CSS transform, so the rendered text is "SLIDE" — matching the
// authored casing would assert against a string the DOM never contains.
const text = await sectionText();
check("a top-level slide carries the section", /slide/i.test(text), JSON.stringify(text.slice(0, 120)));
check("and arms the transition the document stores", (await armedTransition()) === "morph", String(await armedTransition()));
check("and counts the pairs the canvas is drawing", /\b4\b/.test(text), JSON.stringify(text.slice(0, 200)));

// ---------------------------------------------------------------------- the switch
// The lines are a reading of two artboards at once — wanted while deciding what
// pairs with what, in the way while editing the slide itself.
check("the list of pairs carries a switch", (await linesToggle()) === "on", String(await linesToggle()));
await page.click("[data-morph-lines-toggle]");
await idle();
check("switching it off takes the lines off the canvas", (await lines()) === null);
// A view preference that reached the document would show up here as a `slide`
// change, and one that reached the panel would break the row asserting later.
check("and is not a document edit", (await armedTransition()) === "morph", String(await armedTransition()));
await page.click("[data-morph-lines-toggle]");
await idle();
check("switching it back on draws them again", (await lines())?.length === 4, JSON.stringify(await lines()));

// Hovering a row is the one place the line and the list name the same thing, so
// the lit line has to be the hovered pair's — not merely "a line changed".
const restStrokes = (await lines())?.map((l) => l.stroke) ?? [];
check("lines rest in the guide grey", restStrokes.every((s) => s === "#888888"), JSON.stringify(restStrokes));
await page.hover("[data-morph-pair='s1-card']");
await idle();
const hovered = await lines();
const blue = (hovered ?? []).filter((l) => l.stroke === "#1B72FF");
check("hovering a row lights exactly one line", blue.length === 1, JSON.stringify((hovered ?? []).map((l) => l.stroke)));
check("and it is that pair's line", blue[0] && Math.abs(blue[0].x2 - 1160) < 1, JSON.stringify(blue));
await page.mouse.move(20, 20);
await idle();
check("and it goes back to grey when the pointer leaves", (await lines())?.every((l) => l.stroke === "#888888"));

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("s2"));
await idle();
check("the last slide has no switch — there is nothing to turn off", (await linesToggle()) === null);

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("s1-card"));
await idle();
check("a layer INSIDE a slide has no section of its own", await sectionEmpty());

// Writing from the panel is the whole point of it: a click has to land in the
// document, not only in the control's own state.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("s1"));
await idle();
await page.click("[data-slide-transition='push']");
await idle();
const stored = await page.evaluate(() => window.__FISH_BRIDGE__.getElements().find((e) => e.id === "s1").slide);
check("picking a transition writes it to the frame", stored && stored.transition === "push", JSON.stringify(stored));
check("and push asks which way it comes from", (await sectionText()).includes("Direction"));

// The direction buttons carry an edge marker AND an arrow, because one arrow had
// to mean either "comes from" or "moves towards" and the reader picked the other
// one. `left` is the value; its arrow has to point RIGHT, the way that slide
// travels. Asserted on the path's own start, which is the marker's edge.
const arrowPath = (value) =>
  page.evaluate((v) => document.querySelector(`[data-slide-direction='${v}'] svg path`)?.getAttribute("d") ?? "", value);
check("the 'from left' arrow marks the left edge", (await arrowPath("left")).startsWith("M2.5 4.5v7"), await arrowPath("left"));
check("and points the way that slide travels — rightward", (await arrowPath("left")).includes("L12 8"), await arrowPath("left"));
check("the 'from right' arrow mirrors it", (await arrowPath("right")).startsWith("M13.5 4.5v7"), await arrowPath("right"));

await page.click("[data-slide-direction='left']");
await idle();
check(
  "and the panel writes the value the arrow marked",
  (await page.evaluate(() => window.__FISH_BRIDGE__.getElements().find((e) => e.id === "s1").slide)).direction === "left"
);

// The list names layers, so a row has to be able to hand one back: reading the
// pairing and then hunting for the layer on the canvas is the other half of the
// job. Asserted through the bridge's own selection, not the row's styling.
await page.click("[data-slide-transition='morph']");
await idle();
await page.click("[data-morph-pair='s1-card']");
await idle();
check(
  "clicking a pair row selects that layer on this slide",
  JSON.stringify(await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds())) === JSON.stringify(["s1-card"]),
  JSON.stringify(await page.evaluate(() => window.__FISH_BRIDGE__.getSelectedIds()))
);
// The same rule the panel already states for a deeper selection: the section
// belongs to a slide, and the selection is now a layer inside one.
check("and hands the panel over to that layer", await sectionEmpty());

await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("s1"));
await idle();
// Layers without a counterpart are still seen by the matcher; the panel just is
// not the place for them — the list is the pairs, and nothing else.
check("the pairs well lists only pairs", !(await sectionText()).includes("Only on"), JSON.stringify(await sectionText()));

// Put the morph back: the check above left the slide on `push`, and the playback
// assertions below are about how a morph moves.
await page.click("[data-slide-transition='morph']");
await idle();
check(
  "the panel can put it back",
  (await page.evaluate(() => window.__FISH_BRIDGE__.getElements().find((e) => e.id === "s1").slide)).transition ===
    "morph"
);

// ------------------------------------------------------------------- playback
// A morph that renders the right two slides but no motion between them is the
// whole feature quietly missing, so the assertion is a position sampled DURING
// the transition: it has to differ from where the layer settles.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("s1"));
await idle();
await page.keyboard.press("Meta+Enter");
await idle();
check("Cmd+Enter opens the deck", (await page.locator("[data-present-overlay]").count()) === 1);

const boxIn = (stage, id) =>
  page.evaluate(
    ([s, elId]) => {
      const root = document.querySelector(s);
      const n = root?.querySelector(`[data-element-id="${CSS.escape(elId)}"]`);
      if (!n) return null;
      const b = n.getBoundingClientRect();
      return { left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width) };
    },
    [stage, id]
  );

// The element's own group carries its alpha, which is where a pair's
// interpolated one lands.
const alphaIn = (stage, id) =>
  page.evaluate(
    ([s, elId]) => {
      const root = document.querySelector(s);
      const n = root?.querySelector(`[data-element-id="${CSS.escape(elId)}"]`);
      const v = n?.getAttribute("opacity");
      return v === null || v === undefined ? null : Number(v);
    },
    [stage, id]
  );

await page.keyboard.press("ArrowRight");
await page.waitForTimeout(150);
const mid = await boxIn("[data-present-stage='true']", "s2-card");
const imageMid = await boxIn("[data-present-stage='true']", "s2-image");
const alphaMid = await alphaIn("[data-present-stage='true']", "s2-image");
check("the incoming slide paints its layers while a morph runs", mid !== null, JSON.stringify(mid));
check("and a morph paints no second surface", (await page.locator("[data-present-stage='outgoing']").count()) === 0);
// The regression this guards: a start box that carried the distance between the
// two slides put the layer a slide-width outside the fitted region, so it flew
// in from off screen instead of moving from where the audience last saw it.
check(
  "and it starts ON screen, not outside it",
  mid && mid.left > -10 && mid.left + mid.width < VIEW.width + 10,
  JSON.stringify(mid)
);

await page.waitForTimeout(1200);
const settled = await boxIn("[data-present-stage='true']", "s2-card");
const imageSettled = await boxIn("[data-present-stage='true']", "s2-image");
const alphaSettled = await alphaIn("[data-present-stage='true']", "s2-image");
check(
  "the layer actually travels: where it sits mid-transition is not where it lands",
  mid && settled && (Math.abs(mid.left - settled.left) > 4 || Math.abs(mid.width - settled.width) > 4),
  `mid ${JSON.stringify(mid)} vs settled ${JSON.stringify(settled)}`
);

// And the reshaped pair travels too: an ellipse arriving where a rect stood is
// the case a name-only key exists for, so it is played rather than only listed.
check(
  "a rect that becomes an ellipse travels as one pair",
  imageMid &&
    imageSettled &&
    (Math.abs(imageMid.left - imageSettled.left) > 4 || Math.abs(imageMid.width - imageSettled.width) > 4),
  `mid ${JSON.stringify(imageMid)} vs settled ${JSON.stringify(imageSettled)}`
);

// The third property that travels. The document says 0.55 on the incoming slide
// and 1 on the outgoing one, so a pair that interpolated only the box would show
// 0.55 from the first frame — the shape would arrive already faded.
check(
  "and its alpha travels too, between the two halves' own",
  alphaMid !== null && alphaSettled !== null && alphaMid > 0.6 && alphaMid < 1 && Math.abs(alphaSettled - 0.55) < 0.01,
  `mid ${alphaMid} vs settled ${alphaSettled}`
);

// A second press during a transition is dropped, not queued: a queue turns a
// held arrow key into a deck that keeps advancing after you let go.
await page.evaluate(() => window.__FISH_BRIDGE__.selectElement("s1"));
await page.waitForTimeout(50);
const counterBefore = await page.locator("[data-present-counter]").innerText();
await page.keyboard.press("ArrowLeft");
await page.waitForTimeout(120);
await page.keyboard.press("ArrowLeft");
await page.waitForTimeout(1200);
const counterAfter = await page.locator("[data-present-counter]").innerText();
check(
  "a key pressed mid-transition is swallowed, not queued",
  counterBefore !== counterAfter && /^1 \//.test(counterAfter),
  `${counterBefore} -> ${counterAfter}`
);

await page.keyboard.press("Escape");
await idle();

check("no console errors", errors.length === 0, errors.join("\n      "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
