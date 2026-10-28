import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ELEMENT_TYPES,
  EFFECT_TYPES,
  PAINT_TYPES,
  BLEND_MODES
} from "../src/core/dsl/schema-enums";

/**
 * The "derive, don't restate" half of the testing rule.
 *
 * A rig that copies the list it grades cannot report a gap in that list: add a
 * member to the union and every hand-written copy still passes, because the
 * copy never knew about it. bento lost a language for a year this way — a
 * locale list transcribed into four files, one of them a language short. Here
 * the lists are imported from `schema-enums.ts`, which is the same runtime
 * table `normalize` reads, so a new member is graded the moment it exists.
 *
 * The other half of the rule — a rig must actually be run — is in
 * `tests/rig-registration.test.ts`.
 *
 * Each surface below is a place that switches over a closed union. Adding a
 * surface is a deliberate act: it is a claim that a member with no case there
 * is a defect rather than a choice, which is why `shadow-silhouette.ts` is not
 * on this list (line and arrow cast no silhouette) and `SvgNodeRenderer` is.
 */
const REPO = join(__dirname, "..");

const SURFACES: { union: string; members: readonly string[]; file: string; why: string }[] = [
  {
    union: "ELEMENT_TYPES",
    members: ELEMENT_TYPES,
    file: "src/ui/canvas/SvgNodeRenderer.tsx",
    why: "a type with no branch renders nothing, and the user sees a blank canvas rather than an error"
  },
  {
    union: "ELEMENT_TYPES",
    members: ELEMENT_TYPES,
    file: "src/ui/layers/layer-icons.tsx",
    why: "a type with no icon falls through to the generic square and reads as the user's own mistake"
  },
  {
    union: "ELEMENT_TYPES",
    members: ELEMENT_TYPES,
    file: "src/core/dsl/normalize/element-branches/index.ts",
    why: "a type with no branch in the dispatch table is never normalized and keeps whatever a hand-edited file put in it"
  },
  {
    union: "EFFECT_TYPES",
    members: EFFECT_TYPES,
    file: "src/ui/canvas/effect-filter-def.tsx",
    why: "an effect with no filter def is a drop-shadow that silently does not paint"
  },
  {
    union: "EFFECT_TYPES",
    members: EFFECT_TYPES,
    file: "src/core/geometry/scale-geometry.ts",
    why: "an effect that does not scale keeps its size and drifts away from the box it belongs to"
  },
  {
    union: "EFFECT_TYPES",
    members: EFFECT_TYPES,
    file: "src/ui/EffectRows.tsx",
    why: "an effect with no row cannot be edited or removed once applied"
  },
  {
    union: "PAINT_TYPES",
    members: PAINT_TYPES,
    file: "src/ui/paint-kind.ts",
    why: "a paint kind the picker does not know cannot be chosen from the inspector"
  },
  {
    union: "PAINT_TYPES",
    members: PAINT_TYPES,
    file: "src/core/geometry/gradient-utils.ts",
    why: "a gradient kind with no geometry exports with the stops in the wrong place"
  },
  {
    union: "BLEND_MODES",
    members: BLEND_MODES,
    file: "src/core/import/figma-paint.ts",
    why: "a blend mode with no mapping imports as normal, which is a silent fidelity loss"
  }
];

describe("closed unions are graded against the source, not a copy", () => {
  it("has unions worth grading, so an import that resolves empty cannot pass", () => {
    for (const surface of SURFACES) expect(surface.members.length).toBeGreaterThan(2);
  });

  it("names each surface's file, so a deleted file fails rather than skips", () => {
    for (const surface of SURFACES) {
      expect(() => readFileSync(join(REPO, surface.file), "utf-8"), surface.file).not.toThrow();
    }
  });

  for (const surface of SURFACES) {
    it(`${surface.file} handles every ${surface.union} member`, () => {
      const source = readFileSync(join(REPO, surface.file), "utf-8");
      const missing = surface.members.filter((member) => !source.includes(`"${member}"`));
      expect(missing, `${surface.why}`).toEqual([]);
    });
  }
});
