import { useEffect, useState } from "preact/hooks";
import { ColorNotation, COLOR_NOTATIONS } from "../color-model";

const STORAGE_KEY = "fish_color_notation";

const isNotation = (raw: string | null): raw is ColorNotation =>
  raw !== null && (COLOR_NOTATIONS as string[]).includes(raw);

/**
 * Which notation the colour panel names a colour in.
 *
 * Persisted rather than local state because the panel is mounted only while it is
 * open: without this the notation resets to HEX every time a swatch is clicked,
 * so a user who works in HSB re-picks it for every colour they touch. It is a
 * preference about the SHELL, not about the document, so it stays in localStorage
 * rather than becoming a stored value — changing what a document holds is a
 * dialect change (`AGENTS.md` §10), and this changes nothing.
 */
export function useColorNotation(): [ColorNotation, (next: ColorNotation) => void] {
  const [notation, setNotation] = useState<ColorNotation>(() => {
    try {
      const raw = window.localStorage?.getItem(STORAGE_KEY) ?? null;
      return isNotation(raw) ? raw : "hex";
    } catch {
      return "hex";
    }
  });

  useEffect(() => {
    try {
      window.localStorage?.setItem(STORAGE_KEY, notation);
    } catch {
      // A shell served from a locked-down profile cannot write; the notation is
      // still correct for this session.
    }
  }, [notation]);

  return [notation, setNotation];
}