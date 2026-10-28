declare const __FISH_APP_VERSION__: string;

export const APP_VERSION: string =
  typeof __FISH_APP_VERSION__ === "string" ? __FISH_APP_VERSION__ : "dev";
