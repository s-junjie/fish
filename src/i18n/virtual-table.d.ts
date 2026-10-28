declare module "virtual:fish-i18n-table" {
  /** Front-coded key paths, joined by U+0001; see `scripts/vite-plugin-i18n-index.ts`. */
  export const KEYS: string;
  /** Values in decoded `KEYS` order. */
  export const VALUES: string[];
}
