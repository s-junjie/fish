import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { findBrowser, getChromeFlags, runBrowser } from "./browser";
import { normalizeDesignDocument } from "../dsl/normalize";
import { syncDocumentBindings } from "../interactions/style-ops";
import { validateDocument } from "../validate";
import { geometryReport } from "../geometry-report";
import { checkVerdict } from "../check-verdict";
import { laidOutDocument } from "../layout-report";
import { fontDiagnostics } from "../font-diagnostics";
import { countElements } from "../geometry/tree-ops";
import type { DesignDocument } from "../dsl/types";
import { auditRuleDrift, inkGateLevel } from "../audit/text-ink";
import type { InkFinding } from "../audit/text-ink";
import { readDocument } from "./doc-source";
import type { Source } from "./doc-source";

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
  findings: InkFinding[];
  checked: number;
  skipped: Array<{ elementId: string; reason: string }>;
  zoom: number;
  /** Screen px the shell actually graded at, echoed back so a summary can say it. */
  tolerance?: { x: number; y: number };
  fontsReady?: boolean;
  /** The rules the file's own runtime looked for — see `auditRuleDrift`. */
  rules?: string[];
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
      fontsReady: audit.fontsReady,
      rules: audit.rules
    };
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

export function check(
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
  const read = readDocument(file);
  if ("error" in read) {
    if (opts.json && read.parseError) {
      console.log(JSON.stringify({ ok: false, file, parseError: read.parseError }, null, 2));
    } else {
      console.error(read.error);
    }
    return read.code;
  }
  const { src, value } = read;

  // Materialised before it is graded: a text that names a text style and carries
  // no `style` is a text the canvas paints at the default 24px, and `validate`
  // has to see the size the renderer will use, not the one the author omitted.
  const { document: normalized, repairs } = normalizeDesignDocument(value);
  // Laid out before it is graded: the load path positions every in-flow child, and
  // a verdict about a box that the page never paints is the one kind of green
  // `check` must not give.
  const prepared = laidOutDocument(syncDocumentBindings(normalized), value);
  const document = prepared.document;
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
  // Graded here, not by the runtime that measured: which findings may fail a build
  // is the gate's judgement, and the file's own runtime can be from another build.
  const inkFindings = (ink && typeof ink !== "string" ? ink.findings : []).map((finding) => ({
    level: inkGateLevel(finding),
    message: finding.message,
    elementId: finding.elementId
  }));
  const all = [...diagnostics, ...prepared.findings, ...geometry, ...assetFindings, ...fontFindings, ...inkFindings];
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
          ...(prepared.findings.length > 0 ? { layout: prepared.findings } : {}),
          ...(opts.geometry ? { geometry } : {}),
          ...(opts.audit ? { ink: inkJson(ink) } : {}),
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
  console.log(`  findings: ${errors.length} error(s), ${warnings.length} warning(s)`);
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
 * The audit as JSON, with the rule-set question answered rather than left to the
 * reader.
 *
 * `ok` is the same word it is at the top level: nothing in this block failed. A
 * block that reads `{"ok": true, "findings": [{"level": "error"}]}` is a pass an
 * agent has no reason to doubt; "the audit ran" is what the block's presence
 * already says.
 */
function inkJson(ink: InkAudit | string | null): Record<string, unknown> {
  if (typeof ink === "string") return { ok: false, error: ink };
  if (!ink) return { ok: false, error: "the audit did not run" };
  const drift = auditRuleDrift(ink.rules);
  return { ok: !ink.findings.some((f) => f.level === "error"), ...ink, ...(drift ? { ruleDrift: drift } : {}) };
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
  const drift = auditRuleDrift(ink.rules);
  if (drift) lines.push(`    [note] ${drift}`);
  for (const s of ink.skipped) lines.push(`    [skipped] ${s.elementId}: ${s.reason}`);
  return lines.join("\n");
}
