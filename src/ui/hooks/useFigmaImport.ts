import { useCallback, useRef } from "preact/hooks";
import { getActivePage } from "../../core/dsl/types";
import type { DesignDocument, DesignElement } from "../../core/dsl/types";
import { importFigmaFile as importFigmaJson, type ImportFigmaFileOutcome } from "../../core/import/figma-import";
import type { FigmaImportOptions } from "../../core/import/figma-types";
import { landFigmaImport } from "../../core/import/figma-landing";
import { FigmaExportError, parseFigmaExport } from "../../core/import/figma-export";
import { FigmaBundleError, looksLikeZip, readFigmaBundle } from "../../core/import/figma-bundle";
import { blobsFromImageFills } from "../../core/import/figma-assets";
import { withImportedDesignSystem } from "../../core/import/imported-tokens";
import { t } from "../../i18n";

interface UseFigmaImportOptions {
  docRef: { current: DesignDocument };
  commitSnapshot: (doc: DesignDocument) => void;
  select: (ids: Set<string>) => void;
  showHint?: (message: string) => void;
  setPan: (pan: { x: number; y: number }) => void;
  setZoom: (zoom: number) => void;
}

const MIN_ZOOM = 0.05;

/**
 * What an import tells its caller while it works.
 *
 * `stage` is a noun because there is more than one thing to wait for and "42%"
 * of what is ambiguous; the dialog turns it into a sentence.
 */
export type ImportProgress = (stage: "images", done: number, total: number) => void;

/**
 * Pulling a design into the document, from a file the designer picked.
 *
 * The same shape as `useHtmlImport` and for the same reasons: the result lands
 * on PAGES of its own rather than on top of what the user is looking at, and the
 * view follows it, because a page switch that leaves the user on empty canvas is
 * indistinguishable from a failed import. A Figma file is several boards, so each
 * one becomes a page and the first is the one that opens.
 *
 * THE PASTE IS THE OTHER LANDING. The clipboard copy of a selection is content
 * the designer is placing onto the page they are working on, so it joins that
 * page instead of opening one of its own — unless it carries several pages,
 * which no gesture can fold into one board. `landFigmaImport` decides, and
 * `figma-landing.ts` says why.
 *
 * ONE DOOR: the file the designer exported with the FISH Export plugin. Nothing
 * here asks Figma for anything, so there is no token, no seat and no rate limit —
 * `docs/FIGMA_IMPORT_PLAN.md` §0.
 */
export function useFigmaImport({
  docRef,
  commitSnapshot,
  select,
  showHint,
  setPan,
  setZoom
}: UseFigmaImportOptions) {
  // A second import while one is in flight would interleave two documents' worth
  // of pages into one commit; the dialog disables its own button, and this is the
  // half that holds if it is opened twice.
  const busyRef = useRef(false);

  /**
   * Land an import: the view follows what landed, the report is said out loud.
   *
   * Every path into the document goes through here, so what "an import landed"
   * means is written once. The gaps ride along in the same toast as the counts,
   * because a designer who is told "imported 412 layers" and not "12 of them lost
   * their per-run text styling" has been told the useful half.
   *
   * `paste` is the gesture, and it is the caller's to know: the clipboard door
   * and the picker hand over the same payload and mean different things by it.
   */
  const commitImport = useCallback(
    (result: ImportFigmaFileOutcome, extraNotes: string[], paste: boolean) => {
      const landing = landFigmaImport(docRef.current, result, { paste });

      // The layers already carry `tokenId` / `tokenBindings`, so the tokens they
      // name have to be on the document in this same commit or every one of them
      // is a reference to a style that does not exist yet.
      commitSnapshot({ ...landing.doc, ...withImportedDesignSystem(landing.doc, result.tokens) });
      select(landing.landedIds);
      focusOn(landing.landed, setPan, setZoom);

      const { elementCount, pageCount, downgraded, unmapped, styleBindings, tokensCreated, stylesCreated } = result.report;
      const name = landing.ontoCurrentPage
        ? getActivePage(landing.doc).name
        : result.pages[result.activePageIndex].name;
      const partial = downgraded.length > 0;
      const message = landing.ontoCurrentPage
        ? t(partial ? "figmaImport.pastedPartial" : "figmaImport.pasted", {
            n: elementCount,
            name,
            k: downgraded.length
          })
        : t(partial ? "figmaImport.donePartial" : "figmaImport.done", {
            n: elementCount,
            name,
            k: partial ? downgraded.length : pageCount
          });
      const notes = [
        tokensCreated > 0 ? t("figmaImport.tokenNote", { n: tokensCreated }) : "",
        stylesCreated > 0 ? t("figmaImport.styleNote", { n: stylesCreated }) : "",
        styleBindings > 0 ? t("figmaImport.boundNote", { n: styleBindings }) : "",
        unmapped.length > 0 ? t("figmaImport.unmappedNote", { n: unmapped.length }) : "",
        ...extraNotes
      ].filter(Boolean);
      showHint?.(notes.length > 0 ? `${message} · ${notes.join(" · ")}` : message);
    },
    [docRef, commitSnapshot, select, showHint, setPan, setZoom]
  );

  /**
   * Every read ends here, and a read that does not end in a document says why in
   * the hint toast.
   *
   * There is no dialog under this any more, so this is the ONLY place a failure
   * can be reported: an incorrect file must not come back as silence. The same
   * channel `useHtmlImport` uses, and for the same reason — a bad file is a
   * refused action, not a form to fill in again.
   */
  const guarded = useCallback(
    async (
      read: (existing: FigmaImportOptions, onProgress?: ImportProgress) => Promise<{ result: ImportFigmaFileOutcome; notes: string[] }>,
      paste: boolean
    ) => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const { result, notes } = await read(
          { styles: docRef.current.styles ?? [], tokens: docRef.current.tokens ?? [] },
          (stage, done, total) => {
          // Images are the slow part — one real export carried 38 photographs — and
          // they are decoded with nothing on screen. Without this the app is
          // indistinguishable from one that has hung.
            if (stage === "images" && total > 0) showHint?.(t("figmaImport.progressImages", { n: done, k: total }));
          }
        );
        commitImport(result, notes, paste);
      } catch (err) {
        if (!(err instanceof FigmaExportError || err instanceof FigmaBundleError)) {
          console.error("Figma import failed:", err);
        }
        showHint?.(figmaImportErrorMessage(err));
      } finally {
        busyRef.current = false;
      }
    },
    [docRef, commitImport, showHint]
  );

  /**
   * The one door: a file the designer picked. No token, no request, no seat — the
   * file already carries the document and (unless they unticked them) the image
   * bytes.
   *
   * TWO PACKAGINGS, ONE READER. The plugin writes a zip — `export.json` plus an
   * `assets/` folder — and older exports are a single `.json` with the images
   * inlined. They are told apart by the first four bytes rather than by the
   * extension, so the picker offers both names and neither the UI nor the reader
   * depends on the user guessing right; handing over the other one, or something
   * else entirely, is a sentence rather than a stack. The clipboard copy is the
   * inline form — a paste arrives here as a `File` wrapping the same text — so
   * the gesture and the picker are one door with two doorknobs.
   *
   * The zip is not tidiness. Inline base64 has to be parsed out of the whole JSON
   * before anything can be made smaller, and one real export was 99.6MB of it. As
   * a folder the manifest is kilobytes and each image arrives as bytes, which is
   * what lets the app's own image policy apply at all.
   *
   * `paste: true` is the clipboard doorknob, and it is the only thing that tells
   * the landing which of the two meanings this arrival has.
   */
  const importFigmaExport = useCallback(
    (file: File, options?: { paste?: boolean }) =>
      guarded(async (existing, report) => {
        const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
        const bundle = looksLikeZip(head) ? await readFigmaBundle(file) : null;
        let envelope: unknown;
        if (bundle) {
          envelope = bundle.manifest;
        } else {
          try {
            envelope = JSON.parse(await file.text());
          } catch {
            throw new FigmaExportError(t("figmaImport.errNotExport"));
          }
        }

        const parsed = parseFigmaExport(envelope);

        // TWO PACKAGINGS, ONE POLICY. The folder hands its images over as bytes;
        // the single-file form — and the clipboard copy, which can only be text —
        // inlines them as data URIs. The difference used to end there: a data URI
        // was registered verbatim, so the same photograph imported at 2.6MB as a
        // `.json` and re-encoded as a folder. So the inline form is unpacked
        // into bytes HERE and both take the blob path, which is where the app's
        // image policy lives. Raw bytes go in as bytes, whichever box they came in.
        const imageBlobs = bundle ? bundle.images : blobsFromImageFills(parsed.imageFills);

        const result = await importFigmaJson(
          // A bare node carries neither, and wrapping it in a response only to
          // hold `undefined` would make `extractFigmaRoot` decide between two
          // spellings of the same thing.
          parsed.variables || parsed.styles
            ? {
                document: parsed.document,
                variables: parsed.variables,
                variableCollections: parsed.variableCollections,
                styles: parsed.styles
              }
            : parsed.document,
          { ...existing, onProgress: report, imageBlobs }
        );

        // Counted in LAYERS, not in kinds: "1 property could not be read" tells a
        // designer nothing about whether their file is intact. A ref the manifest
        // named but the archive does not carry counts here too — a gap said out
        // loud, rather than a blank rectangle nobody can account for.
        const lostLayers =
          parsed.unreadable.reduce((sum, gap) => sum + gap.count, 0) + (bundle?.missing.length ?? 0);
        return {
          result,
          notes: lostLayers > 0 ? [t("figmaImport.exportPartialNote", { n: lostLayers })] : []
        };
      }, options?.paste === true),
    [guarded]
  );

  return { importFigmaExport };
}

/**
 * Centre the imported pages in the canvas strip at a zoom that fits.
 *
 * `screen = world * zoom + pan` is the app's own transform, so this is the same
 * arithmetic `useHtmlImport` does — measured between the two panels rather than
 * across the window, because centring on the window parks a wide import underneath
 * the layer tree, which looks exactly like an import that did nothing.
 *
 * It fits the BOUNDS of everything imported rather than one frame: a Figma file's
 * first page is one board among several, and fitting only that board would leave
 * the rest off screen with no indication that it arrived.
 */
function focusOn(
  elements: DesignElement[],
  setPan: (pan: { x: number; y: number }) => void,
  setZoom: (zoom: number) => void
): void {
  const bounds = contentBounds(elements);
  if (!bounds) return;

  const left = document.querySelector('[data-ui-panel="left"]')?.getBoundingClientRect();
  const right = document.querySelector('[data-ui-panel="right"]')?.getBoundingClientRect();
  const x0 = left && left.width > 0 ? left.right : 0;
  const x1 = right && right.width > 0 ? right.left : window.innerWidth;
  const area =
    x1 - x0 > 120
      ? { left: x0, top: 0, width: x1 - x0, height: window.innerHeight }
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };

  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const zoom = Math.max(MIN_ZOOM, Math.min(1, (area.width * 0.9) / width, (area.height * 0.8) / height));
  setZoom(zoom);
  setPan({
    x: Math.round(area.left + (area.width - width * zoom) / 2 - bounds.minX * zoom),
    y: Math.round(area.top + (area.height - height * zoom) / 2 - bounds.minY * zoom)
  });
}

function contentBounds(elements: DesignElement[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (list: DesignElement[], ox: number, oy: number) => {
    for (const el of list) {
      if (el.visible === false) continue;
      const x = ox + el.x;
      const y = oy + el.y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + el.width);
      maxY = Math.max(maxY, y + el.height);
      const children = (el as { children?: DesignElement[] }).children;
      if (children?.length) walk(children, x, y);
    }
  };
  walk(elements, 0, 0);
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Turn a read failure into the sentence the notice shows.
 *
 * Both file-level failures are named explicitly because being handed the wrong
 * file is the expected mistake — a designer has a folder of zips — and each
 * already comes with a sentence that says what to do about it. The fall-through
 * is for an unexpected failure, and it still says something rather than nothing.
 */
export function figmaImportErrorMessage(err: unknown): string {
  if (err instanceof FigmaExportError || err instanceof FigmaBundleError) return err.message;
  if (err instanceof SyntaxError) return t("figmaImport.errNotExport");
  return err instanceof Error && err.message ? err.message : t("figmaImport.failed");
}