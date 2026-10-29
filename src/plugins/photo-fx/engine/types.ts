import type { FilmPresetId } from "./film";

export type FxCategory = "print" | "film" | "glitch" | "mosaic";

export type PatternMode = "dots" | "lines" | "bars" | "crosshatch" | "dither";

export type DitherAlgorithm = "bayer4" | "bayer8" | "floyd" | "atkinson";

export type ColorMode = "duotone" | "original";

export type TransitionMode = "none" | "horizontal" | "vertical" | "twoEnds" | "radial";

export type TransitionBlend = "overlay" | "reveal" | "fade";

export interface ColorPreset {
  id: string;
  dark: string;
  light: string;
}

export interface PhotoFxOptions {
  fxCategory: FxCategory;
  // Print Mode options
  mode: PatternMode;
  ditherAlgo: DitherAlgorithm;
  gridSize: number; // 4 to 40
  angle: number; // in degrees, e.g. 45
  contrast: number; // 0.5 to 2.5
  barLevel: number; // 0.2 to 1: the tone that prints solid, i.e. how much of the image gets ink
  barFalloff: number; // 0.5 to 8: how fast bar width falls off above barLevel (higher = threshold-like)
  invert: boolean;
  colorMode: ColorMode;
  darkColor: string; // hex color e.g. #381b35
  lightColor: string; // hex color e.g. #f6f4f5
  transparentBg: boolean;
  transitionMode: TransitionMode;
  transitionBlend: TransitionBlend;
  transitionSpread: number; // 0.1 to 1.0
  transitionInvert: boolean;
  // Film options
  filmPreset: FilmPresetId;
  filmGrain: number; // 0 to 100
  filmVignette: number; // 0 to 100
  filmWarmth: number; // -50 to 50
  filmFade: number; // 0 to 50
  filmLightLeak: number; // 0 to 100
  // Glitch options
  rgbSplit: number; // 0 to 50
  scanlines: number; // 0 to 100
  sliceShift: number; // 0 to 50
  // Mosaic options
  mosaicBlockSize: number; // 2 to 64
}

export type RetroPrintOptions = PhotoFxOptions;

export const COLOR_PRESETS: ColorPreset[] = [
  { id: "violet", dark: "#381b35", light: "#f6f4f5" }, // Editorial Violet (matches sample)
  { id: "mono", dark: "#18181b", light: "#fafafa" },   // Classic Mono
  { id: "cyber", dark: "#091226", light: "#00f0ff" },  // Cyber Neon
  { id: "riso", dark: "#003b6d", light: "#ff6040" },   // Risograph Blue/Orange
  { id: "emerald", dark: "#0c281e", light: "#e7f4eb" } // Vintage Emerald
];

export const DEFAULT_OPTIONS: PhotoFxOptions = {
  fxCategory: "print",
  mode: "dots",
  ditherAlgo: "floyd",
  gridSize: 10,
  angle: 45,
  contrast: 1.1,
  barLevel: 0.78,
  barFalloff: 2.2,
  invert: false,
  colorMode: "duotone",
  darkColor: "#381b35",
  lightColor: "#f6f4f5",
  transparentBg: false,
  transitionMode: "none",
  transitionBlend: "overlay",
  transitionSpread: 0.5,
  transitionInvert: false,
  filmPreset: "classic35",
  filmGrain: 30,
  filmVignette: 20,
  filmWarmth: 8,
  filmFade: 12,
  filmLightLeak: 0,
  rgbSplit: 8,
  scanlines: 30,
  sliceShift: 15,
  mosaicBlockSize: 12
};
