declare module "virtual:fish-i18n-table" {
  /** Front-coded `slot delta|shared prefix|suffix`, joined by U+0001. */
  export const KEYS: string;
  /** English values in slot order; `KEYS` and every inlined call site index it. */
  export const VALUES: string[];
}
