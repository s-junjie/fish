import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { findBrowser, getChromeFlags, runBrowser } from "./browser";
import { screenshotPlan } from "../export-request";
import { readDocument } from "./doc-source";
import { normalizeDesignDocument } from "../dsl/normalize";
import { findPage, getActivePage } from "../dsl/document-ops";
import type { Page } from "../dsl/types";

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export interface ExportOptions {
  out?: string;
  /** Batch only: where the per-page files land (defaults to the document's directory). */
  outDir?: string;
  format?: string;
  scale?: number;
  element?: string;
  page?: string;
  /** Batch: comma-separated page ids or names, in the order they should be written. */
  pages?: string;
  /** Batch: comma-separated page ids or names to leave out. */
  exclude?: string;
  allPages?: boolean;
}

export function exportDocument(file: string, opts: ExportOptions): number {
  if (!fs.existsSync(file)) {
    console.error(`no such file: ${file}`);
    return 2;
  }

  if (opts.format && opts.format.toLowerCase() !== "png") {
    console.error(`export writes PNG only — unsupported format "${opts.format}"`);
    return 2;
  }
  if (opts.out && !opts.out.toLowerCase().endsWith(".png")) {
    console.error(`export writes PNG only — ${opts.out} is not a .png path`);
    return 2;
  }

  const batch = Boolean(opts.pages || opts.allPages);
  if (opts.page && batch) {
    console.error("choose either --page or --pages / --all-pages, not both");
    return 2;
  }
  if (opts.element && batch) {
    console.error("--element crops one layer; it cannot be combined with --pages / --all-pages");
    return 2;
  }
  if (opts.out && batch) {
    console.error("--out names one file; batch export writes one per page — use --out-dir");
    return 2;
  }
  if (opts.exclude && !batch) {
    console.error("--exclude only means something with --pages or --all-pages");
    return 2;
  }
  if (opts.outDir && !batch) {
    console.error("--out-dir only means something with --pages or --all-pages — use --out for one file");
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

  if (!batch) {
    const out = opts.out || `${documentBase(file)}.png`;
    return exportOne(file, browser, { page: opts.page, element: opts.element, scale, out }) ? 0 : 1;
  }

  const resolved = resolveBatch(file, opts);
  if ("error" in resolved) {
    console.error(resolved.error);
    return 2;
  }
  const { pages } = resolved;
  if (pages.length === 0) {
    console.error("no pages left to export after --pages / --exclude");
    return 2;
  }

  const outDir = path.resolve(opts.outDir ?? path.dirname(path.resolve(file)));
  fs.mkdirSync(outDir, { recursive: true });
  const base = documentBase(file);
  const suffix = scale > 1 ? `@${scale}x` : "";

  let failed = 0;
  for (const page of pages) {
    const out = path.join(outDir, `${base}--${page.id}${suffix}.png`);
    if (!exportOne(file, browser, { page: page.id, scale, out })) {
      failed++;
      continue;
    }
  }
  if (failed > 0) {
    console.error(`${failed} of ${pages.length} page(s) failed to export`);
    return 1;
  }
  return 0;
}

/**
 * The document's name, without the container suffix: `deck.fish.html` is `deck`.
 * A frame named `<doc>--<pageId>.png` is readable in a directory listing; keeping
 * `.fish` in it would read as another extension.
 */
function documentBase(file: string): string {
  const base = path.basename(file);
  return base.toLowerCase().endsWith(".fish.html")
    ? base.slice(0, -".fish.html".length)
    : path.basename(file, path.extname(file));
}

/**
 * The pages a batch names, in the order it names them.
 *
 * A page is picked by id or by name, and a name that matches nothing is refused
 * rather than silently dropped: a batch that writes eight of nine pages and says
 * "exported" is the failure mode this flag exists to prevent.
 */
function resolveBatch(file: string, opts: ExportOptions): { pages: Page[] } | { error: string } {
  const read = readDocument(file);
  if ("error" in read) return { error: read.error };
  const { document } = normalizeDesignDocument(read.value);
  const all = document.pages && document.pages.length > 0 ? document.pages : [getActivePage(document)];

  const queries = (value: string | undefined): string[] =>
    (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const picked: Page[] = [];
  if (opts.pages) {
    for (const query of queries(opts.pages)) {
      const found = findPage(document, query);
      if (!found) return { error: `no page matching "${query}" in ${file}` };
      if (!picked.some((p) => p.id === found.id)) picked.push(found);
    }
  } else {
    picked.push(...all);
  }

  const excluded = new Set<string>();
  for (const query of queries(opts.exclude)) {
    const found = findPage(document, query);
    if (!found) return { error: `no page matching "${query}" to exclude in ${file}` };
    excluded.add(found.id);
  }

  return { pages: picked.filter((p) => !excluded.has(p.id)) };
}

/**
 * One PNG. The window size and crop origin come from the page's own report —
 * neither this function nor the browser call computes them, because a guess here
 * photographs a plausible region of the wrong size instead of failing.
 */
function exportOne(
  file: string,
  browser: string,
  opts: { page?: string; element?: string; scale: number; out: string }
): boolean {
  const absDoc = path.resolve(file);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fish-export-"));
  const { page, element, scale, out } = opts;

  try {
    const chromeFlags = getChromeFlags(tmpDir);

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
    const pageParam = page ? `&page=${encodeURIComponent(page)}` : "";
    const elementParam = element ? `&element=${encodeURIComponent(element)}` : "";
    const query = `view=canvas&report=1&scale=${scale}${pageParam}${elementParam}`;

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
        reportError = `the page's report is not valid JSON — ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if ((element || page) && !reportMatch) {
      console.error(
        element
          ? `${file}: this shell publishes no ?report channel, so an element crop cannot be aimed — rebuild the document from this kit's blank.fish.html`
          : `${file}: this shell publishes no ?report channel, so --page cannot be verified — rebuild the document from this kit's blank.fish.html`
      );
      return false;
    }
    if (reportError) {
      console.error(element ? `cannot crop to "${element}": ${reportError}` : `${file}: ${reportError}`);
      return false;
    }
    if (element && !originParam) {
      console.error(`the page reported no position for element "${element}"`);
      return false;
    }
    if (!reportMatch) {
      console.error(
        `warning: ${file} publishes no ?report channel — capturing the whole page at ${windowSize}; rebuild it from this kit's blank.fish.html for a measured one`
      );
    }

    // Step 2: capture screenshot
    const finalOutResolved = path.resolve(out);
    runBrowser(
      browser,
      [
        ...chromeFlags,
        `--force-device-scale-factor=${scale}`,
        `--window-size=${windowSize.replace("x", ",")}`,
        `--screenshot=${finalOutResolved}`,
        `file://${absDoc}?view=canvas${pageParam}${originParam}`
      ],
      {
        step: "screenshot",
        maxBuffer: 1024 * 1024,
        wroteFile: () => fs.existsSync(finalOutResolved) && fs.statSync(finalOutResolved).size > 0
      }
    );

    if (fs.existsSync(out) && fs.statSync(out).size > 0) {
      // `window` is CSS pixels; the PNG is the window at `scale`. State the
      // bitmap, or the log reads as the output size and is off by the factor.
      const [winW, winH] = windowSize.split("x").map(Number);
      const actualSize = expectedSize || screenshotPlan(winW, winH, scale).expected;
      console.log(`exported PNG to ${out} (${fs.statSync(out).size} bytes, ${actualSize} @${scale}x)`);
      return true;
    }
    console.error(`screenshot failed: no file produced at ${out}`);
    return false;
  } catch (err) {
    console.error(`browser execution error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}
