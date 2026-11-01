// Every axis the kit has to know about itself is stamped by the build that
// compiles it, never typed: the release it is (`package.json`) and where its
// origin is (`kit.config.json` / `FISH_KIT_URL`). A `dev` build and an unpacked
// checkout answer "I cannot say" rather than guessing — see `cli/kit-identity.ts`
// and `cli/kit-update.ts`.
declare const __FISH_APP_VERSION__: string;
declare const __FISH_KIT_MANIFEST_URL__: string;
declare const __FISH_KIT_INSTALL_URL__: string;

export const APP_VERSION: string =
  typeof __FISH_APP_VERSION__ === "string" ? __FISH_APP_VERSION__ : "dev";

export const KIT_MANIFEST_URL: string =
  typeof __FISH_KIT_MANIFEST_URL__ === "string" ? __FISH_KIT_MANIFEST_URL__ : "";

export const KIT_INSTALL_URL: string =
  typeof __FISH_KIT_INSTALL_URL__ === "string" ? __FISH_KIT_INSTALL_URL__ : "";
