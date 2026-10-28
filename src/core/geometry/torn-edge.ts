/**
 * The pre-rename surface of the edge kernel.
 *
 * `tests/torn-edge.test.ts` builds a break through these names, and its geometry
 * assertions are exactly the net that proves extracting the profile slot did not
 * change one number of the torn field. It moves when that test does.
 */

import type { TearInput } from "../dsl/types";
import { EDGE_DEFAULT, edgeGeometry, type EdgeGeometry, type Point } from "./edge";

export type TearGeometry = EdgeGeometry;
export type { Point };
export const TORN_EDGE_DEFAULT = EDGE_DEFAULT;

/** A torn break, which is what an edge with no profile has always meant. */
export function tornEdgeGeometry(w: number, h: number, edge: TearInput, ox = 0, oy = 0): EdgeGeometry {
  return edgeGeometry(w, h, edge, ox, oy);
}
