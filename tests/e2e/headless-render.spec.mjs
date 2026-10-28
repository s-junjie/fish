import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

// The loop an external agent runs: hand the engine a candidate document, learn
// what normalize changed, and see what was actually painted.
//
//   1. repairs     — a property the engine does not implement comes back in the
//                    repair list instead of disappearing silently
//   2. flush       — the export must run AFTER the document is painted; running
//                    it first yields a blank page with no error at all
//   3. export      — the returned data URL is a real PNG
const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const pageErrors = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  results.push({ name, ok });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => !!window.__FISH_BRIDGE__ && !!window.__fish);

const candidate = {
  pages: [
    {
      id: "p1",
      name: "Page 1",
      canvas: { width: 800, height: 400 },
      children: [
        {
          id: "hr_bg",
          type: "rect",
          name: "bg",
          x: 0,
          y: 0,
          width: 800,
          height: 400,
          fills: [{ type: "solid", color: "#101828" }]
        },
        {
          id: "hr_text",
          type: "text",
          name: "Headline",
          x: 60,
          y: 120,
          width: 500,
          height: 60,
          content: "Ship the design",
          // `alignSelf` is a spelling the normalizer accepts (`element.ts:91`), so
          // it cannot stand in for a property the engine does not implement.
          glowRadius: 12,
          style: {
            fontFamily: "Inter",
            fontSize: 48,
            fontWeight: 700,
            color: "#F9FAFB"
          }
        }
      ]
    }
  ],
  activePageId: "p1"
};

const out = await page.evaluate(async (doc) => {
  const normalized = window.__fish.normalize(doc);
  window.__FISH_BRIDGE__.applyDoc(normalized.document);
  const beforeFlush = document.querySelectorAll("[data-element-id]").length;
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))
  );
  const afterFlush = document.querySelectorAll("[data-element-id]").length;
  const dataUrl = await window.__fish.exportCanvasPng({ scale: 1 });
  return { repairs: normalized.repairs, beforeFlush, afterFlush, dataUrl };
}, candidate);

const drop = out.repairs.find((r) => r.message.includes("glowRadius"));
check("an unimplemented property comes back as a drop", Boolean(drop), drop?.path ?? "missing");
// The path is a JSON pointer into the candidate, so it locates the offending
// element by index rather than by id.
check(
  "the drop points at the element it landed on",
  Boolean(drop?.path?.includes("/children/1/")),
  drop?.path ?? "missing"
);

check(
  "the document is painted before the export runs",
  out.afterFlush >= 2,
  `${out.beforeFlush} -> ${out.afterFlush} painted elements`
);
check(
  "the export is a PNG data URL",
  typeof out.dataUrl === "string" && out.dataUrl.startsWith("data:image/png"),
  out.dataUrl ? out.dataUrl.slice(0, 22) : "none"
);
check(
  "the export is not a blank canvas",
  typeof out.dataUrl === "string" && out.dataUrl.length > 2000,
  out.dataUrl ? `${out.dataUrl.length} chars` : "none"
);

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
