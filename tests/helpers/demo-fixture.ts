import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { documentFromHtml, serializeSelf } from "../../src/core/data-bridge";

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * The case document used to ship as `dist/examples/demo.fish.html`. It still
 * lives in the source `index.html`; tests that need a realistic document splice
 * it into the built shell, so they exercise the shipped artifact without a
 * separate dist example.
 */
export function demoFixtureHtml(shellHtml: string): string {
  const source = fs
    .readFileSync(path.join(ROOT, "index.html"), "utf8")
    .replaceAll("__FISH_DOC_VERSION__", readJson<{ current: string }>("src/core/dsl/versions.json").current)
    .replaceAll("__FISH_APP_VERSION__", readJson<{ version: string }>("package.json").version);
  const showcase = documentFromHtml(source);
  if (!showcase) throw new Error("index.html carries no readable #design-doc block");
  return serializeSelf(showcase, shellHtml, { title: "FISH — demo" });
}

function readJson<T>(relative: string): T {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8")) as T;
}

export function writeDemoFixture(shellHtml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-demo-"));
  const file = path.join(dir, "demo.fish.html");
  fs.writeFileSync(file, demoFixtureHtml(shellHtml));
  return file;
}
