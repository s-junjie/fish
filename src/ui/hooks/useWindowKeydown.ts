import { useEffect } from "preact/hooks";

/**
 * keydown on window, bound for as long as `deps` hold.
 *
 * `deps` is passed through rather than flattened into a ref on purpose: a
 * handler that reads a prop keeps exactly the staleness it had written inline,
 * and the call sites that shared this shape answer for different keys.
 */
export function useWindowKeydown(handler: (e: KeyboardEvent) => void, deps: unknown[]) {
  useEffect(() => {
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, deps);
}
