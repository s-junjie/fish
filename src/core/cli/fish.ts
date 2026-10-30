/**
 * `fish` — the CLI half of the agent kit.
 *
 * `check` exists because every other answer the engine gives comes back through
 * a browser: a document had to be rendered before anyone could say whether the
 * engine had quietly rewritten it. Normalize and validate are pure, so they run
 * here with no browser at all, which makes "did I break it" a one-line question
 * instead of a screenshot round-trip — and gives CI an exit code.
 *
 * Bundled by `scripts/build-fish-agent-kit.mjs` into a single dependency-free file.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { findBrowser, getChromeFlags, runBrowser } from "./browser";
import { normalizeDesignDocument } from "../dsl/normalize";
import { syncDocumentBindings } from "../interactions/style-ops";
import { parseLenientJson } from "../dsl/lenient-json";
import { applyOps } from "../ops/apply-ops";
import { validateDocument } from "../validate";
import { geometryReport } from "../geometry-report";
import { compactDocumentJson, documentJson } from "../document-json";
import { assetsCommand, compactCommand, embedLocalDocumentAssets } from "./fish-assets";
import { importHtmlPage } from "./html-import";
import { readSource, DOC_BLOCK_RE, injectDocumentBlock } from "./doc-source";
import type { Source } from "./doc-source";
import { brief } from "./fish-brief";
import { checkVerdict } from "../check-verdict";
import { fontDiagnostics } from "../font-diagnostics";
import { countElements } from "../geometry/tree-ops";
import type { DesignDocument, DesignElement } from "../dsl/types";
import { auditToleranceOf, screenshotPlan } from "../export-request";
import { commentsCommand } from "./fish-comments";
import { APP_VERSION } from "../version";

const USAGE = `fish — the FISH agent CLI (nothing to install)

  ./fish --version
  ./fish check <doc.fish.html | doc.json> [--json] [--strict] [--geometry] [--audit] [--audit-tolerance N] [--strict-assets]
  ./fish brief <doc.fish.html | doc.json> [--json]
  ./fish compact <doc.fish.html | doc.json> [-o|--out FILE]
  ./fish assets <doc.fish.html | doc.json> [--json]
  ./fish assets search <query> [--source openverse|lucide|ri] [--limit N] [--add-to <doc>] [--pick N] [--embed] [--to <elementId>] [--replace] [--json]
  ./fish assets import <file...> <doc.fish.html> [--name N] [--to <elementId>] [--replace] [--json]
  ./fish assets embed <doc.fish.html> (--id <assetId> | --all) [--json]
  ./fish apply <ops.json | '[{"op":"patch",...}]'> <doc.fish.html> [-o|--out FILE] [--compact] [--json]
  ./fish comments list|pending <doc.fish.html>
  ./fish comments context <doc.fish.html> <threadId>
  ./fish comments suggest <doc.fish.html> <threadId> --summary <text> --ops <ops.json|'[...]'>
  ./fish comments reply <doc.fish.html> <threadId> --text <text>
  ./fish comments resolve <doc.fish.html> <threadId> [--reply <text>]
  ./fish import <page.html> [-o|--out FILE] [--viewport N] [--viewport-height N] [--name N] [--template FILE] [--compact] [--json]
  ./fish compose <design.json | -> <template.fish.html> [-o|--out FILE] [--compact]
  ./fish export <doc.fish.html> [-o|--out FILE] [--scale N] [--element ID]

check    normalize + validate the document block and print what the engine would change.
brief    report the tokens, styles, components, assets and fonts the document already carries.
compact  emit the canonical compact JSON of a document, assets preserved.
assets   inspect doc.assets[] with the size each one costs; search, import or embed.
apply    run the macro-ops of the authoring guide against the document block, in place.
compose  inject a design.json into the shell without regex pitfalls or string corruption.
import   measure a page in a real browser and emit an editable document.
export   render a PNG of a document through a headless browser (PNG only).

Exit codes: 0 clean, 1 an error diagnostic or a failed op, 2 bad usage.

What a report means, and which check to run when: references/workflow.md.
What each flag's diagnostics are: references/dsl.md.
This text is the syntax, not the judgement.
`;

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/**
 * A remote asset is the one thing in `doc.assets` that can make a delivered file
 * wrong rather than merely large. A `.fish.html` is meant to be self-contained, so
 * a link to someone else's server paints an empty box the moment the file is
 * opened offline, on a network that blocks the host, or after the host retires
 * the path — and nothing about the document says so.
 *
 * Size is deliberately not reported here. A document carrying four 4096px
 * photographs is a normal document, and a guardrail that fires on normal
 * documents is one nobody reads.
 *
 * Info by default and a verdict only under `--strict-assets`: storing a URL is a
 * legitimate state, because the workbench's own URL insert produces it and
 * embedding is a choice the author makes afterwards.
 */
function assetDiagnostics(
  doc: DesignDocument,
  strict: boolean
): { level: "info" | "error"; message: string; elementId?: string }[] {
  const assets = doc.assets ?? [];
  const remote = assets.filter((a) => a.uri && !a.uri.startsWith("data:"));
  if (remote.length === 0) return [];
  return [
    {
      level: strict ? "error" : "info",
      message:
        `${remote.length} of ${assets.length} asset(s) are remote URLs (${remote.map((a) => a.id).join(", ")}) — ` +
        "the file will not render them offline. Embed them with `fish assets embed <doc> --all`"
    }
  ];
}

/**
 * The picture, measured: open the document in a browser and ask where the glyphs
 * actually landed.
 *
 * This is the only check here that cannot be answered from the document, and it
 * exists because the document can be entirely correct while the page is wrong.
 * `?report=1&audit=1` makes the shell measure its own text boxes and publish the
 * result into `#fish-report`, which `--dump-dom` collects — the same channel
 * `export` uses to find out how large a window to ask for.
 *
 * Every way this can fail returns a sentence rather than nothing. A missing
 * audit section means the shell was built before this existed, and reporting that
 * as "0 findings" would be a clean bill of health for a page nobody measured.
 */
type InkAudit = {
  findings: Array<{ level: "error" | "warning"; elementId: string; rule: string; message: string }>;
  checked: number;
  skipped: Array<{ elementId: string; reason: string }>;
  zoom: number;
  /** Screen px the shell actually graded at, echoed back so a summary can say it. */
  tolerance?: { x: number; y: number };
  fontsReady?: boolean;
};

function auditInk(src: Source, tolerance?: number): InkAudit | string {
  if (!src.html) {
    return "a bare .json has no shell for a browser to open — compose it into a .fish.html first";
  }
  const browser = findBrowser();
  if (!browser) {
    return "no Chrome / Chromium / Edge found on this machine; set FISH_BROWSER or install one";
  }

  const abs = path.resolve(src.file);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-audit-"));
  try {
    // A generous virtual-time budget: the page waits for `document.fonts.ready`
    // before it measures, because a fallback face moves every glyph and turns a
    // 1px rule into noise.
    const dom = runBrowser(
      browser,
      [
        ...getChromeFlags(tmpDir),
        "--virtual-time-budget=10000",
        "--window-size=1440,900",
        "--dump-dom",
        `file://${abs}?view=canvas&report=1&audit=1${tolerance !== undefined ? `&auditTolerance=${tolerance}` : ""}`
      ],
      { step: "text ink audit", maxBuffer: 20 * 1024 * 1024 }
    );

    const match = /<script\s+id=["']fish-report["'][^>]*>([\s\S]*?)<\/script>/i.exec(dom);
    if (!match) return "the page published no report — this shell has no ?report channel";

    let report: Record<string, unknown>;
    try {
      report = JSON.parse(match[1]);
    } catch (err) {
      return `the page's report is not valid JSON — ${err instanceof Error ? err.message : String(err)}`;
    }
    if (report.ok === false) return `the page refused to render — ${report.error ?? "no reason given"}`;
    if (!report.audit) return "this shell predates the ink audit — rebuild the document from this kit's blank.fish.html";

    const audit = report.audit as Partial<InkAudit> & { error?: string };
    if (audit.error) return audit.error;
    return {
      findings: audit.findings ?? [],
      checked: audit.checked ?? 0,
      skipped: audit.skipped ?? [],
      zoom: audit.zoom ?? 1,
      tolerance: audit.tolerance,
      fontsReady: audit.fontsReady
    };
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

function check(
  file: string,
  opts: {
    json: boolean;
    strict: boolean;
    geometry: boolean;
    strictAssets: boolean;
    audit: boolean;
    auditTolerance?: number;
  }
): number {
  const src = readSource(file);
  if (typeof src === "string") {
    console.error(src);
    return 2;
  }

  let value: unknown;
  try {
    value = parseLenientJson(src.text.trim() || "{}");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, file: src.file, parseError: message }, null, 2));
    } else {
      console.error(`${src.file}: the #design-doc block is not valid JSON — ${message}`);
    }
    return 1;
  }

  // Materialised before it is graded: a text that names a text style and carries
  // no `style` is a text the canvas paints at the default 24px, and `validate`
  // has to see the size the renderer will use, not the one the author omitted.
  const { document: normalized, repairs } = normalizeDesignDocument(value);
  const document = syncDocumentBindings(normalized);
  const diagnostics = validateDocument(document);
  // Opt-in, and measurements rather than verdicts: overlap is a design technique,
  // so this reports what landed outside the box that was meant to hold it, with
  // the number and the way to say "I meant that". Only a collapsed container is
  // a warning — there the author wrote paint that cannot be painted.
  const geometry = opts.geometry ? geometryReport(document) : [];
  const assetFindings = assetDiagnostics(document, opts.strictAssets);
  // Beside the asset note rather than inside `validate`: a family the file does
  // not carry travels badly, it is not wrong.
  const fontFindings = fontDiagnostics(document, opts.strictAssets);
  // The one check that needs the picture rather than the document. Everything
  // above can be satisfied by a page whose labels are pinned to the left edge of
  // their boxes, because nothing in the document is wrong — only the rendering.
  const ink = opts.audit ? auditInk(src, opts.auditTolerance) : null;
  const inkFindings = ink && typeof ink !== "string" ? ink.findings : [];
  const all = [...diagnostics, ...geometry, ...assetFindings, ...fontFindings, ...inkFindings];
  const errors = all.filter((d) => d.level === "error");
  const warnings = all.filter((d) => d.level === "warning");
  // `checkVerdict` owns the rule that only a "lossy" repair fails: an `info`
  // repair merely records a default the engine supplied or a value it relocated,
  // so a document that omits `canvas` is not a document that lost anything.
  const { ok, lossy, failReason } = checkVerdict(repairs, errors.length, warnings.length, opts.strict);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok,
          file: src.file,
          version: document.version,
          canvas: document.canvas,
          elements: countElements(document),
          repairs,
          lossyRepairs: lossy,
          diagnostics,
          ...(opts.geometry ? { geometry } : {}),
          ...(opts.audit ? { ink: typeof ink === "string" ? { ok: false, error: ink } : { ok: true, ...ink } } : {}),
          ...(assetFindings.length > 0 ? { assetFindings } : {}),
          ...(fontFindings.length > 0 ? { fontFindings } : {})
        },
        null,
        2
      )
    );
    return ok ? 0 : 1;
  }

  const canvas = document.canvas;
  console.log(
    `${src.file}\n  v${document.version} · canvas ${canvas?.width}×${canvas?.height} · ${countElements(document)} elements`
  );
  console.log(`  repairs: ${repairs.length}${lossy !== repairs.length ? ` (${lossy} lossy)` : ""}`);
  for (const r of repairs) console.log(`    [${r.kind}]${r.severity === "info" ? " (info)" : ""} ${r.path} — ${r.message}`);
  console.log(`  diagnostics: ${errors.length} error(s), ${warnings.length} warning(s)`);
  for (const d of all) {
    console.log(`    [${d.level}]${d.elementId ? ` ${d.elementId}:` : ""} ${d.message}`);
  }
  if (opts.geometry) {
    console.log(
      geometry.length === 0
        ? "  geometry: nothing outside its box, nothing left empty (--geometry)"
        : `  geometry: ${geometry.length} measurement(s) — these are numbers, not verdicts (--geometry)`
    );
  }
  if (opts.audit) {
    console.log(inkSummary(ink));
  }
  console.log(ok ? "  ok" : `  FAIL${failReason}`);
  return ok ? 0 : 1;
}

/**
 * What the picture says, in one block.
 *
 * An audit that could not run is printed as a failure of the CHECK, not as a
 * clean bill: "0 findings" and "the browser never answered" look identical in a
 * summary line, and the second one is the state an agent would happily ship from.
 */
function inkSummary(ink: InkAudit | string | null): string {
  if (typeof ink === "string") return `  ink audit: NOT RUN — ${ink}`;
  if (!ink) return "  ink audit: NOT RUN";
  const skipped = ink.skipped.length === 0 ? "" : ` (${ink.skipped.length} skipped)`;
  // The tolerance is screen px after the zoom scaling, so it is stated: a grade
  // of "0 findings" at ±8px is not the same claim as one at ±1px.
  const grade = ink.tolerance ? ` ±${Math.round(ink.tolerance.x * 10) / 10}px` : "";
  const lines = [
    `  ink audit: ${ink.checked} text box(es) measured at ${ink.zoom}×${grade} — ${ink.findings.length} finding(s)${skipped}`
  ];
  if (ink.fontsReady === false) {
    lines.push("    [note] the webfonts did not settle before measuring — vertical findings may be font-loading noise");
  }
  for (const s of ink.skipped) lines.push(`    [skipped] ${s.elementId}: ${s.reason}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function apply(opsArg: string, file: string, opts: { json: boolean; out?: string; compact?: boolean }): number {
  const src = readSource(file);
  if (typeof src === "string") {
    console.error(src);
    return 2;
  }

  let doc: unknown;
  try {
    doc = parseLenientJson(src.text.trim() || "{}");
  } catch (err) {
    console.error(`${src.file}: the #design-doc block is not valid JSON — ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  let ops: unknown;
  try {
    ops = parseLenientJson(opsArg.trim().startsWith("[") || opsArg.trim().startsWith("{") ? opsArg : fs.readFileSync(opsArg, "utf8"));
  } catch (err) {
    console.error(`ops: not valid JSON — ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  // `#design-doc` is the CSS-spelled dialect: `x: "320px"`, `overflow` instead
  // of `clipContent`. Every op below does arithmetic on these fields, so the
  // document is read once here exactly as the app reads it on load.
  const normalized = normalizeDesignDocument(doc).document;
  const result = applyOps(normalized, ops);
  const serialized = opts.compact ? compactDocumentJson(result.doc) : documentJson(result.doc);
  const json = serialized.replace(/<\//g, "\\u003c/");
  const target = opts.out ?? src.file;
  const next = src.html
    ? src.source.replace(DOC_BLOCK_RE, (_m, _body: string) => `<script id="design-doc" type="application/json">\n${json}\n  </script>`)
    : json;
  fs.writeFileSync(target, next);

  const failed = result.outcomes.filter((o) => !o.ok);
  if (opts.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, file: target, outcomes: result.outcomes }, null, 2));
  } else {
    console.log(`${target}`);
    for (const o of result.outcomes) {
      console.log(`  ${o.ok ? "ok  " : "FAIL"} ${o.op}${o.id ? ` ${o.id}` : ""} — ${o.detail}`);
    }
  }
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------

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
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function compose(jsonFile: string, templateFile: string, opts: { out?: string; compact?: boolean }): Promise<number> {
  let raw: string;
  if (jsonFile === "-") {
    try {
      raw = fs.readFileSync(0, "utf8");
    } catch (err) {
      console.error(`stdin: failed to read — ${err instanceof Error ? err.message : err}`);
      return 1;
    }
  } else {
    if (!fs.existsSync(jsonFile)) {
      console.error(`no such file: ${jsonFile}`);
      return 2;
    }
    raw = fs.readFileSync(jsonFile, "utf8");
  }

  const resolvedTemplate = resolveTemplatePath(templateFile);
  if (!resolvedTemplate) {
    console.error(`no such file: ${templateFile}`);
    return 2;
  }

  let doc: unknown;
  try {
    doc = parseLenientJson(raw);
  } catch (err) {
    console.error(`${jsonFile}: not valid JSON — ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  const templateContent = fs.readFileSync(resolvedTemplate, "utf8");
  if (!DOC_BLOCK_RE.test(templateContent)) {
    console.error(`${resolvedTemplate}: no #design-doc block found in template`);
    return 2;
  }

  const baseDir = jsonFile === "-" ? process.cwd() : path.dirname(path.resolve(jsonFile));
  const embedded = await embedLocalDocumentAssets(doc, baseDir);
  if (embedded.error) {
    console.error(embedded.error);
    return 2;
  }

  // Both branches go through the same generator: the pretty one used to
  // re-print the file it had just parsed, so a document that needed normalizing
  // was written back un-normalized — a different dialect on disk than the
  // clipboard would have produced.
  const canonical = normalizeDesignDocument(doc).document;
  const serialized = opts.compact ? compactDocumentJson(canonical) : documentJson(canonical);
  const jsonStr = serialized.replace(/<\//g, "\\u003c/");
  const target = opts.out ?? resolvedTemplate;
  const assembled = injectDocumentBlock(templateContent, jsonStr);

  fs.writeFileSync(target, assembled);
  const note = embedded.count > 0 ? `, embedded ${embedded.count} local asset(s)` : "";
  console.log(`composed ${jsonFile} into ${target} (${assembled.length} bytes${note})`);
  return 0;
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------


function exportDocument(
  file: string,
  opts: { out?: string; format?: string; scale?: number; element?: string }
): number {
  if (!fs.existsSync(file)) {
    console.error(`no such file: ${file}`);
    return 2;
  }

  const browser = findBrowser();
  if (!browser) {
    console.error(
      "No Chrome / Chromium / Edge found on this machine. Set FISH_BROWSER or ensure a browser is installed."
    );
    return 2;
  }

  const scale = opts.scale && Number.isFinite(opts.scale) && opts.scale > 0 ? opts.scale : 1;
  const targetOut = opts.out;

  if (opts.format && opts.format.toLowerCase() !== "png") {
    console.error(`export writes PNG only — unsupported format "${opts.format}"`);
    return 2;
  }
  if (targetOut && !targetOut.toLowerCase().endsWith(".png")) {
    console.error(`export writes PNG only — ${targetOut} is not a .png path`);
    return 2;
  }

  const absDoc = path.resolve(file);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-export-"));

  try {
    const chromeFlags = getChromeFlags(tmpDir);

    const finalOut = targetOut || `${path.basename(file, path.extname(file))}.png`;
    let windowSize = "1440x900";
    let expectedSize = "";
    let originParam = "";

    // Step 1: ask the page where to point the window, and refuse to guess if it says no.
    //
    // The page is the only party that knows an element's box, so a report it marked
    // `ok: false` is a verdict, not a hint: continuing would photograph the whole
    // 1440×900 page and print "exported PNG" — a plausible image of the wrong region,
    // which is the one outcome worse than a failure. A missing report is a different
    // case (a shell predating the channel), so it warns rather than fails.
    let query = `view=canvas&report=1&scale=${scale}`;
    if (opts.element) query += `&element=${encodeURIComponent(opts.element)}`;

    const domOutput = runBrowser(
      browser,
      [
        ...chromeFlags,
        "--virtual-time-budget=2000",
        "--window-size=1440,900",
        "--dump-dom",
        `file://${absDoc}?${query}`
      ],
      { step: "geometry report", maxBuffer: 20 * 1024 * 1024 }
    );

    const reportMatch = /<script\s+id=["']fish-report["'][^>]*>([\s\S]*?)<\/script>/i.exec(domOutput);
    let reportError: string | null = null;
    if (reportMatch) {
      try {
        const report = JSON.parse(reportMatch[1]);
        if (report.ok) {
          if (report.window) windowSize = report.window;
          if (typeof report.expected === "string") expectedSize = report.expected;
          if (report.origin) originParam = `&origin=${report.origin}`;
        } else {
          reportError = report.error || "the page reported the document as unrenderable";
        }
      } catch (err) {
        reportError = `the page's report is not valid JSON — ${err instanceof Error ? err.message : err}`;
      }
    }

    if (opts.element && !reportMatch) {
      console.error(
        `${file}: this shell publishes no ?report channel, so an element crop cannot be aimed — rebuild the document from this kit's blank.fish.html`
      );
      return 1;
    }
    if (reportError) {
      console.error(opts.element ? `cannot crop to "${opts.element}": ${reportError}` : `${file}: ${reportError}`);
      return 1;
    }
    if (opts.element && !originParam) {
      console.error(`the page reported no position for element "${opts.element}"`);
      return 1;
    }
    if (!reportMatch) {
      console.error(
        `warning: ${file} publishes no ?report channel — capturing the whole page at ${windowSize}; rebuild it from this kit's blank.fish.html for a measured one`
      );
    }

    // Step 2: capture screenshot
    const finalOutResolved = path.resolve(finalOut);
    runBrowser(
      browser,
      [
        ...chromeFlags,
        `--force-device-scale-factor=${scale}`,
        `--window-size=${windowSize.replace("x", ",")}`,
        `--screenshot=${finalOutResolved}`,
        `file://${absDoc}?view=canvas${originParam}`
      ],
      {
        step: "screenshot",
        maxBuffer: 1024 * 1024,
        wroteFile: () => fs.existsSync(finalOutResolved) && fs.statSync(finalOutResolved).size > 0
      }
    );

    if (fs.existsSync(finalOut) && fs.statSync(finalOut).size > 0) {
      // `window` is CSS pixels; the PNG is the window at `scale`. State the
      // bitmap, or the log reads as the output size and is off by the factor.
      const [winW, winH] = windowSize.split("x").map(Number);
      const actualSize = expectedSize || screenshotPlan(winW, winH, scale).expected;
      console.log(`exported PNG to ${finalOut} (${fs.statSync(finalOut).size} bytes, ${actualSize} @${scale}x)`);
      return 0;
    } else {
      console.error(`screenshot failed: no file produced at ${finalOut}`);
      return 1;
    }
  } catch (err) {
    console.error(`browser execution error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

// ---------------------------------------------------------------------------

function main(argv: string[]): number | Promise<number> {
  // Answered before anything else: the kit's `SKILL.md` tells an agent to compare
  // this against the version it was written for, so it must cost nothing to ask.
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    console.log(`fish ${APP_VERSION}`);
    return 0;
  }
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h") || argv.includes("help")) {
    console.log(USAGE);
    return 0;
  }
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));

  // Extract flag values so they do not bleed into positional args
  const getOpt = (long: string, short?: string): string | undefined => {
    const lIdx = rest.indexOf(long);
    if (lIdx >= 0 && lIdx + 1 < rest.length) return rest[lIdx + 1];
    if (short) {
      const sIdx = rest.indexOf(short);
      if (sIdx >= 0 && sIdx + 1 < rest.length) return rest[sIdx + 1];
    }
    return undefined;
  };

  const out = getOpt("--out", "-o");
  const format = getOpt("--format");
  const scaleStr = getOpt("--scale");
  const scale = scaleStr !== undefined ? Number(scaleStr) : undefined;
  const element = getOpt("--element");
  const source = getOpt("--source");
  const limitStr = getOpt("--limit");
  const limit = limitStr !== undefined ? Number(limitStr) : undefined;
  const addTo = getOpt("--add-to");
  const to = getOpt("--to");
  const pickStr = getOpt("--pick");
  const pick = pickStr !== undefined ? Number(pickStr) : undefined;
  const id = getOpt("--id");
  const name = getOpt("--name");
  const viewportStr = getOpt("--viewport");
  const viewport = viewportStr !== undefined ? Number(viewportStr) : undefined;
  const viewportHeightStr = getOpt("--viewport-height");
  const viewportHeight = viewportHeightStr !== undefined ? Number(viewportHeightStr) : undefined;
  const template = getOpt("--template");
  const auditTolerance = auditToleranceOf(getOpt("--audit-tolerance"));
  const summary = getOpt("--summary");
  const ops = getOpt("--ops");
  const reply = getOpt("--reply");
  const text = getOpt("--text");

  // Collect positional arguments, skipping known flags and their values
  const skipIndices = new Set<number>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      skipIndices.add(i);
      if (
        [
          "--out",
          "--format",
          "--scale",
          "--element",
          "--source",
          "--limit",
          "--add-to",
          "--to",
          "--pick",
          "--id",
          "--name",
          "--viewport",
          "--viewport-height",
          "--template",
          "--audit-tolerance",
          "--summary",
          "--ops",
          "--reply",
          "--text"
        ].includes(a) &&
        i + 1 < rest.length
      ) {
        skipIndices.add(i + 1);
      }
    } else if (a === "-o" && i + 1 < rest.length) {
      skipIndices.add(i);
      skipIndices.add(i + 1);
    }
  }
  const args = rest.filter((_, idx) => !skipIndices.has(idx));

  const opts = {
    json: flags.has("--json"),
    strict: flags.has("--strict"),
    geometry: flags.has("--geometry"),
    audit: flags.has("--audit"),
    strictAssets: flags.has("--strict-assets"),
    compact: flags.has("--compact"),
    embed: flags.has("--embed"),
    all: flags.has("--all"),
    replace: flags.has("--replace"),
    out,
    format,
    scale,
    element,
    source,
    limit,
    addTo,
    to,
    pick,
    id,
    name,
    viewport,
    viewportHeight,
    template,
    auditTolerance,
    summary,
    ops,
    reply,
    text
  };
  if (command === "check") {
    if (args.length < 1) return usage("check needs a document");
    return check(args[0], opts);
  }
  if (command === "brief") {
    if (args.length < 1) return usage("brief needs a document");
    return brief(args[0], opts);
  }
  if (command === "compact") {
    if (args.length < 1) return usage("compact needs a document");
    return compactCommand(args[0], opts);
  }
  if (command === "assets") {
    return assetsCommand(args, opts);
  }
  if (command === "comments") {
    return commentsCommand(args, opts);
  }
  if (command === "apply") {
    if (args.length < 2) return usage("apply needs ops and a document");
    return apply(args[0], args[1], opts);
  }
  if (command === "import") {
    if (args.length < 1) return usage("import needs a .html page");
    return importHtmlPage(args[0], {
      out: opts.out,
      viewport: opts.viewport,
      viewportHeight: opts.viewportHeight,
      name: opts.name,
      compact: opts.compact,
      json: opts.json,
      template: opts.template
    });
  }
  if (command === "compose") {
    const jsonFile = args[0];
    const templateFile = args[1] ?? (opts.out ? "templates/blank.fish.html" : undefined);
    if (!jsonFile || !templateFile) return usage("compose needs a design.json and a template.fish.html (or --out with default template)");
    return compose(jsonFile, templateFile, opts);
  }
  if (command === "export") {
    if (args.length < 1) return usage("export needs a document (.fish.html)");
    return exportDocument(args[0], opts);
  }
  return usage(`unknown command "${command}"`);
}

function usage(message: string): number {
  console.error(`${message}\n\n${USAGE}`);
  return 2;
}

// `exitCode`, not `exit()`: Node writes asynchronously to a pipe and synchronously
// to a file or TTY, so `process.exit()` drops everything past the first pending
// buffer and still exits 0 — and only `| cat` sees the truncation. Letting the loop
// drain is the whole fix. See docs/LESSONS_LEARNED.md §111.
const cliResult = main(process.argv.slice(2));
if (typeof cliResult === "number") {
  process.exitCode = cliResult;
} else {
  cliResult.then((code) => {
    process.exitCode = code;
  });
}
