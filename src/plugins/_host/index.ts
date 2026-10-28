/**
 * The host surface, as a plugin sees it.
 *
 * A plugin bundle is one `blob:` module with no base URL, so it cannot resolve a
 * bare or relative specifier — everything shared with the shell arrives through
 * `globalThis.__FISH_HOST__`. These bindings are taken once, at module evaluation,
 * which is after the shell has installed the bridge and before any render: hooks
 * therefore keep a single identity for the lifetime of the panel.
 *
 * Nothing here is re-implemented. In particular `doc.*` is the shell's own
 * helper, because a plugin holding its own copy of "where a page's tree lives"
 * would drift the first time that shape changed.
 */
import type * as Preact from "preact";
import type * as PreactHooks from "preact/hooks";
import type * as JsxRuntime from "preact/jsx-runtime";
import type * as DslTypes from "../../core/dsl/types";
import type * as TreeEdit from "../../core/geometry/tree-edit";
import type * as ImageFill from "../../core/dsl/image-fill";
import type * as IdModule from "../../core/id";
import type * as AssetModule from "../../core/plugins";
import type * as DragModule from "../../core/plugins/drag";
import type * as RemoteImageModule from "../../core/plugins/remote-image";
import type * as StylesModule from "../../core/plugins/plugin-styles";

type HooksModule = typeof PreactHooks;
type JsxModule = typeof JsxRuntime;
type PreactModule = typeof Preact;

export interface FishHostBridge {
  apiVersion: string;
  preact: PreactModule;
  hooks: HooksModule;
  jsxRuntime: JsxModule;
  doc: {
    getActivePage: typeof DslTypes.getActivePage;
    updateActivePageElements: typeof DslTypes.updateActivePageElements;
    /** Deep map over the page tree — a nested selection is not a top-level child. */
    mapElements: typeof TreeEdit.mapElements;
    firstImagePaint: typeof ImageFill.firstImagePaint;
    createId: typeof IdModule.createId;
  };
  assets: {
    lucideProvider: typeof AssetModule.lucideProvider;
    remixProvider: typeof AssetModule.remixProvider;
    openverseProvider: typeof AssetModule.openverseProvider;
    insertRemoteImage: typeof RemoteImageModule.insertRemoteImage;
    dragPayload: typeof DragModule.dragPayload;
  };
  styles: {
    inject: typeof StylesModule.injectPluginStyles;
  };
}

export function host(): FishHostBridge {
  const bridge = (globalThis as unknown as { __FISH_HOST__?: FishHostBridge }).__FISH_HOST__;
  if (!bridge) {
    throw new Error("FISH host bridge is missing — a plugin was evaluated before the shell installed it");
  }
  return bridge;
}

const bridge = host();

export const useState = bridge.hooks.useState;
export const useEffect = bridge.hooks.useEffect;
export const useRef = bridge.hooks.useRef;
export const useMemo = bridge.hooks.useMemo;
export const useCallback = bridge.hooks.useCallback;
export const jsx = bridge.jsxRuntime.jsx;
export const jsxs = bridge.jsxRuntime.jsxs;
export const Fragment = bridge.jsxRuntime.Fragment;

export const getActivePage = bridge.doc.getActivePage;
export const updateActivePageElements = bridge.doc.updateActivePageElements;
export const mapElements = bridge.doc.mapElements;
export const firstImagePaint = bridge.doc.firstImagePaint;
export const createId = bridge.doc.createId;
export const lucideProvider = bridge.assets.lucideProvider;
export const remixProvider = bridge.assets.remixProvider;
export const openverseProvider = bridge.assets.openverseProvider;
export const insertRemoteImage = bridge.assets.insertRemoteImage;
export const dragPayload = bridge.assets.dragPayload;
export const injectPluginStyles = bridge.styles.inject;
