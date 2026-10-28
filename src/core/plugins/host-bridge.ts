/**
 * The only door between an external plugin and the host.
 *
 * A plugin is a bare ES module executed in the host's realm, and a `blob:` module
 * cannot resolve a bare specifier or a relative import (measured — see
 * `docs/PLUGIN_DISTRIBUTION_PLAN.md` §1). Everything it needs therefore arrives
 * through this one global, which the shell installs once at boot:
 *
 * - **the runtime** (`preact`, `hooks`, `jsx-runtime`): shared, not duplicated.
 *   A second copy of Preact is the failure mode where hooks silently do nothing or
 *   throw `Cannot read properties of undefined (reading '__H')`, and it is very
 *   hard to trace back to "the plugin bundled its own framework".
 * - **document helpers** (`doc`): the page-scoped reads and writes a plugin
 *   needs. A plugin that re-implemented them would drift the moment the shape
 *   of a document changed.
 * - **asset providers** (`assets`): the same instances the canvas drop handler
 *   looks up by `providerId`, so a dragged icon lands through the shell's own
 *   insertion path rather than a parallel one.
 * - **styles** (`styles`): idempotent injection for CSS that travels inside the
 *   plugin bundle, so a plugin built outside this repository does not depend on
 *   the shell having scanned its source.
 *
 * The surface is versioned as a whole (`HOST_API_VERSION`); the loader refuses a
 * bundle that speaks a different major before it executes anything.
 */
import * as preact from "preact";
import * as hooks from "preact/hooks";
import * as jsxRuntime from "preact/jsx-runtime";
import { getActivePage, updateActivePageElements } from "../dsl/types";
import { mapElements } from "../geometry/tree-edit";
import { firstImagePaint } from "../dsl/image-fill";
import { createId } from "../id";
import { lucideProvider, remixProvider, openverseProvider } from "./index";
import { dragPayload } from "./drag";
import { insertRemoteImage } from "./remote-image";
import { injectPluginStyles } from "./plugin-styles";
import { HOST_API_VERSION } from "./manifest";

export interface FishHostBridge {
  apiVersion: string;
  preact: typeof preact;
  hooks: typeof hooks;
  jsxRuntime: typeof jsxRuntime;
  doc: {
    getActivePage: typeof getActivePage;
    updateActivePageElements: typeof updateActivePageElements;
    mapElements: typeof mapElements;
    firstImagePaint: typeof firstImagePaint;
    createId: typeof createId;
  };
  assets: {
    lucideProvider: typeof lucideProvider;
    remixProvider: typeof remixProvider;
    openverseProvider: typeof openverseProvider;
    insertRemoteImage: typeof insertRemoteImage;
    dragPayload: typeof dragPayload;
  };
  styles: {
    inject: typeof injectPluginStyles;
  };
}

export const HOST_BRIDGE_GLOBAL = "__FISH_HOST__";

export function installHostBridge(): FishHostBridge {
  const bridge: FishHostBridge = {
    apiVersion: HOST_API_VERSION,
    preact,
    hooks,
    jsxRuntime,
    doc: { getActivePage, updateActivePageElements, mapElements, firstImagePaint, createId },
    assets: { lucideProvider, remixProvider, openverseProvider, insertRemoteImage, dragPayload },
    styles: { inject: injectPluginStyles }
  };
  (globalThis as unknown as Record<string, unknown>)[HOST_BRIDGE_GLOBAL] = bridge;
  return bridge;
}
