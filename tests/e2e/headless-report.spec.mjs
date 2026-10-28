import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import nodeFs from "node:fs";

// `?report=1` is the whole of the headless interface: `chrome --headless --dump-dom`
// prints the DOM, and the document puts its answers in there. It is the only channel
// an agent with nothing installed can use, so a key that quietly goes missing has no
// caller to notice it.
//
// Each assertion is a fresh page load with its own query, because that is what the
// command line does — the app reads the query once, on load, and a same-document
// query change would not re-run it.
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const url = pathToFileURL(html).href;
const results = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

// `zoom: 3` is not a key the engine reads, so it is dropped with a repair. The
// repair is computed during load and then discarded, so this is the only place
// anyone who cannot run `normalize` themselves can observe it.
const CANDIDATE = {
  version: "0.1",
  canvas: { width: 600, height: 400 },
  activePageId: "p1",
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: 600, height: 400 },
      children: [
        {
          id: "card",
          type: "frame",
          name: "Card",
          x: 40,
          y: 40,
          width: 300,
          height: 160,
          sizing: { height: "fit-content" },
          display: "flex",
          "flex-direction": "column",
          gap: 16,
          padding: 24,
          fills: [{ type: "solid", color: "#2A2A2A" }],
          children: [
            {
              id: "title",
              type: "text",
              name: "Title",
              zoom: 3,
              content: "Instant Collaboration",
              sizing: { width: "max-content", height: "fit-content" },
              style: { fontFamily: "Inter, sans-serif", fontSize: 20, fontWeight: 700, color: "#FFFFFF" }
            },
            {
              id: "body",
              type: "text",
              name: "Body",
              content: "Edit designs directly on local disk with zero cloud latency.",
              sizing: { width: "fill", height: "fit-content" },
              style: { fontFamily: "Inter, sans-serif", fontSize: 14, fontWeight: 400, color: "#A0A0A0", lineHeight: 1.5 }
            }
      ]
    }
      ]
    }
  ]
};

// A shell hands the document to the engine by writing it into the file, and that is
// the only way the raw block — and therefore the repairs — reaches the report.
const shell = nodeFs.readFileSync(html, "utf-8");
const withDoc = shell.replace(
  /(<script\s+id=["']design-doc["'][^>]*>)[\s\S]*?(<\/script>)/i,
  (_m, open, close) => `${open}\n${JSON.stringify(CANDIDATE, null, 2).replace(/</g, "\\u003c")}\n${close}`
);
const docPath = path.join(path.dirname(html), ".headless-report-fixture.fish.html");
nodeFs.writeFileSync(docPath, withDoc, "utf-8");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

const report = async (query) => {
  await page.goto(`${pathToFileURL(docPath).href}?${query}`);
  await page.waitForSelector("#fish-report", { timeout: 5000 }).catch(() => {});
  return page.evaluate(() => {
    const el = document.getElementById("fish-report");
    return el ? JSON.parse(el.textContent) : null;
  });
};

try {
  const whole = await report("view=canvas&report=1");
  const painted = await page.evaluate(() => ({
    titles: document.querySelectorAll("[data-frame-title]").length
  }));
  const element = await report("view=canvas&report=1&element=card");
  const scaled = await report("view=canvas&report=1&element=card&scale=2");
  const missing = await report("view=canvas&report=1&element=nope");

  check("a bare report describes the document", whole?.ok === true && whole.canvas?.width === 600, JSON.stringify(whole?.canvas));
  check(
    "it carries the repairs normalize made on the way in",
    // The kind is the contract; the message is prose that gets shortened to save
    // bytes (`9a543c1`), so matching on it ages badly.
    Array.isArray(whole?.repairs) &&
      whole.repairs.some((r) => /zoom/.test(r.path ?? "") && r.kind === "dropped-property"),
    JSON.stringify(whole?.repairs)
  );
  check("it carries the validate diagnostics", Array.isArray(whole?.validate), JSON.stringify(whole?.validate));
  check("it carries the dialect it reports on", whole?.version === "0.1", String(whole?.version));
  check(
    "?view=canvas paints the artwork, not the editor's frame names",
    painted.titles === 0,
    `${painted.titles} frame title(s) painted`
  );

  check("a named element is measured", element?.element?.id === "card", JSON.stringify(element?.element));
  check(
    "its box is in canvas coordinates, not parent-local",
    element?.element?.x === 40 && element?.element?.y === 40,
    `${element?.element?.x},${element?.element?.y}`
  );
  check(
    "its box is the laid-out height, not the authored one",
    // `sizing.height: "fit-content"` shrinks the authored 160 to the content, so the
    // proof is that it was recomputed at all — and to a height that matches the
    // children rather than the number that was written down.
    element?.element?.height !== 160 && element?.element?.height > 100,
    `authored 160, reported ${element?.element?.height}`
  );
  check("the window is sized to the element", /^300x\d+$/.test(String(element?.window)), String(element?.window));
  check("an origin is offered for aiming a window at it", /^-?[\d.]+,-?[\d.]+$/.test(String(element?.origin)), String(element?.origin));

  // Scaling the window AND the bitmap is the bug this pair exists to catch: the
  // element lands in a quarter of a frame twice its size, which is a plausible image.
  const [sw, sh] = String(scaled?.window).split("x").map(Number);
  const [ew, eh] = String(scaled?.expected).split("x").map(Number);
  check("a scale does not change the window", sw === 300, String(scaled?.window));
  check("a scale only changes the bitmap", ew === sw * 2 && eh === sh * 2, `${scaled?.window} -> ${scaled?.expected}`);

  check("an unknown id fails instead of falling back to the page", missing?.ok === false && typeof missing?.error === "string", String(missing?.error));
  check("a failure offers no window, so nothing gets photographed by mistake", missing?.window === undefined, String(missing?.window));
  check("no page errors", pageErrors.length === 0, pageErrors.join("; "));
} finally {
  await browser.close();
  nodeFs.rmSync(docPath, { force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length > 0 ? 1 : 0);
