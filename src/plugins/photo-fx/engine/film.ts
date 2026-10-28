export type FilmPresetId =
  | "classic35"
  | "kodakGold"
  | "fujiVelvia"
  | "triX400"
  | "instantPolaroid"
  | "cinematic";

export interface FilmPreset {
  id: FilmPresetId;
  name: string;
  tag: string;
  grain: number;
  vignette: number;
  warmth: number;
  fade: number;
  lightLeak: number;
}

/**
 * Presets only carry the user-adjustable amounts. The stock's actual colour
 * response — layer crosstalk, print curve, split tone, halation — lives in
 * `FILM_GRADES`, so picking a stock changes the grade, not just a warm offset.
 */
export const FILM_PRESETS: FilmPreset[] = [
  {
    id: "classic35",
    name: "35mm Classic",
    tag: "35mm",
    grain: 30,
    vignette: 20,
    warmth: 3,
    fade: 12,
    lightLeak: 0
  },
  {
    id: "kodakGold",
    name: "Kodak Warm",
    tag: "Portra",
    grain: 25,
    vignette: 25,
    warmth: 10,
    fade: 10,
    lightLeak: 15
  },
  {
    id: "fujiVelvia",
    name: "Fuji Chrome",
    tag: "Velvia",
    grain: 18,
    vignette: 15,
    warmth: -4,
    fade: 0,
    lightLeak: 0
  },
  {
    id: "triX400",
    name: "B&W Tri-X",
    tag: "Tri-X",
    grain: 45,
    vignette: 30,
    warmth: 0,
    fade: 8,
    lightLeak: 0
  },
  {
    id: "instantPolaroid",
    name: "Instant Film",
    tag: "Polaroid",
    grain: 35,
    vignette: 40,
    warmth: 8,
    fade: 26,
    lightLeak: 20
  },
  {
    id: "cinematic",
    name: "Teal & Orange",
    tag: "Cinema",
    grain: 22,
    vignette: 35,
    warmth: 4,
    fade: 15,
    lightLeak: 0
  }
];

export interface RenderFilmConfig {
  preset: FilmPresetId;
  grain: number; // 0 to 100
  vignette: number; // 0 to 100
  warmth: number; // -50 to 50
  fade: number; // 0 to 50
  lightLeak: number; // 0 to 100
}

export { renderFilm } from "./film-render";
