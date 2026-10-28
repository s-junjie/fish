import { SlideDirection, SlideEasing, SlideSpec, SlideTransition } from "../dsl/types";

/**
 * A deck is watched once, by an audience, from the back of a room. The
 * workbench's own motion scale is for feedback someone holds all day, which is
 * why it tops out at 260ms — nothing here takes a value from it.
 */
export const DEFAULT_SLIDE_MS = 600;

export interface ResolvedSlide {
  transition: SlideTransition;
  durationMs: number;
  easing: SlideEasing;
  direction: SlideDirection;
  /**
   * True when the edge is played backwards: the departing slide moves out and
   * the arriving one holds. That is what `slide` needs, because its forward
   * composition moves only the arriving surface — mirroring the direction would
   * make the previous slide slide in over the current one instead.
   */
  reversed: boolean;
}

/**
 * One answer to "how this slide's edge plays", with the defaults filled in, so
 * every consumer reads the same numbers. `durationMs` 0 means cut however it
 * was arrived at — including `morph` with no pairs, where there is nothing to
 * animate.
 */
export function resolveSlide(spec: SlideSpec | undefined): ResolvedSlide {
  const transition = spec?.transition ?? "none";
  return {
    transition,
    durationMs: transition === "none" ? 0 : Math.max(0, spec?.durationMs ?? DEFAULT_SLIDE_MS),
    easing: spec?.easing ?? "ease-in-out",
    direction: spec?.direction ?? "right",
    reversed: false
  };
}

/** The same edge seen from the other end. */
export function reverseDirection(direction: SlideDirection): SlideDirection {
  switch (direction) {
    case "left":
      return "right";
    case "right":
      return "left";
    case "up":
      return "down";
    case "down":
      return "up";
  }
}

/**
 * The transition one step plays. A slide declares the edge that LEAVES it, so
 * going forward reads the departing slide; stepping back over the same edge
 * replays the arriving slide's declaration.
 *
 * A `push` moves both surfaces, so mirroring its direction is already the same
 * animation run backwards. A `slide` does not — forward holds the departing
 * surface still while the next one slides over it — so reversing it must move
 * the departing surface back out, which `reversed` tells the painter to do.
 */
export function resolveStep(
  arriving: SlideSpec | undefined,
  departing: SlideSpec | undefined,
  backwards: boolean
): ResolvedSlide {
  const base = resolveSlide(backwards ? arriving : departing);
  if (!backwards) return base;
  if (base.transition === "push") return { ...base, direction: reverseDirection(base.direction) };
  if (base.transition === "slide") return { ...base, reversed: true };
  return base;
}

/** Monotonic on 0..1, with f(0)=0 and f(1)=1 — the only contract a caller needs. */
export function easeAt(easing: SlideEasing, t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  switch (easing) {
    case "linear":
      return x;
    case "ease-in":
      return x * x;
    case "ease-out":
      return x * (2 - x);
    case "ease-in-out":
      return x * x * (3 - 2 * x);
  }
}

export interface SlideClock {
  /** A transition is on screen. This is what a player reads to swallow input. */
  readonly active: boolean;
  begin(now: number, durationMs: number, easing: SlideEasing): void;
  /** Eased progress 0..1. Reaching 1 ends the transition and clears `active`. */
  advance(now: number): number;
  cancel(): void;
}

/**
 * The transition's own clock, deliberately without a timer of its own: `now` is
 * handed in, so a caller drives it from rAF or from a test without either side
 * mocking the wall clock.
 *
 * A zero duration never runs — `begin` leaves `active` false and `advance`
 * returns 1, which is what makes a cut and a finished transition the same state
 * instead of two branches every consumer has to write.
 */
export function createSlideClock(): SlideClock {
  let startedAt = 0;
  let durationMs = 0;
  let easing: SlideEasing = "ease-in-out";
  let running = false;

  return {
    get active() {
      return running;
    },
    begin(now, ms, curve) {
      durationMs = Math.max(0, ms);
      easing = curve;
      if (durationMs === 0) {
        running = false;
        return;
      }
      startedAt = now;
      running = true;
    },
    advance(now) {
      if (!running) return 1;
      const raw = (now - startedAt) / durationMs;
      if (raw >= 1) {
        running = false;
        return 1;
      }
      return easeAt(easing, raw < 0 ? 0 : raw);
    },
    cancel() {
      running = false;
    }
  };
}
