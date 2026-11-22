import { useEffect, useState } from "preact/hooks";
import { ColorNotation, COLOR_NOTATIONS } from "../color-model";

const STORAGE_KEY = "fish_color_notation";

const isNotation = (raw: string | null): raw is ColorNotation =>
  raw !== null && (COLOR_NOTATIONS as string[]).includes(raw);

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

    }
  }, [notation]);

  return [notation, setNotation];
}