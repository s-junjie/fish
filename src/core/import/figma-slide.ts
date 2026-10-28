/**
 * Figma's slide transition → the DSL's `SlideSpec`.
 *
 * Both hang the spec on the slide it LEAVES: Figma's own help says the curve
 * "determines the acceleration of the transition between the current slide and
 * the next slide", and every style is worded as "the next slide moves in" /
 * "the previous slide moves out". So a transition on slide N is the N→N+1
 * animation and lands on slide N's spec unchanged.
 *
 * Only five families, so most styles are exact:
 *
 *   DISSOLVE                 → dissolve   the next fades in over the previous
 *   MOVE_IN_FROM_X           → slide      the next moves in, the previous stays
 *   PUSH_FROM_X              → push       the next pushes the previous out
 *   SLIDE_IN_FROM_X          → slide      …plus a fade of the previous, which FISH
 *                                         has no term for (named below)
 *   SLIDE_OUT_TO_X / MOVE_OUT_TO_X → push the previous moves out and the next is
 *                                         revealed. FISH cannot say "the arriving
 *                                         frame does not move", so the closest is
 *                                         a push with the direction mirrored, and
 *                                         the difference is named.
 *   SMART_ANIMATE            → morph      FISH's own name for the same idea
 *
 * Directions are in the style NAME on Figma's side and a field on ours, and
 * `direction` means where the arriving frame comes FROM — so `FROM_LEFT` is
 * `left` while `OUT_TO_LEFT` (the departing frame leaves leftward) is `right`.
 */

import type { SlideDirection, SlideEasing, SlideSpec } from "../dsl/types";

export interface FigmaSlideTransition {
  style?: string;
  /** Seconds, 0.01–10. */
  duration?: number;
  curve?: string;
  timing?: { type?: string; delay?: number };
}

export interface MappedSlideTransition {
  spec?: SlideSpec;
  /** What could not be written down: a gap property and the sentence for it. */
  gaps: Array<{ property: string; value: string }>;
}

const FROM_DIRECTION: Record<string, SlideDirection> = {
  LEFT: "left",
  RIGHT: "right",
  TOP: "up",
  BOTTOM: "down"
};

const OPPOSITE: Record<SlideDirection, SlideDirection> = {
  left: "right",
  right: "left",
  up: "down",
  down: "up"
};

const CURVES: Record<string, SlideEasing> = {
  LINEAR: "linear",
  EASE_IN: "ease-in",
  EASE_OUT: "ease-out",
  EASE_IN_AND_OUT: "ease-in-out",
  // The rest are Figma's feel-based presets and spring overshoots, and our four
  // are what they land on. Each is named, because "gentle" arriving as a symmetric
  // ease is a difference someone can see.
  GENTLE: "ease-in-out",
  SLOW: "ease-in-out",
  QUICK: "ease-out",
  BOUNCY: "ease-out",
  EASE_IN_BACK: "ease-in",
  EASE_OUT_BACK: "ease-out",
  EASE_IN_AND_OUT_BACK: "ease-in-out"
};

const EXACT_CURVES = new Set(["LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT"]);

/** FISH clamps at ten seconds, which is Figma's own ceiling for a transition. */
const MAX_DURATION_MS = 10000;

const DIRECTIONAL = /^(SLIDE|PUSH|MOVE)_(FROM|OUT_TO)_(LEFT|RIGHT|TOP|BOTTOM)$/;

export function mapFigmaSlideTransition(raw: FigmaSlideTransition | undefined): MappedSlideTransition {
  const gaps: MappedSlideTransition["gaps"] = [];
  const style = typeof raw?.style === "string" ? raw.style : "";
  const spec: SlideSpec = {};

  if (style && style !== "NONE") {
    const directional = DIRECTIONAL.exec(style);
    if (directional) {
      const [, family, end, edge] = directional;
      const from = FROM_DIRECTION[edge];
      // `OUT_TO_X` moves the DEPARTING frame; `direction` names where the arriving
      // one comes from, which is the far side — hence the mirror.
      const out = end === "OUT_TO";
      spec.transition = family === "PUSH" || out ? "push" : "slide";
      spec.direction = out ? OPPOSITE[from] : from;
      if (family === "SLIDE" && !out) {
        gaps.push({
          property: `slide:style:${style}`,
          value:
            "Figma's slide-in also fades the slide it replaces; FISH's slide leaves it standing, so the arriving frame slides over a still one"
        });
      }
      if (out) {
        gaps.push({
          property: `slide:style:${style}`,
          value:
            "Figma moves the slide it replaces and leaves the arriving one still; FISH has no such mode, so this arrives as a push and both frames move"
        });
      }
    } else if (style === "DISSOLVE") {
      spec.transition = "dissolve";
    } else if (style === "SMART_ANIMATE") {
      spec.transition = "morph";
    } else {
      gaps.push({
        property: `slide:style:${style}`,
        value: "this transition style has no FISH counterpart, so the frame arrives with no animation"
      });
    }
  }

  // A duration and a curve are spent BY a transition. With no style there is
  // nothing to animate — `resolveSlide` reads a spec without one as a cut and
  // zeroes the duration — so a spec carrying only numbers would be written into
  // the document, read back as a cut, and outlive every later edit to that slide.
  const curve = typeof raw?.curve === "string" ? raw.curve : "";
  if (spec.transition && curve) {
    const easing = CURVES[curve];
    if (easing) spec.easing = easing;
    if (easing && !EXACT_CURVES.has(curve)) {
      gaps.push({
        property: `slide:curve:${curve}`,
        value: `Figma's "${curve.toLowerCase()}" curve is one of its feel-based presets; FISH has four curves, so this one is approximated`
      });
    }
  }

  if (spec.transition && typeof raw?.duration === "number" && Number.isFinite(raw.duration) && raw.duration > 0) {
    spec.durationMs = Math.min(MAX_DURATION_MS, Math.round(raw.duration * 1000));
  }

  // Auto-advance is the one thing here with nowhere to go, and it is worth saying
  // even on a slide with no animation: a `SlideSpec` says how a frame leaves, not
  // how long it waits before leaving, so a self-advancing deck will sit there
  // waiting for a click.
  const timing = raw?.timing;
  if (timing && timing.type === "AFTER_DELAY") {
    gaps.push({
      property: "slide:timing:AFTER_DELAY",
      value: "this slide advances on a timer, and FISH only advances on a click, so the deck will wait"
    });
  }

  return { ...(Object.keys(spec).length > 0 ? { spec } : {}), gaps };
}
