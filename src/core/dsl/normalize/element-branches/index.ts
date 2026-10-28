import type { ElementType } from "../../types";
import { normalizeText } from "./text";
import { normalizeRect } from "./rect";
import { normalizeVideo, normalizeHtml } from "./media";
import { normalizeEllipse } from "./ellipse";
import { normalizePolygon, normalizeStar } from "./regular";
import { normalizePath } from "./path";
import { normalizeLine, normalizeArrow } from "./line";
import { normalizeContainer } from "./container";
import { normalizeInstance } from "./instance";
import type { ElementBranch } from "./shared";

/**
 * The per-type payload of `normalizeElement`, one entry per `ElementType`.
 *
 * Keys are QUOTED because `tests/type-coverage.test.ts` grades this file by
 * looking for `"<member>"` in its source: a member with no arm here used to
 * fall through a `default` into a silent no-op — an unpainted box that kept its
 * place in the tree and reported nothing (LESSONS_LEARNED §38). The
 * `Record<ElementType, …>` turns that same gap into a compile error.
 */
export const ELEMENT_BRANCHES: Record<ElementType, ElementBranch> = {
  "frame": normalizeContainer,
  "component": normalizeContainer,
  "componentSet": normalizeContainer,
  "instance": normalizeInstance,
  "text": normalizeText,
  "rect": normalizeRect,
  "ellipse": normalizeEllipse,
  "polygon": normalizePolygon,
  "star": normalizeStar,
  "path": normalizePath,
  "line": normalizeLine,
  "arrow": normalizeArrow,
  "video": normalizeVideo,
  "html": normalizeHtml
};

export type { ElementBranch, ElementBranchContext } from "./shared";
