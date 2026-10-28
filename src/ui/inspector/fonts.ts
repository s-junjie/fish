import { cssFamilyName, isGenericFamily } from "../../core/font-stack";

export interface FontOption {
  id: string;
  label: string;
  isLocal: boolean;
}

const SORTER = new Intl.Collator(undefined, { sensitivity: "base" });

/**
 * `id` is the family the document will STORE — the bare name, not a stack.
 *
 * The fallback used to live in the id (`"Inter, sans-serif"`), so every family
 * picked from this menu went into the file already carrying a generic. That made
 * the one thing the stack was supposed to record unwritable: whether the machine
 * has the face. `resolveStack` appends the fallback at paint time instead.
 */
export const PRESET_FONTS: FontOption[] = [
  { id: "Inter", label: "Inter", isLocal: false },
  { id: "Roboto", label: "Roboto", isLocal: false },
  { id: "system-ui", label: "System UI", isLocal: false },
  { id: "Helvetica Neue", label: "Helvetica", isLocal: false },
  { id: "Arial", label: "Arial", isLocal: false },
  { id: "Georgia", label: "Georgia", isLocal: false },
  { id: "Times New Roman", label: "Times New Roman", isLocal: false },
  { id: "Courier New", label: "Courier New", isLocal: false },
  { id: "Menlo", label: "Menlo", isLocal: false }
];

export function firstFamily(value: string): string {
  const raw = (value || "").split(",")[0].trim();
  return raw.replace(/^(["'])(.*)\1$/, "$2");
}

export function localFamilyOption(family: string): FontOption {
  return { id: cssFamilyName(family), label: family, isLocal: true };
}

export function buildFontOptions(current: string, localFamilies: string[] | null): FontOption[] {
  // A preset whose face is not installed draws as something else, so offering it
  // promises a font the document cannot have — the list said "Inter" while the
  // screen showed Helvetica. `null` and `[]` both mean the platform has not
  // given us a list: `[]` is what a refused or unsupported `queryLocalFonts`
  // returns, and filtering against it would blank the picker exactly when the
  // "preset list shown" notice appears.
  const installed =
    localFamilies && localFamilies.length > 0
      ? new Set(localFamilies.map((family) => firstFamily(family).toLowerCase()))
      : null;

  const byFirst = new Map<string, FontOption>();
  for (const preset of PRESET_FONTS) {
    const name = firstFamily(preset.id);
    const lower = name.toLowerCase();
    // A generic preset never appears in the platform's list — `system-ui` is an
    // alias, not a family — so filtering by name alone would delete the one
    // preset that cannot lie about being installed.
    if (installed && !isGenericFamily(lower) && !installed.has(lower)) continue;
    byFirst.set(name, preset);
  }
  if (localFamilies) {
    for (const fam of localFamilies) {
      const key = firstFamily(fam);
      if (!byFirst.has(key)) byFirst.set(key, localFamilyOption(fam));
    }
  }
  const currentFirst = firstFamily(current);
  if (currentFirst && !byFirst.has(currentFirst)) {
    byFirst.set(currentFirst, { id: current, label: currentFirst, isLocal: false });
  }
  return [...byFirst.values()].sort((a, b) => SORTER.compare(a.label, b.label));
}

export function currentLabel(options: FontOption[], current: string): string {
  const currentFirst = firstFamily(current);
  const match = options.find((o) => {
    if (o.id === current) return true;
    if (o.label === current) return true;
    return currentFirst !== "" && firstFamily(o.id) === currentFirst;
  });
  return match ? match.label : currentFirst || current;
}

// Reading the platform's font list is one shared, permission-gated call — see
// `core/fonts/local-font-access.ts`. This module only decides what a family list
// means once the platform has answered; it never asks.