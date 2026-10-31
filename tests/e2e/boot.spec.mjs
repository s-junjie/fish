import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";

// THE SHELL STARTS. That is the whole claim, and it is the one thing 113 other
// specs only ever assert by accident: they all fail if the app is dead, but each
// blames the feature it was written for, so a boot crash reads as "assets panel
// is broken" in whichever spec happens to run first.
//
// The failure this exists for: a hook that names a binding it was never given
// (`flash` for `flashSaveStatus`) throws inside `useDocumentJsonActions`, which
// runs before anything renders — `tsc` catches it, but only `verify` runs `tsc`,
// and the fast loop does not. A page that throws there paints nothing and looks
// like a slow load until someone opens devtools.
//
// Uncaught exceptions only. A `file://` page is not a clean room — Chromium
// refuses IndexedDB on this origin, so the auto-save controller reports a startup
// failure by design — which is why a `console.error` is not a verdict here and an
// uncaught throw is.

const html = path.resolve(process.cwd(), process.argv[2] ?? "dist/index.html");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(pathToFileURL(html).href);

// The canvas root is rendered by `CanvasArea`, which sits below every hook in
// `App` — its presence is what makes "the chain ran to the end" a fact rather
// than a hope. A timeout is the crash: dump what was thrown, since that is the
// only sentence a boot failure ever produces.
let mounted = true;
try {
  await page.waitForSelector("[data-canvas-root]", { timeout: 8000 });
} catch {
  mounted = false;
}
check("the app mounts", mounted, errors.join(" | ") || "no element matched [data-canvas-root]");

// The bar is the first thing the user reads and the last thing a late hook can
// take down with it: a document that mounts but renders no name is a blank tab
// with a working canvas.
const name = mounted ? ((await page.textContent("[data-title-bar-name]")) ?? "").trim() : "";
check("the title bar names the document", name.length > 0, `title bar name = ${JSON.stringify(name)}`);

check("nothing threw while starting", errors.length === 0, errors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
