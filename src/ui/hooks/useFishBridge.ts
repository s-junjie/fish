import { useEffect, useRef } from "preact/hooks";
import { DesignDocument } from "../../core/dsl/types";
import { ViewportBox } from "../../core/geometry/cull";
import { measureDocument, measureElement } from "../../core/measure";
import { layoutDebug } from "../../core/layout-debug";
import { validateDocument } from "../../core/validate";
import { normalizeDesignDocument } from "../../core/dsl/normalize";
import { exportCanvasAsDataUrl, exportCanvasAsSvgString } from "../../core/export";
import type { ExportOptions } from "../../core/export";
import {
  runCheck,
  withFindings,
  type CheckFinding,
  type CheckReport
} from "../../core/check-report";
import { auditTextInk, DEFAULT_TOLERANCE } from "../../core/audit/text-ink";
import { collectTextInk, scaledTolerance } from "../canvas/text-ink-samples";
import { fontsSettled } from "../canvas/fonts-settled";

interface FishBridgeOptions {
  docRef: { current: DesignDocument };
  canvasContainerRef: { current: HTMLDivElement | null };
  zoom: number;
  pan: { x: number; y: number };
}

interface FishCheckOptions {
  /** Authored JSON to check without loading it. Cannot be combined with `ink`. */
  doc?: unknown;
  strict?: boolean;
  geometry?: boolean;
  ink?: boolean;
}

/**
 * `window.__fish`: the channel an agent drives the editor through.
 *
 * Two things make this a hook rather than an effect written inline. The viewport
 * is read through a ref, because `measure` is called long after the render that
 * installed it and must not answer with the zoom of that render. And the whole
 * object is installed once: every accessor reads `docRef.current` at call time,
 * so nothing here has to be reinstalled when the document changes.
 */
export function useFishBridge({ docRef, canvasContainerRef, zoom, pan }: FishBridgeOptions): void {
  const viewportRef = useRef({ zoom, pan });
  viewportRef.current = { zoom, pan };

  // The canvas rectangle in document coordinates. The renderer culls to it, so
  // this is what decides whether a node is on screen right now — and an export
  // taken while a node is culled photographs empty canvas where it stands, with
  // every number still reporting it as fine.
  const liveViewport = (): ViewportBox | undefined => {
    const canvas = canvasContainerRef.current?.querySelector("svg");
    if (!canvas) return undefined;
    const r = canvas.getBoundingClientRect();
    const { zoom: z, pan: p } = viewportRef.current;
    const zoomNow = z || 1;
    return {
      x: (-r.left + p.x) / zoomNow,
      y: (-r.top + p.y) / zoomNow,
      width: r.width / zoomNow,
      height: r.height / zoomNow
    };
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__fish = {
      get doc() {
        return docRef.current;
      },
      validate: () => validateDocument(docRef.current),
      /**
       * One verdict for the whole document: normalize repairs, validation,
       * geometry, and — when `ink` is set — the live page's text-ink audit.
       *
       * Without `ink` this is synchronous. The ink audit reads the painted DOM,
       * so it can only grade the open document, and it waits for the webfonts
       * first; omit `doc` when asking for it.
       */
      check: (options: FishCheckOptions = {}): CheckReport | Promise<CheckReport> => {
        if (options.ink && options.doc !== undefined) {
          throw new Error("__fish.check: ink audits the open document; omit `doc`");
        }
        const base = runCheck(options.doc !== undefined ? options.doc : docRef.current, {
          candidate: options.doc !== undefined,
          strict: options.strict,
          geometry: options.geometry
        });
        if (!options.ink) return base.report;

        return (async (): Promise<CheckReport> => {
          const fontsReady = await fontsSettled();
          const live = docRef.current;
          const collection = collectTextInk(live, live);
          const tolerance = scaledTolerance(collection, DEFAULT_TOLERANCE);
          const inkAudit = auditTextInk(collection.samples, tolerance);
          const inkFindings: CheckFinding[] = inkAudit.map((finding) => ({
            source: "ink",
            level: finding.level,
            message: finding.message,
            elementId: finding.elementId,
            code: finding.rule
          }));
          return withFindings(base.report, inkFindings, options.strict ?? false, {
            ink: {
              measured: collection.samples.length > 0,
              fontsReady,
              zoom: Math.round(collection.zoom * 1000) / 1000,
              checked: collection.samples.length,
              skipped: collection.skipped,
              findings: inkAudit
            }
          });
        })();
      },
      /**
       * Where an element paints, in canvas coordinates. An agent that cannot
       * read geometry back has only the whole-canvas raster to judge a layout
       * from, and a tall page downsampled for a vision model is illegible — so
       * this is what turns "export one region and look at it" into a loop.
       */
      measure: (id: string) => measureElement(docRef.current, id, liveViewport()),
      measureAll: () => measureDocument(docRef.current, liveViewport()),
      /**
       * Every auto-layout container with the box it was laid out at beside the
       * space its children actually occupy. `overflow: true` means the two
       * disagree, which is the one layout failure a screenshot cannot show you:
       * the container is the right size and the content inside it is not.
       */
      layoutDebug: () => layoutDebug(docRef.current),
      exportCanvasPng: (options?: ExportOptions) =>
        exportCanvasAsDataUrl(docRef.current, canvasContainerRef.current, options),
      exportCanvasSvg: (options?: ExportOptions) =>
        exportCanvasAsSvgString(docRef.current, canvasContainerRef.current, options),
      /**
       * Normalize a candidate document without touching the open one, and
       * hand back the repairs alongside it.
       *
       * This is the only channel through which an external agent can learn
       * that something it wrote was changed: normalize silently repairs, so
       * without the repair list a dropped property is indistinguishable from
       * one that worked, and the agent makes the same mistake every time.
       */
      normalize: (candidate: unknown) => normalizeDesignDocument(candidate)
    };
  }, []);
}
