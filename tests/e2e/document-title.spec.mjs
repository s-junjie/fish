import { chromium } from "playwright";
import { pathToFileURL } from "url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The tab title is the one string a `.fish.html` has that names the file itself,
// and it has two readers that cannot be kept apart by a unit test: the tab strip
// the user looks at, and the `<title>` the file carries for the next open. So the
// claims are about the OPENED file, under the name the user gave it.
//
// The copy is not paranoia. The app writes the document back to the file it was
// loaded from, so a spec that renamed the shared `index.html` would be asserting
// against an artifact the runner is also handing to the next spec.

const shell = path.resolve(process.argv[2] ?? "dist/index.html");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-title-"));
const named = path.join(workDir, "my-design.fish.html");
const plain = path.join(workDir, "deck.v2.html");
fs.cpSync(shell, named);
fs.cpSync(shell, plain);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const browser = await chromium.launch();
const errors = [];

async function open(file) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
  await page.waitForTimeout(300);
  return page;
}

const page = await open(named);
const live = await page.evaluate(() => document.title);
check("an opened file titles its tab after itself", live === "my-design — FISH", `document.title = ${JSON.stringify(live)}`);
check("the shipped shell title is not what the tab shows", !live.includes("Figma In a Single Html"), live);

// The title bar and the tab strip are the same claim about the same file; when
// they disagree, the user has two answers to "which file am I in". The bar keeps
// the extension it was always given — only the tab, which has a tab strip's width
// to live in, drops it.
const barName = (await page.textContent("[data-title-bar-name]"))?.trim();
check("the title bar and the tab name the same file", barName === "my-design.fish.html", `title bar = ${JSON.stringify(barName)}`);

// A document name is not a file name: only the extension is stripped, and only
// from an html file. A version suffix is part of the name the user chose.
const plainTitle = await (await open(plain)).evaluate(() => document.title);
check("a plain .html keeps its dotted name", plainTitle === "deck.v2 — FISH", `document.title = ${JSON.stringify(plainTitle)}`);

// Every edit re-derives the title off the history channel; a title rewritten on
// each one makes the tab strip flicker for no reason.
await page.waitForTimeout(400);
const afterIdle = await page.evaluate(() => document.title);
check("the title does not churn while the document sits idle", afterIdle === live, afterIdle);

check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
fs.rmSync(workDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);