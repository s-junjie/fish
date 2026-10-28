/**
 * `fish import` — a web page into an editable document.
 *
 * The importer measures a rendered page rather than parsing its CSS, so the
 * markup is mounted in a real browser and the DSL is written from what the
 * browser laid out. That is why this needs a browser at all, and why the CLI
 * must not grow a second opinion about what `display: grid` means — the harness
 * runs `importHtmlDocument` where it was written to run.
 *
 * The result is an ordinary `.fish.html`: editable, and the source from here on.
 * The page is a seed, not a round-trip — re-importing after edits would discard
 * them, and there is no command that does.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { findBrowser, getChromeFlags, runBrowserForReport } from "./browser";
import { normalizeDesignDocument } from "../dsl/normalize";
import { compactDocumentJson, documentJson } from "../document-json";
import { injectDocumentBlock } from "./doc-source";
import { LATEST_DOCUMENT_VERSION } from "../dsl/version";
import { DEFAULT_VIEWPORT_HEIGHT, DEFAULT_VIEWPORT_WIDTH } from "../import/html-types";
import type { DesignDocument } from "../dsl/types";
import type { HarnessResult } from "./html-harness";

const HARNESS_FILE = "html-harness.js";
const HARNESS_TIMEOUT_MS = 120_000;

export interface ImportOptions {
  out?: string;
  template?: string;
  viewport?: number;
  viewportHeight?: number;
  name?: string;
  compact?: boolean;
  json?: boolean;
}

function findHarness(): string | null {
  const here = process.argv[1] ? path.dirname(process.argv[1]) : "";
  const candidates = [
    process.env.FISH_HTML_HARNESS,
    here && path.join(here, HARNESS_FILE),
    path.join(process.cwd(), HARNESS_FILE)
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/**
 * Served over HTTP rather than opened as `file://` so the report POST is
 * same-origin — the same reason `image-embed.ts` does it.
 */
function harnessPage(source: string, html: string, width: number, height: number, name: string): string {
  const inline = source.replace(/<\/(script)/gi, "<\\/$1");
  return `<!doctype html><meta charset="utf-8"><body>
<script>${inline}</script>
<script>
const report = (payload) =>
  fetch("/report", { method: "POST", body: JSON.stringify(payload) }).catch(() => {});
window.addEventListener("error", (e) => report({ ok: false, error: String(e.message) }));
(async () => {
  try {
    const r = await window.fishImportPage(
      ${JSON.stringify(html)},
      ${JSON.stringify(width)},
      ${JSON.stringify(height)},
      ${JSON.stringify(name)}
    );
    await report(Object.assign({ ok: true }, r));
  } catch (err) {
    await report({ ok: false, error: (err && err.message) || String(err) });
  }
})();
</script>
`;
}

interface ReportServer {
  port: number;
  report: Promise<string>;
  close: () => void;
}

function startReportServer(page: string): Promise<ReportServer> {
  return new Promise((resolve, reject) => {
    let settle: (body: string) => void = () => {};
    const report = new Promise<string>((res) => {
      settle = res;
    });
    const server = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(204).end();
        settle(Buffer.concat(chunks).toString("utf8"));
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as AddressInfo).port, report, close: () => server.close() });
    });
  });
}

async function runImport(html: string, opts: ImportOptions): Promise<HarnessResult> {
  const browser = findBrowser();
  if (!browser) {
    throw new Error(
      "No Chrome / Chromium / Edge found on this machine, and the import measures a real layout, " +
        "which needs one. Set FISH_BROWSER or install a browser."
    );
  }
  const harness = findHarness();
  if (!harness) {
    throw new Error(`${HARNESS_FILE} is missing beside the CLI — rebuild the kit with \`npm run build\``);
  }

  const width = opts.viewport && opts.viewport > 0 ? opts.viewport : DEFAULT_VIEWPORT_WIDTH;
  const height = opts.viewportHeight && opts.viewportHeight > 0 ? opts.viewportHeight : DEFAULT_VIEWPORT_HEIGHT;
  const page = harnessPage(fs.readFileSync(harness, "utf8"), html, width, height, opts.name ?? "Imported Page");
  const server = await startReportServer(page);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-import-"));

  try {
    const body = await runBrowserForReport(
      browser,
      [...getChromeFlags(tmpDir), `http://127.0.0.1:${server.port}/`],
      server.report,
      { step: "html import", timeoutMs: HARNESS_TIMEOUT_MS }
    );
    let parsed: { ok: boolean; error?: string } & Partial<HarnessResult>;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("the harness reported something that is not JSON");
    }
    if (!parsed.ok) throw new Error(parsed.error || "the import produced no document");
    if (!Array.isArray(parsed.elements)) throw new Error("the import produced no elements");
    return parsed as HarnessResult;
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** The page's own width, and as tall as the frame the import produced. */
function canvasOf(root: { width?: unknown; height?: unknown } | undefined, width: number, height: number) {
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  return {
    width: num(root?.width, width),
    height: num(root?.height, height),
    background: { type: "solid" as const, color: "#FFFFFF" }
  };
}

function resolveTemplatePath(templateFile: string): string | null {
  if (fs.existsSync(templateFile)) return templateFile;
  const candidates = [
    path.join("templates", templateFile),
    path.join(path.dirname(process.argv[1]), "templates", path.basename(templateFile)),
    path.join(path.dirname(process.argv[1]), "templates", "blank.fish.html"),
    path.join("templates", "blank.fish.html"),
    path.join(path.dirname(process.argv[1]), "blank.fish.html"),
    path.join("blank.fish.html")
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

export async function importHtmlPage(htmlFile: string, opts: ImportOptions): Promise<number> {
  if (!fs.existsSync(htmlFile)) {
    console.error(`no such file: ${htmlFile}`);
    return 2;
  }
  const html = fs.readFileSync(htmlFile, "utf8");
  if (!html.trim()) {
    console.error(`${htmlFile} is empty`);
    return 2;
  }

  let result: HarnessResult;
  try {
    result = await runImport(html, opts);
  } catch (err) {
    console.error(`import failed — ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  const width = opts.viewport && opts.viewport > 0 ? opts.viewport : DEFAULT_VIEWPORT_WIDTH;
  const height = opts.viewportHeight && opts.viewportHeight > 0 ? opts.viewportHeight : DEFAULT_VIEWPORT_HEIGHT;
  const root = result.elements[0] as unknown as { width?: number; height?: number } | undefined;
  const canvas = canvasOf(root, width, height);
  const name = opts.name ?? path.basename(htmlFile, path.extname(htmlFile));

  const doc = {
    version: LATEST_DOCUMENT_VERSION,
    name,
    canvas,
    pages: [{ id: "page-1", name, canvas, children: result.elements }],
    activePageId: "page-1",
    ...(result.assets && result.assets.length > 0 ? { assets: result.assets } : {}),
    ...(result.tokens?.tokens?.length ? { tokens: result.tokens.tokens } : {}),
    ...(result.tokens?.styles?.length ? { styles: result.tokens.styles } : {}),
    ...(result.tokens?.modes?.length ? { modes: result.tokens.modes } : {}),
    ...(result.tokens?.numberModes?.length ? { numberModes: result.tokens.numberModes } : {})
  };

  // Normalized for the same reason `compose` is: the file on disk has to be the
  // dialect the engine reads back, not whatever the importer happened to emit.
  const canonical = normalizeDesignDocument(doc as unknown as DesignDocument).document;
  const serialized = opts.compact ? compactDocumentJson(canonical) : documentJson(canonical);
  const jsonStr = serialized.replace(/<\//g, "\\u003c/");

  const template = resolveTemplatePath(opts.template ?? "blank.fish.html");
  if (!template) {
    console.error("no template found — pass --template <blank.fish.html>");
    return 2;
  }
  const templateContent = fs.readFileSync(template, "utf8");
  const target = opts.out ?? `${name}.fish.html`;
  const assembled = injectDocumentBlock(templateContent, jsonStr);
  fs.writeFileSync(target, assembled);

  const r = result.report;
  if (opts.json) {
    console.log(JSON.stringify({ out: target, report: r, missing: result.missing }, null, 2));
    return 0;
  }
  console.log(`imported ${htmlFile} into ${target} (${assembled.length} bytes)`);
  console.log(`  elements       ${r.elementCount}`);
  console.log(`  maxDelta       ${r.maxDelta}px (text ${r.maxTextDelta}px)`);
  console.log(`  downgraded     ${r.downgraded.length}`);
  console.log(`  unmapped       ${r.unmapped.length}`);
  console.log(`  assets         ${result.assets.length} inlined, ${result.missing.length} missing`);
  console.log(`  tokens         ${r.tokensCreated} created, ${r.tokenBindings} bound`);
  if (r.downgraded.length > 0) {
    console.log("  layouts the engine could not reproduce (baked to measured coordinates):");
    for (const d of r.downgraded.slice(0, 10)) console.log(`    ${d.id} ${d.name} — ${d.maxDelta}px`);
  }
  if (r.unmapped.length > 0) {
    console.log("  what the dialect has no field for:");
    for (const u of r.unmapped.slice(0, 10)) console.log(`    ${u.path} — ${u.property}: ${u.value}`);
  }
  if (result.missing.length > 0) {
    console.log("  images referenced but not fetched (supply with `fish assets import --to`):");
    for (const m of result.missing.slice(0, 10)) console.log(`    ${m.elementId} — ${m.url}`);
  }
  return 0;
}
