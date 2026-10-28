/**
 * The browser half of `fish assets import|embed`.
 *
 * It exists so the CLI does NOT own an image policy. `MAX_IMAGE_EDGE`,
 * `WEBP_QUALITY`, the SVG/GIF pass-through and the downscale arithmetic all live
 * in `image-loader.ts`, and this file reaches for them rather than restating
 * them — a second set of numbers in the CLI is how the Figma importer once wrote
 * 2.6MB originals while the rest of the app enforced a limit (image-loader.ts).
 *
 * Bundled for the browser by `scripts/build-fish-agent-kit.mjs` into
 * `tools/image-harness.js`; the CLI inlines it into a temp page and reads the
 * result back out of the DOM. Runs on `file://`, so the bytes arrive as base64
 * rather than as a file the page could fetch.
 */

import { loadImageAsset } from "../interactions/image-loader";

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buffer;
}

export interface HarnessResult {
  uri: string;
  width: number;
  height: number;
}

async function optimizeImage(name: string, mime: string, b64: string): Promise<HarnessResult> {
  const file = new File([base64ToArrayBuffer(b64)], name, { type: mime });
  const asset = await loadImageAsset(file, name);
  return { uri: asset.uri, width: asset.width ?? 0, height: asset.height ?? 0 };
}

declare global {
  interface Window {
    fishOptimizeImage?: typeof optimizeImage;
  }
}

window.fishOptimizeImage = optimizeImage;
