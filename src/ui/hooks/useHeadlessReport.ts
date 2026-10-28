import { useEffect } from "preact/hooks";
import type { DesignDocument } from "../../core/dsl/types";
import { normalizeDesignDocument } from "../../core/dsl/normalize";
import { parseLenientJson } from "../../core/dsl/lenient-json";
import { getActivePage } from "../../core/dsl/types";
import { parseReportRequest, screenshotPlan } from "../../core/export-request";
import { measureElement } from "../../core/measure";
import { validateDocument } from "../../core/validate";
import { auditTextInk, DEFAULT_TOLERANCE } from "../../core/audit/text-ink";
import { collectTextInk, scaledTolerance } from "../canvas/text-ink-samples";
import { fontsSettled } from "../canvas/fonts-settled";

/**
 * `?report=1&element=<id>` — put what the engine knows about this document into
 * the DOM as JSON, for a browser's own command line to collect.
 *
 * The point is reachability without installation. Every other channel into the
 * engine needs a driver: the console needs a human with DevTools open, and
 * `npm run render` needs Playwright. `chrome --headless --dump-dom` prints the DOM
 * and is part of the operating system, so a URL parameter is enough for an agent
 * that has installed nothing.
 *
 * It reports rather than rasterizes on purpose. `exportCanvasPng()` resolves its
 * bitmap asynchronously — serialize, blob, decode — and the headless CLI fires at
 * the load event, which is before that resolves: a `--screenshot` of a page that
 * has already run the export comes back as the pre-export canvas, and a
 * `--dump-dom` of it comes back with no payload. A screenshot taken of a settled
 * paint is reliable, so the picture is Chrome's job and the geometry is this page's.
 * Between them the caller learns where to point the window and at what size.
 */

const REPORT_ID = "fish-report";

interface Ref<T> {
  current: T;
}

function rawBlockRepairs(): { repairs: unknown[]; parseError?: string } {
  const block = document.getElementById("design-doc");
  if (!block?.textContent?.trim()) return { repairs: [] };
  try {
    return { repairs: normalizeDesignDocument(parseLenientJson(block.textContent)).repairs as unknown[] };
  } catch (err) {
    // The one failure this channel used to report as a healthy document: the app
    // falls back to an empty canvas, which normalizes with no repairs and
    // validates with no diagnostics — and photographs as a blank page.
    return { repairs: [], parseError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The document as the FILE wrote it, before normalization.
 *
 * The ink audit is the one reader that has to see this level: every other reader
 * in the pipeline sees values after they have been folded and defaulted, so a
 * value lost on the way in is invisible to all of them. Comparing what the file
 * asked for against what the browser computed is what closes that gap.
 */
function rawBlockDocument(): unknown {
  const block = document.getElementById("design-doc");
  if (!block?.textContent?.trim()) return null;
  try {
    return parseLenientJson(block.textContent);
  } catch {
    return null;
  }
}

export function useHeadlessReport(
  doc: DesignDocument,
  docRef: Ref<DesignDocument>,
  canvasContainerRef?: Ref<HTMLDivElement | null>
): { x: number; y: number } | null {
  const request = typeof window !== "undefined" ? parseReportRequest(window.location.search) : null;
  useEffect(() => {
    if (!request) return;

    // Re-published on every commit: load or export can arrive between them,
    // and a report of a half-parsed document is worse than none.
    const publish = async () => {
      const current = docRef.current;
      const raw = rawBlockRepairs();
      const page = getActivePage(current);
      const canvas = {
        width: page.canvas?.width ?? current.canvas?.width ?? 0,
        height: page.canvas?.height ?? current.canvas?.height ?? 0
      };
      const scale = request.scale;
      const wholePage = screenshotPlan(canvas.width, canvas.height, scale);
      const report: Record<string, unknown> = {
        ok: true,
        version: current.version,
        canvas,
        scale,
        // `window` is CSS pixels for `--window-size`; `expected` is the bitmap the
        // browser will produce from it at `scale`. Both stated, so a capture that
        // comes back the wrong size is detectable instead of merely wrong.
        window: wholePage.window,
        expected: wholePage.expected,
        // What normalize changed on the way in, which the loaded document can no
        // longer tell anyone: this is the only report of it to a caller who cannot
        // run `normalize` themselves.
        repairs: raw.repairs,
        validate: validateDocument(current)
      };

      if (raw.parseError) {
        // No window either: a capture of the empty canvas a broken block produces
        // is a correct image of the wrong thing.
        report.ok = false;
        report.error = `the #design-doc block is not valid JSON — ${raw.parseError}`;
        delete report.window;
        delete report.expected;
      }

      if (request.elementId) {
        const measured = measureElement(current, request.elementId);
        if (!measured) {
          // No silent whole-page fallback: a plausible-looking number for an id that
          // does not exist is the failure this channel exists to prevent. The
          // window goes with it — a caller that photographs the whole page because
          // the element lookup failed gets a correct image of the wrong thing.
          report.ok = false;
          report.error = `no element with id "${request.elementId}" in this document`;
          delete report.window;
          delete report.expected;
        } else {
          const region = screenshotPlan(measured.width, measured.height, scale);
          report.element = measured;
          report.window = region.window;
          report.expected = region.expected;
          report.origin = `${measured.x},${measured.y}`;
        }
      }

      if (request.audit) {
        // Measurement has to happen before the block is written: this is the
        // only reader that looks at the painted page, and the page is what the
        // caller cannot see for itself.
        const fontsReady = await fontsSettled();
        const collection = collectTextInk(current, rawBlockDocument());
        // The default is 1px, which is the sub-pixel-kerned line; a caller who
        // asks for more is asking for a coarser grade, not a different rule.
        const px = request.auditTolerance ?? DEFAULT_TOLERANCE.x;
        const tolerance = scaledTolerance(collection, { x: px, y: px });
        report.audit = {
          ok: true,
          fontsReady,
          zoom: Math.round(collection.zoom * 1000) / 1000,
          tolerance,
          checked: collection.samples.length,
          skipped: collection.skipped,
          findings: auditTextInk(collection.samples, tolerance)
        };
      }

      let el = document.getElementById(REPORT_ID) as HTMLScriptElement | null;
      if (!el) {
        el = document.createElement("script");
        el.id = REPORT_ID;
        el.type = "application/json";
        document.body.appendChild(el);
      }
      // Every `<` becomes `\u003c`: the payload is handed to a caller through a
      // `<script>` element's text, so a `<` inside a message — or inside any
      // future field that quotes markup — would end the element early and
      // truncate the JSON. The caller parses it back to the original text.
      el.textContent = JSON.stringify(report).replace(/</g, "\\u003c");
    };

    publish();
    const timer = setTimeout(publish, 400);
    return () => clearTimeout(timer);
  }, [doc, docRef, canvasContainerRef, request]);

  return request?.origin ?? null;
}
