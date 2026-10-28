import type { BlendMode } from "../types";
import { BLEND_MODES } from "../schema-enums";
import { canonicalKey, isPlainObject, NormalizationRepair, RepairKind } from "./shared";

/**
 * The vocabulary, from the one runtime copy of it (`schema-enums.BLEND_MODES`,
 * which `tests/version-consistency.test.ts` holds against `fish.schema.json`).
 *
 * This module used to carry its own table, and it knew four of the sixteen
 * modes — so `blendMode: "difference"`, which the schema publishes, the renderer
 * paints and the Figma importer writes, was dropped on the way in.
 */
const CANONICAL_BLEND_MODES: ReadonlySet<string> = new Set(BLEND_MODES);

/**
 * The spellings that are not the mode's own name: CSS/SVG compositing keywords,
 * and Figma's two `linear-*` names for the dodge/burn pair. The canonical names
 * need no entry — `readBlendMode` reads them off the vocabulary above.
 *
 * `linear-dodge` points at `plus-lighter` because that IS linear dodge — CSS's
 * additive mode. It pointed at `color-dodge`, a division, which is a different
 * function wearing a similar name.
 */
export const BLEND_MODE_ALIASES: Record<string, BlendMode> = {
  "source-over": "normal",
  passthrough: "normal",
  "pass-through": "normal",
  // Figma writes this mode `MultiplyBlend`; `canonicalKey` splits the camel
  // boundary to `multiply-blend`.
  "multiply-blend": "multiply",
  "linear-burn": "color-burn",
  "linear-dodge": "plus-lighter"
};

/** The spellings a blend mode is written under — the same three on an element
    and on a paint layer, which is what `dsl.md` §11 publishes. `mix-blend-mode`
    is CSS's own name for exactly this value; without it an author's nearest
    spelling was refused as an unknown property. */
const BLEND_KEYS: readonly string[] = ["blendMode", "blend", "mix-blend-mode"];

/** What a written blend field turned out to be. */
export interface BlendModeReading {
  mode?: BlendMode;
  /** The value the author wrote, when it names no mode the DSL knows. */
  refused?: string;
}

/**
 * Reports a refused blend field, if there was one.
 *
 * One place owns the sentence because an element and a paint layer refuse the
 * same vocabulary, and two spellings of the same message is how they drift.
 */
export function reportRefusedBlendMode(
  reading: BlendModeReading,
  kind: RepairKind,
  path: string,
  repairs: NormalizationRepair[]
): void {
  if (!reading.refused) return;
  repairs.push({
    kind,
    path,
    message: `blendMode "${reading.refused}" is unsupported`
  });
}

/**
 * Reads the blend field of a raw object — the mode it names, or what it said
 * instead of a mode.
 *
 * Keeping those two apart is the whole point: both used to come back as
 * `undefined`, so a refusal was indistinguishable from silence and the value
 * vanished without a repair — the one outcome an author cannot detect. A value
 * that is not a string at all counts as a refusal for the same reason: it was
 * written, and the layer does not have it.
 */
export function readBlendMode(raw: unknown): BlendModeReading {
  if (!isPlainObject(raw)) return {};
  for (const key of BLEND_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      const written = canonicalKey(value);
      // Membership is checked before the cast, so the vocabulary and the type
      // cannot drift apart without failing a test at the seam.
      if (CANONICAL_BLEND_MODES.has(written)) return { mode: written as BlendMode };
      const alias = BLEND_MODE_ALIASES[written];
      if (alias) return { mode: alias };
    }
    const refused = String(value).trim();
    if (refused) return { refused };
  }
  return {};
}
