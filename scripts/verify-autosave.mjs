/**
 * Verifies the auto-save write-back flow in a real browser.
 *
 * The File System Access picker needs a user gesture and a native dialog, so it
 * cannot be driven from a unit test. This injects a stand-in handle instead,
 * which makes the parts that actually matter testable: whether the target file
 * is accepted or refused, and which identity gets stamped into it.
 *
 * Usage: node scripts/verify-autosave.mjs [dist/index.html]
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const target = process.argv[2] ?? "dist/index.html";
const url = "file://" + path.resolve(target);

// The document *this* target holds, re-wrapped so the stand-in handle looks
// exactly like the file the tab was opened from. Taken from the target rather
// than hardcoded: the accept scenario only passes when the picked content
// matches the baseline, which differs between the empty shell and the case
// document.
const ownBlock =
  /<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i.exec(fs.readFileSync(target, "utf-8"))?.[1] ?? "";
const ownShell = `<!DOCTYPE html><html><head>
<script id="design-doc" type="application/json">${ownBlock}</script>
</head><body></body></html>`;

const foreignDoc = `<!DOCTYPE html><html><head>
<script id="design-doc" type="application/json">
{"version":"0.1","id":"other_doc","name":"Completely Different","canvas":{"width":100,"height":100,"unit":"px"},"elements":[{"id":"r1","type":"rect","x":1,"y":1,"width":5,"height":5}]}
</script>
</head><body></body></html>`;

async function scenario(name, fileContent, expect, handleName = path.basename(target)) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.addInitScript(
    ({ html, pickedName }) => {
      window.__wrote = null;
      window.showOpenFilePicker = async () => [
        {
          name: pickedName,
          queryPermission: async () => "granted",
          requestPermission: async () => "granted",
          getFile: async () => ({ text: async () => html }),
          createWritable: async () => ({
            write: async (s) => {
              window.__wrote = s;
            },
            close: async () => undefined
          })
        }
      ];
      window.addEventListener("unhandledrejection", (e) => {
        const r = e.reason;
        console.error("UNHANDLED: " + (r && r.stack ? r.stack : String(r)));
      });
    },
    { html: fileContent, pickedName: handleName }
  );

  await page.goto(url);
  await page.waitForTimeout(2000);
  await page.getByText("Choose file", { exact: true }).click();
  await page.waitForTimeout(1500);

  const got = await page.evaluate(() => {
    const written = window.__wrote ?? "";
    return {
      wrote: written.length > 0,
      stampedId: /name="fish:fileId"\s+content="([^"]+)"/.exec(written)?.[1] ?? null,
      domId: document.querySelector('meta[name="fish:fileId"]')?.getAttribute("content") ?? null,
      rejected: /not the one open in this tab/.test(document.body.innerText),
      promptUp: /Choose file/.test(document.body.innerText)
    };
  });
  await browser.close();

  const checks = expect(got);
  const failed = checks.filter((c) => !c.ok);
  console.log(`${failed.length === 0 ? "PASS" : "FAIL"}  ${name}`);
  for (const c of checks) console.log(`        ${c.ok ? "ok  " : "FAIL"} ${c.label}`);
  for (const e of errors) console.log(`        pageerror: ${e}`);
  return failed.length === 0;
}

const results = [];
results.push(
  await scenario("refuses a file holding a different document", foreignDoc, (got) => [
    { label: "did not write", ok: !got.wrote },
    { label: "showed the mismatch notice", ok: got.rejected },
    { label: "kept the prompt up for a retry", ok: got.promptUp }
  ])
);
results.push(
  await scenario("accepts the file this tab is showing", ownShell, (got) => [
    { label: "wrote to the file", ok: got.wrote },
    { label: "stamped a real id, not the bundle's literal", ok: /^file_[0-9a-z]+_[0-9a-z]+$/.test(got.stampedId ?? "") },
    { label: "adopted the same id into the page", ok: got.stampedId !== null && got.stampedId === got.domId },
    { label: "cleared the prompt", ok: !got.promptUp }
  ])
);
// The asymmetry that made the shell write back to a file the user was not
// looking at: every empty shell hashes alike, so content alone accepted any
// empty file while a content-bearing file could only accept itself.
results.push(
  await scenario(
    "refuses the same document under another name",
    ownShell,
    (got) => [
      { label: "did not write", ok: !got.wrote },
      { label: "showed the mismatch notice", ok: got.rejected },
      { label: "kept the prompt up for a retry", ok: got.promptUp }
    ],
    "some-other-empty.fish.html"
  )
);

console.log(`\n${results.filter(Boolean).length}/${results.length} scenarios passed`);
process.exit(results.every(Boolean) ? 0 : 1);
