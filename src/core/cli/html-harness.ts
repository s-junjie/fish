/**
 * The browser half of `fish import`.
 *
 * It exists so the CLI does NOT own a layout engine. Flex, grid, wrapping and
 * font metrics are decided by one, and the importer's whole premise is that the
 * answer comes from a real browser measuring a real page rather than from a
 * second implementation of CSS — so this runs `importHtmlDocument` where it was
 * written to run and hands the result back.
 *
 * Bundled for the browser by `scripts/build-fish-agent-kit.mjs` into
 * `tools/html-harness.js`; the CLI inlines it into a temp page and reads the
 * result back over the report POST.
 */

import { importHtmlDocument } from "../import/html-import";
import { DEFAULT_VIEWPORT_HEIGHT, DEFAULT_VIEWPORT_WIDTH, type ImportResult } from "../import/html-types";

/**
 * `report.sources` is dropped: it maps each element back to the DOM path it came
 * from, which is traceability for a human reading an import, not something an
 * agent can act on — and it is one entry per element in a payload that crosses
 * a process boundary.
 */
export interface HarnessResult {
  elements: ImportResult["elements"];
  assets: ImportResult["assets"];
  missing: ImportResult["missing"];
  tokens?: ImportResult["tokens"];
  report: Omit<ImportResult["report"], "sources">;
}

async function importPage(
  html: string,
  viewportWidth: number,
  viewportHeight: number,
  rootName: string
): Promise<HarnessResult> {
  const result = await importHtmlDocument(html, {
    viewportWidth: viewportWidth || DEFAULT_VIEWPORT_WIDTH,
    viewportHeight: viewportHeight || DEFAULT_VIEWPORT_HEIGHT,
    rootName: rootName || "Imported Page"
  });
  const { sources, ...report } = result.report;
  void sources;
  return {
    elements: result.elements,
    assets: result.assets,
    missing: result.missing,
    tokens: result.tokens,
    report
  };
}

declare global {
  interface Window {
    fishImportPage?: typeof importPage;
  }
}

window.fishImportPage = importPage;
