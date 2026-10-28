#!/usr/bin/env node
// Rehearse the whole update path without a published release address.
//
// FISH has no release endpoint yet, so the shipped build cannot check anything —
// which is the correct state, and also the one state in which the update path is
// never exercised. This builds a THROWAWAY release around the current source and
// drives it in a real browser, so the part that unit tests cannot reach (DOMParser
// on a downloaded shell, the DOM re-serialisation, the badge, the apply row) is
// measured rather than argued about.
//
//   npm run update:verify
//
// What it does, in order:
//   1. mints a P-256 keypair in the OS temp dir (never in the repo)
//   2. builds with FISH_UPDATE_MANIFEST_URL / FISH_UPDATE_PUBLIC_KEY pointed at a
//      local server, and a manifest claiming a version ONE STEP NEWER than this
//      build — signed with the matching private key
//   3. drives it: the badge appears, the panel names the version, "Update this
//      file…" produces a file that is a shell AND carries the seeded document
//   4. rebuilds WITHOUT the defines, so `dist/` is left in its shipped state
//
// It never touches your working tree beyond `dist/`, and step 4 runs even when a
// check fails.

import { chromium } from "playwright";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = Number(process.env.UPDATE_VERIFY_PORT || 8791);
const SHELL = path.resolve(process.cwd(), "dist/index.html");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  // Detail is for failures. Printed on a pass it is noise that reads like output.
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
};
const same = (name, actual, expected) =>
  check(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

const work = mkdtempSync(path.join(tmpdir(), "fish-update-verify-"));
const build = (env) =>
  execFileSync("npm", ["run", "build"], { stdio: "pipe", env: { ...process.env, ...env } });

let server;
try {
  const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateJwk = pair.privateKey.export({ format: "jwk" });
  const publicKey = JSON.stringify(pair.publicKey.export({ format: "jwk" }));

  console.log(`building a throwaway release around v${pkg.version}…`);
  build({
    FISH_UPDATE_MANIFEST_URL: `http://127.0.0.1:${PORT}/manifest.json`,
    FISH_UPDATE_PUBLIC_KEY: publicKey
  });

  const shell = readFileSync(SHELL);
  // One segment above this build, so the check has something real to find. The
  // app version is hand-set (AGENTS.md §10), which is exactly why a rehearsal
  // has to manufacture the difference rather than wait for a release.
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  const newer = `${major}.${minor}.${patch + 1}`;
  const payload = JSON.stringify(
    {
      app: "fish",
      version: newer,
      url: `http://127.0.0.1:${PORT}/index.html`,
      sha256: createHash("sha256").update(shell).digest("hex")
    },
    null,
    2
  );
  const signature = sign("sha256", Buffer.from(payload, "utf8"), {
    key: createPrivateKey({ key: privateJwk, format: "jwk" }),
    dsaEncoding: "ieee-p1363"
  }).toString("base64");

  const files = {
    "/index.html": ["text/html; charset=utf-8", shell],
    // `sig`, because that is the field `verifyEnvelope` reads.
    "/manifest.json": ["application/json", Buffer.from(JSON.stringify({ payload, sig: signature }))]
  };
  server = createServer((req, res) => {
    const hit = files[req.url.split("?")[0]];
    if (!hit) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": hit[0] });
    res.end(hit[1]);
  });
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.waitForFunction(() => !!window.__FISH_BRIDGE__);
  await page.evaluate(() => {
    const bridge = window.__FISH_BRIDGE__;
    bridge.applyDoc({ ...bridge.getDoc(), name: "Update Verify Document" });
  });

  const badged = await page
    .waitForSelector("[data-update-badge]", { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check("the launch check found the release and badged the entry", badged);
  if (!badged) {
    // Name the reason rather than "it did not work": the panel states which of
    // the four refusals it was, and that is the whole diagnosis.
    await page.evaluate(() => document.querySelector("[data-update-button]").click());
    await page.waitForTimeout(400);
    const said = await page.evaluate(
      () => document.querySelector("[data-update-status]")?.textContent?.trim() ?? "(no panel)"
    );
    throw new Error(`the panel says: ${said}${errors.length ? ` | ${errors.join(" | ")}` : ""}`);
  }

  await page.evaluate(() => document.querySelector("[data-update-button]").click());
  await page.waitForSelector("[data-update-apply]");
  same("the panel names the newer version", (await page.textContent("[data-update-status]")).trim(),
    `Version ${newer} is available.`);
  check(
    "the apply row admits it has to ask where to save",
    /Update this file…/.test(await page.textContent("[data-update-apply]"))
  );

  // The picker needs a real user gesture, so the copy path is what a probe can
  // reach. It runs the same `buildUpdatedFile` the in-place write would.
  await page.evaluate(() => {
    delete window.showSaveFilePicker;
  });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate(() => document.querySelector("[data-update-apply]").click())
  ]);
  const saved = path.join(work, "saved.html");
  await download.saveAs(saved);
  const written = readFileSync(saved, "utf8");

  check("the written file is a shell", written.includes('id="fish-rt"'));
  check("it carries the document across untouched", written.includes("Update Verify Document"));
  same("one document block, not two", written.match(/id="design-doc"/g).length, 1);
  check(
    "it says honestly that this tab is still the old runtime",
    /keeps running/.test(await page.textContent("[data-update-status]"))
  );
  check("no console errors", errors.length === 0, errors.join("\n      "));
  await browser.close();
} catch (e) {
  check(`rehearsal ran to the end (${e instanceof Error ? e.message : String(e)})`, false);
} finally {
  server?.close();
  rmSync(work, { recursive: true, force: true });
  // `dist/` must not be left pointing at a dead local server with a throwaway
  // key baked into it — that is the one way this script could do real damage.
  console.log("\nrebuilding dist/ in its shipped (unconfigured) state…");
  build({ FISH_UPDATE_MANIFEST_URL: "", FISH_UPDATE_PUBLIC_KEY: "" });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);