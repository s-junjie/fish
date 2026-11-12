import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { findBrowser, getChromeFlags, runBrowser } from "./browser";
import { screenshotPlan } from "../export-request";

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------


export function exportDocument(
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
