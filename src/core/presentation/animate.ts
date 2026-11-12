import { ContainerElement, CornerRadius, DesignElement, SlideDirection, SlideTransition } from "../dsl/types";
import { MorphMatch, MorphPair, MorphSolo } from "./morph";
import { interpolateCornerRadius, interpolateEffects } from "./interpolate-effects";
import { appearanceFrame } from "./interpolate-appearance";

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

const ORIGIN = { x: 0, y: 0 };

/** The renderer's own default viewing distance, so an absent one is not zero. */
const DEFAULT_PERSPECTIVE = 800;

/**
 * What a morph carries across, one line per field. This table IS the answer to
 * "why is my new field not animating": nothing travels unless it is written
 * here, and a blind diff of two elements cannot replace it.
 *
 * `absent` is the value a slide means by leaving the key out, and it is a
 * per-field fact no generic walk can guess — a missing `sweep` is a full turn,
 * a missing `perspective` is 800, a missing `skewX` is 0. A field with no
 * `absent` has no meaningful "nothing" (a rect has no vertex count), so it only
 * travels when both halves are the kind of layer that has one.
 *
 * `whole` is a count, not a length: a polygon cannot have 5.5 vertices.
 * `"flip"` is a mirror, which has no halfway at all.
 *
 * `tests/presentation-slide.test.ts` grades this table against the schema, so a
 * field added to the DSL is red until it is classified here.
 */
type Carry = { kind: "number"; whole?: boolean; absent?: number } | { kind: "flip" };

const CARRIED: Readonly<Record<string, Carry>> = {
  rotation: { kind: "number", absent: 0 },
  rotateX: { kind: "number", absent: 0 },
  rotateY: { kind: "number", absent: 0 },
  skewX: { kind: "number", absent: 0 },
  skewY: { kind: "number", absent: 0 },
  perspective: { kind: "number", absent: DEFAULT_PERSPECTIVE },
  cornerSmoothing: { kind: "number", absent: 0 },
  sweep: { kind: "number", absent: 360 },
  startAngle: { kind: "number", absent: 0 },
  innerRadius: { kind: "number", absent: 0 },
  gap: { kind: "number", absent: 0 },
  sides: { kind: "number", whole: true },
  points: { kind: "number", whole: true },
  dx: { kind: "number" },
  dy: { kind: "number" },
  flipX: { kind: "flip" },
  flipY: { kind: "flip" }
};

/** The fields this table carries, for the test that grades it. */
export const CARRIED_FIELDS: readonly string[] = Object.keys(CARRIED);

/**
 * Every field a morph deliberately leaves alone, and why. Not a second list to
 * keep in step: the test fails on a numeric schema key that appears in neither
 * this map nor the table above, so the answer has to be written down once.
 */
export const NOT_CARRIED: Readonly<Record<string, string>> = {
  x: "the pair's from-box",
  y: "the pair's from-box",
  width: "the pair's from-box",
  height: "the pair's from-box",
  opacity: "the pair's resolved alpha",
  alpha: "a paint alias, not an element field",
  flexGrow: "a layout input, laid out fresh every frame",
  layoutGrow: "a layout input, laid out fresh every frame"
};

function scalarFrame(from: DesignElement, to: DesignElement, p: number): Record<string, unknown> {
  const a = from as unknown as Record<string, unknown>;
  const b = to as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(CARRIED)) {
    if (spec.kind === "flip") {
      const was = a[field] === true;
      const is = b[field] === true;
      // A mirror is not a length — there is no frame where a layer faces both
      // ways — so it switches at the midpoint, where the eye reads it as the
      // layer turning over rather than as a pop on the first frame.
      if (was !== is) out[field] = p < 0.5 ? was : is;
      continue;
    }
    const av = typeof a[field] === "number" ? (a[field] as number) : undefined;
    const bv = typeof b[field] === "number" ? (b[field] as number) : undefined;
    if (av === undefined && bv === undefined) continue;
    if (spec.absent === undefined && (av === undefined || bv === undefined)) continue;
    const n = lerp(av ?? spec.absent!, bv ?? spec.absent!, p);
    out[field] = spec.whole ? Math.round(n) : n;
  }
  return out;
}

/**
 * The corners, under whichever name the layer spells them.
 *
 * Shapes and containers carry `borderRadius`, polygon and star carry a px
 * `cornerRadius` — and only the second was interpolated, so a rect's rounding
 * popped on the first frame of every morph while a star's corner glided.
 */
function cornerFrame(from: DesignElement | undefined, to: DesignElement, p: number) {
  type Rounded = { borderRadius?: CornerRadius; cornerRadius?: CornerRadius };
  const a = from as Rounded | undefined;
  const b = to as Rounded;
  const out: Rounded = {};
  if (a?.borderRadius !== undefined || b.borderRadius !== undefined) {
    out.borderRadius = interpolateCornerRadius(a?.borderRadius, b.borderRadius, p);
  }
  if (a?.cornerRadius !== undefined || b.cornerRadius !== undefined) {
    out.cornerRadius = interpolateCornerRadius(a?.cornerRadius, b.cornerRadius, p);
  }
  return out;
}

/**
 * Where the incoming slide's whole surface sits at progress `p`.
 *
 * Travelling FROM an edge, so `fromRight` starts off the right and lands at 0 —
 * "direction" names where it comes from, which is what the panel's arrows say.
 */
const travel = (direction: SlideDirection, width: number, height: number) =>
  direction === "left"
    ? [-width, 0]
    : direction === "right"
      ? [width, 0]
      : direction === "up"
        ? [0, -height]
        : [0, height];

export function enterShift(direction: SlideDirection, p: number, width: number, height: number) {
  const [dx, dy] = travel(direction, width, height);
  return { x: dx * (1 - p), y: dy * (1 - p) };
}

/** Where the outgoing slide sits under the same progress: pushed out the far side. */
export function leaveShift(direction: SlideDirection, p: number, width: number, height: number) {
  const [dx, dy] = travel(direction, width, height);
  return { x: -dx * p, y: -dy * p };
}

export interface SlidePaint {
  /** Applied to the outgoing slide's own stage. */
  outShift: { x: number; y: number };
  outOpacity: number;
  /** Applied to the incoming slide's own stage. */
  inShift: { x: number; y: number };
  inOpacity: number;
  /** Whether the outgoing slide is painted at all. */
  drawOutgoing: boolean;
  /** Whether the outgoing slide is painted above the incoming one. */
  outAbove: boolean;
}

/**
 * The five transitions as one answer per frame, so the player has no branch of
 * its own to get out of step with the panel that authored them.
 *
 * `morph` paints no outgoing surface: everything that leaves is injected into
 * the incoming tree by {@link morphSlide}, which is what keeps a travelling
 * layer from being drawn twice — once sliding, once fading where it stood.
 *
 * `reversed` plays a `slide` backwards: the departing surface travels back to
 * the edge it came from while the arriving one holds, and it paints ABOVE the
 * arriving surface because it was the one covering it.
 */
export function slidePaint(
  kind: SlideTransition,
  direction: SlideDirection,
  p: number,
  width: number,
  height: number,
  reversed = false
): SlidePaint {
  switch (kind) {
    case "dissolve":
      return {
        outShift: { x: 0, y: 0 },
        outOpacity: 1 - p,
        inShift: { x: 0, y: 0 },
        inOpacity: p,
        drawOutgoing: true,
        outAbove: false
      };
    case "push":
      return {
        outShift: leaveShift(direction, p, width, height),
        outOpacity: 1,
        inShift: enterShift(direction, p, width, height),
        inOpacity: 1,
        drawOutgoing: true,
        outAbove: false
      };
    case "slide": {
      if (reversed) {
        const [dx, dy] = travel(direction, width, height);
        return {
          outShift: { x: dx * p, y: dy * p },
          outOpacity: 1,
          inShift: { x: 0, y: 0 },
          inOpacity: 1,
          drawOutgoing: true,
          outAbove: true
        };
      }
      return {
        outShift: { x: 0, y: 0 },
        outOpacity: 1,
        inShift: enterShift(direction, p, width, height),
        inOpacity: 1,
        drawOutgoing: true,
        outAbove: false
      };
    }
    case "morph":
      return {
        outShift: { x: 0, y: 0 },
        outOpacity: 0,
        inShift: { x: 0, y: 0 },
        inOpacity: 1,
        drawOutgoing: false,
        outAbove: false
      };
    default:
      return {
        outShift: { x: 0, y: 0 },
        outOpacity: 0,
        inShift: { x: 0, y: 0 },
        inOpacity: 1,
        drawOutgoing: false,
        outAbove: false
      };
  }
}

/**
 * The incoming slide, drawn as it looks at progress `p`.
 *
 * A matched layer starts where it stood on the OUTGOING slide and travels to
 * where it belongs on this one — and "where it stood" is its position WITHIN
 * that slide, not its position on the canvas.
 *
 * The canvas offset between the two slides cancels out, which is the whole
 * reason: each slide is fitted to the screen separately, and for two slides of
 * one size that fit differs by exactly the distance between them
 * (`pan = (vw - bw·z)/2 - bx·z`, so `panPrev - panTarget = -z·(prevX - targetX)`).
 * A start box that carried the slides' separation over would therefore place the
 * layer a whole slide-width outside the region being shown — it flies in from off
 * screen instead of moving from where the audience last saw it.
 *
 * A layer that only leaves is put back where it was, not appended: `order` says
 * which sibling slot it held and `parentId` which container clipped it, so a
 * full-bleed background fades out UNDER the slide arriving instead of tinting it
 * for the whole duration.
 *
 * What is painted at progress `p` is the INCOMING layer, carrying an
 * interpolated box — and an interpolated alpha when the two halves disagree
 * about one. The two halves may be different types, since the pair key is the
 * name alone: a rect that becomes an ellipse arrives as an ellipse, and no
 * renderer has to guess which of the two it is looking at.
 *
 * `p === 1` returns the slide untouched, so an idle deck renders exactly what it
 * rendered before any of this existed.
 */
export function morphSlide(
  previous: DesignElement,
  target: DesignElement,
  match: MorphMatch,
  p: number
): DesignElement {
  if (p >= 1) return target;

  const pairs = new Map<string, MorphPair>();
  for (const pair of match.pairs) pairs.set(pair.toId, pair);
  const enters = new Set(match.enters.map((e) => e.id));

  // Keyed by the INCOMING parent's id, because that is the tree being walked and
  // `parentId` names the outgoing one. Every nested exit's parent did pair — the
  // walk only recurses into matched pairs — so this maps all of them; one that
  // somehow did not falls back to the slide, where it still draws.
  const toIdOf = new Map(match.pairs.map((pair) => [pair.fromId, pair.toId]));
  const leavingByParent = new Map<string | null, MorphSolo[]>();
  for (const exit of match.exits) {
    const owner = exit.parentId === null ? null : toIdOf.get(exit.parentId) ?? null;
    const bucket = leavingByParent.get(owner);
    if (bucket) bucket.push(exit);
    else leavingByParent.set(owner, [exit]);
  }

  /**
   * `parentId` is the container that owns this list and `shift` where that
   * container currently sits within the slide, which is what rebases an exit's
   * slide-absolute box back onto it. At the top level the owner is the slide
   * itself, so the shift is nothing.
   */
  const walk = (
    list: DesignElement[],
    parentId: string | null,
    shift: { x: number; y: number }
  ): DesignElement[] => {
    const built = list.map((el) => {
      const pair = pairs.get(el.id);
      if (pair) {
        const x = lerp(pair.fromLocal.x, el.x, p);
        const y = lerp(pair.fromLocal.y, el.y, p);
        const children = (el as { children?: DesignElement[] }).children;
        // Written only when the two halves disagree: a pair whose alpha is the
        // same on both slides has to land as the layer the author drew, not as
        // one carrying a redundant `opacity: 1`.
        const opacity = pair.fromOpacity === pair.toOpacity ? null : lerp(pair.fromOpacity, pair.toOpacity, p);
        const fromEl = pair.fromEl ?? el;
        const effects = interpolateEffects(fromEl.effects, el.effects, p);

        return {
          ...el,
          x,
          y,
          width: lerp(pair.from.width, el.width, p),
          height: lerp(pair.from.height, el.height, p),
          ...(opacity === null ? null : { opacity }),
          ...(effects !== undefined ? { effects } : null),
          ...cornerFrame(fromEl, el, p),
          ...scalarFrame(fromEl, el, p),
          ...appearanceFrame(fromEl, el, p),
          // A pair that is one line on both slides paints one line all the way:
          // the box and the run are interpolated on different paths, so the
          // browser can break the paragraph at a width neither slide breaks at,
          // and the count flickers. See `MorphPair.oneLine`.
          ...(pair.oneLine ? { noSoftWrap: true } : null),
          ...(children ? { children: walk(children, el.id, { x, y }) } : null)
        } as DesignElement;
      }
      if (enters.has(el.id)) return { ...el, opacity: (el.opacity ?? 1) * p };
      return el;
    });

    // A layer that only leaves goes back where it stood rather than to the end
    // of the list: `order` is the sibling slot it held, so a full-bleed
    // background fades out UNDER the slide arriving instead of over it.
    const bucket = leavingByParent.get(parentId);
    if (!bucket || bucket.length === 0) return built;
    const out = [...built];
    for (const exit of [...bucket].sort((a, b) => a.order - b.order)) {
      out.splice(Math.min(exit.order, out.length), 0, {
        ...exit.el,
        x: exit.box.x - shift.x,
        y: exit.box.y - shift.y,
        opacity: (exit.el.opacity ?? 1) * (1 - p)
      } as DesignElement);
    }
    return out;
  };

  const targetChildren = (target as ContainerElement).children ?? [];
  const targetEffects = interpolateEffects(previous.effects, target.effects, p);

  return {
    ...target,
    ...(targetEffects !== undefined ? { effects: targetEffects } : null),
    ...cornerFrame(previous, target, p),
    ...scalarFrame(previous, target, p),
    ...appearanceFrame(previous, target, p),
    children: walk(targetChildren, null, ORIGIN)
  } as DesignElement;
}
