import type { ChildSizeResolver } from "./box";

/**
 * The `ChildSizeResolver` the current document implies, for layout passes that
 * were not handed one.
 *
 * A `ChildSizeResolver` answers "how big does this child really paint", which
 * only the caller can know: the document owns the masters, and `core/layout`
 * must not depend on `core/interactions`, which already depends on this module.
 * That constraint is why the resolver is a parameter at all — and it is also
 * why a parameter is not enough. `applyAutoLayout` has 26 call sites and only
 * the two inside the tree passes ever passed one, because every other caller
 * (16 in the auto-layout inspector section, the gestures, `stack-resize`) has no
 * resolver to hand and would silently measure a hugging instance by its
 * authored width — the overlap `LESSONS §71` records. Threading it by hand
 * through 24 sites is how the next drift starts, so the store publishes it once
 * per commit and the passes read it from here.
 *
 * An explicit argument still wins: it is how tests and the headless import path
 * state which document they mean, and how a caller can lay a tree out against a
 * document other than the one currently open.
 *
 * The value is a document's worth of derived sizes, so it is only as fresh as
 * the commit that set it. Read it when a pass runs, never cache a pass's
 * result across one.
 */
let ambient: ChildSizeResolver | undefined;

/** The resolver a pass should use: the explicit one if given, else the store's. */
export function resolveChildSize(
  explicit?: ChildSizeResolver
): ChildSizeResolver | undefined {
  return explicit ?? ambient;
}

export function setAmbientChildSizeResolver(next: ChildSizeResolver | undefined): void {
  ambient = next;
}

/** Test seam: drops the published resolver so one test cannot leak into the next. */
export function clearAmbientChildSizeResolver(): void {
  ambient = undefined;
}
