import { EdgeInsets, EdgeProfile, EdgeSide, TearEffect, TearForm } from "../types";
import { EDGE_SIDES, EDGE_PROFILES, TEAR_FORMS } from "../schema-enums";
import { EDGE_DEFAULT } from "../../geometry/edge";
import { edgeScaleOf, profileDefaults } from "../../geometry/edge-profiles";
import { asBoolean, asNumber } from "./shared";

/**
 * A tear, clamped into what the renderer can honour.
 *
 * A `side` the engine does not know refuses the whole effect rather than
 * guessing one: a break on an edge that does not exist is not a break, and
 * picking one would cut a layer along a line its author never named. An unknown
 * `profile` falls back to `torn` instead, because that is what every break
 * written before profiles existed already was.
 *
 * `seed` defaults to 1, NOT to a random number. Randomness belongs to creating
 * the effect (the panel does that once, and the value is written down); a
 * normalizer that rolled dice would make the same file break differently on
 * every load, and would disagree with an export made a second earlier.
 *
 * Only a field the chosen PROFILE owns is written. A scallop is fully described
 * by `scale`, so carrying a `roughness` it cannot read would let two documents
 * look identical and differ.
 *
 * The three FORMS are different: they share one slot, and the settings of the
 * form that is not showing are kept. An edge keeps its `inset` and a loop keeps
 * its `side`/`at`, so flipping between them in the inspector is lossless. The
 * panel is what hides the fields that do not apply.
 *
 * The retired spellings are read as aliases, not refused: `type: "edge"` is the
 * same effect under its old name, `hole: "cut"` is `form: "hole"`, and
 * `hole: "scrap"` is `form: "scrap"`.
 */
export function normalizeTear(raw: unknown): TearEffect | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const form = parseForm(r);
  const loop = form === "hole" || form === "scrap";

  const sideRaw = r.side;
  const side =
    typeof sideRaw === "string" && EDGE_SIDES.includes(sideRaw as EdgeSide) ? (sideRaw as EdgeSide) : undefined;
  // An edge needs a side. A loop does not — and a side it still carries is the
  // edge's setting, kept so flipping between the forms costs nothing.
  if (!loop && side === undefined) return undefined;

  const profile =
    typeof r.profile === "string" && EDGE_PROFILES.includes(r.profile as EdgeProfile)
      ? (r.profile as EdgeProfile)
      : "torn";
  const defaults = profileDefaults(profile);

  const scaleNum = asNumber(r.scale);
  const roughnessNum = asNumber(r.roughness);
  const fiberNum = asNumber(r.fiber);
  const seedNum = asNumber(r.seed);
  const at = parseAt(r.at);
  const scale = scaleNum === undefined ? EDGE_DEFAULT.scale : edgeScaleOf(scaleNum);
  const seed = seedNum === undefined ? 1 : Math.round(seedNum);
  const enabled = asBoolean(r.enabled) ?? true;

  // The two forms SHARE a document slot: whichever one is showing, the other's
  // settings ride along untouched, and the panel is what hides them. Dropping
  // them here would make a flip through the other form lose the author's work.
  const sideField = side === undefined ? {} : { side };
  const atField = at === undefined ? {} : { at };
  const inset = parseInset(r.inset);
  const insetField = inset === undefined ? {} : { inset };
  const formField = form === undefined || form === "edge" ? {} : { form };

  // Each profile takes exactly the fields it owns, so narrowing on `profile`
  // downstream is enough to know which of them exist and no document carries a
  // value its own break cannot read.
  switch (profile) {
    case "scallop":
    case "zigzag":
      return {
        type: "tear",
        profile,
        ...sideField,
        scale,
        seed,
        ...atField,
        ...insetField,
        ...formField,
        enabled
      };
    default:
      return {
        type: "tear",
        profile,
        ...sideField,
        scale,
        roughness: clamp(roughnessNum ?? defaults.roughness, 0, 1),
        fiber: clamp(fiberNum ?? defaults.fiber, 0, 1),
        seed,
        ...atField,
        ...insetField,
        ...formField,
        enabled
      };
  }
}

/**
 * The same break under a different profile.
 *
 * Fields the old profile owned and the new one does not are dropped rather than
 * carried, and the new profile's own fields come back at its defaults — so
 * switching scallop → torn does not silently leave a scallop's absence of
 * `roughness` in charge of the break, and switching back restores what the user
 * had reason to expect. Everything the two shares moves across untouched.
 */
export function tearWithProfile(ef: TearEffect, profile: EdgeProfile): TearEffect {
  const defaults = profileDefaults(profile);
  const shared = {
    type: "tear" as const,
    scale: ef.scale,
    seed: ef.seed,
    ...(ef.side !== undefined ? { side: ef.side } : {}),
    ...(ef.at !== undefined ? { at: ef.at } : {}),
    ...(ef.form !== undefined ? { form: ef.form } : {}),
    ...(ef.inset !== undefined ? { inset: ef.inset } : {}),
    ...(ef.enabled !== undefined ? { enabled: ef.enabled } : {}),
    ...(ef.tokenId !== undefined ? { tokenId: ef.tokenId } : {}),
    ...(ef.tokenBindings !== undefined ? { tokenBindings: ef.tokenBindings } : {})
  };
  switch (profile) {
    case "scallop":
    case "zigzag":
      return { ...shared, profile };
    default:
      return {
        ...shared,
        profile,
        roughness: defaults.roughness,
        fiber: defaults.fiber
      };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A loop's margins, as percentages: one number, or `[top, right, bottom, left]`.
 *
 * A four-tuple that is not four numbers is not a margin set, so it is dropped
 * whole rather than half-read — the same rule that drops an unknown `side`.
 */
function parseInset(raw: unknown): number | EdgeInsets | undefined {
  if (Array.isArray(raw)) {
    if (raw.length !== 4) return undefined;
    const nums = raw.map((v) => asNumber(v));
    if (nums.some((v) => v === undefined)) return undefined;
    return (nums as number[]).map((v) => clamp(v, 0, 100)) as EdgeInsets;
  }
  const one = asNumber(raw);
  return one === undefined ? undefined : clamp(one, 0, 100);
}

/**
 * Which form this tear is, reading the retired spellings.
 *
 * `form` wins when it is one of the three; otherwise `hole: true` / `hole: "cut"`
 * are the loop form and `hole: "scrap"` is the scrap. Anything else is the edge
 * form, which is what a tear was before the other two existed.
 */
function parseForm(r: Record<string, unknown>): TearForm | undefined {
  if (typeof r.form === "string" && TEAR_FORMS.includes(r.form as TearForm)) return r.form as TearForm;
  if (r.hole === true || r.hole === "cut" || r.hole === "hole") return "hole";
  if (r.hole === "scrap") return "scrap";
  return undefined;
}

/**
 * Where the break sits across its axis: one position, or one per end.
 *
 * A pair that is not two numbers is not a tilt, so it is dropped whole and the
 * break stays parallel to its edge — the same rule that drops an unknown `side`.
 */
function parseAt(raw: unknown): number | [number, number] | undefined {
  if (Array.isArray(raw)) {
    if (raw.length !== 2) return undefined;
    const a = asNumber(raw[0]);
    const b = asNumber(raw[1]);
    if (a === undefined || b === undefined) return undefined;
    return [clamp(a, 0, 1), clamp(b, 0, 1)];
  }
  const one = asNumber(raw);
  return one === undefined ? undefined : clamp(one, 0, 1);
}
