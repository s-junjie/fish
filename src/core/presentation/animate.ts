import { ContainerElement, CornerRadius, DesignElement, SlideDirection, SlideTransition } from "../dsl/types";
import { MorphMatch, MorphPair, MorphSolo } from "./morph";
import { interpolateCornerRadius, interpolateEffects } from "./interpolate-effects";

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

const ORIGIN = { x: 0, y: 0 };

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
        const x = lerp(pair.from.x, el.x, p);
        const y = lerp(pair.from.y, el.y, p);
        const children = (el as { children?: DesignElement[] }).children;
        // Written only when the two halves disagree: a pair whose alpha is the
        // same on both slides has to land as the layer the author drew, not as
        // one carrying a redundant `opacity: 1`.
        const opacity = pair.fromOpacity === pair.toOpacity ? null : lerp(pair.fromOpacity, pair.toOpacity, p);
        const fromEl = pair.fromEl;
        const effects = interpolateEffects(fromEl?.effects, el.effects, p);
        const fromCr = (fromEl as { cornerRadius?: CornerRadius } | undefined)?.cornerRadius;
        const toCr = (el as { cornerRadius?: CornerRadius }).cornerRadius;
        const cornerRadius =
          fromCr !== undefined || toCr !== undefined ? interpolateCornerRadius(fromCr, toCr, p) : undefined;
        const rotation =
          fromEl?.rotation !== undefined || el.rotation !== undefined
            ? lerp(fromEl?.rotation ?? 0, el.rotation ?? 0, p)
            : undefined;

        return {
          ...el,
          x,
          y,
          width: lerp(pair.from.width, el.width, p),
          height: lerp(pair.from.height, el.height, p),
          ...(opacity === null ? null : { opacity }),
          ...(effects !== undefined ? { effects } : null),
          ...(cornerRadius !== undefined ? { cornerRadius } : null),
          ...(rotation !== undefined ? { rotation } : null),
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
  const prevCr = (previous as { cornerRadius?: CornerRadius }).cornerRadius;
  const targetCr = (target as { cornerRadius?: CornerRadius }).cornerRadius;
  const cornerRadius =
    prevCr !== undefined || targetCr !== undefined ? interpolateCornerRadius(prevCr, targetCr, p) : undefined;
  const rotation =
    previous.rotation !== undefined || target.rotation !== undefined
      ? lerp(previous.rotation ?? 0, target.rotation ?? 0, p)
      : undefined;

  return {
    ...target,
    ...(targetEffects !== undefined ? { effects: targetEffects } : null),
    ...(cornerRadius !== undefined ? { cornerRadius } : null),
    ...(rotation !== undefined ? { rotation } : null),
    children: walk(targetChildren, null, ORIGIN)
  } as DesignElement;
}
