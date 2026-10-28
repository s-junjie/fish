import { useEffect, useState } from "preact/hooks";

/**
 * Ask the inspector to open one image fill's panel.
 *
 * A module store rather than prop threading: the canvas raises the request and
 * the fill section, at the other end of the tree, consumes it. The nonce makes a
 * second double-click on the same row a new request rather than an identical
 * value the subscriber would ignore.
 */
export interface ImagePaintOpenRequest {
  elId: string;
  paintIndex: number;
  nonce: number;
}

let request: ImagePaintOpenRequest | null = null;
const listeners = new Set<() => void>();

export function requestImagePaintOpen(elId: string, paintIndex: number) {
  request = { elId, paintIndex, nonce: (request?.nonce ?? 0) + 1 };
  listeners.forEach((fn) => fn());
}

export function clearImagePaintOpenRequest() {
  if (!request) return;
  request = null;
  listeners.forEach((fn) => fn());
}

export function useImagePaintOpenRequest(): ImagePaintOpenRequest | null {
  const [cur, setCur] = useState<ImagePaintOpenRequest | null>(request);
  useEffect(() => {
    const fn = () => setCur(request);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return cur;
}
