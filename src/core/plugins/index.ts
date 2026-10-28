import { createIconifyProvider } from "./iconify-provider";
import { openverseProvider, type OpenverseLicenseFilter } from "./openverse-provider";
import type { AssetProvider } from "./types";

/** Outline set: bodies carry `fill="none" stroke="currentColor"`. */
export const lucideProvider = createIconifyProvider({
  prefix: "lucide",
  name: "Lucide Icons",
  nameKey: "assets.sourceLucide"
});

/** Solid set: every body is one `fill="currentColor"` path. */
export const remixProvider = createIconifyProvider({
  prefix: "ri",
  name: "Remix Icons",
  nameKey: "assets.sourceRemix"
});

export const OFFICIAL_PROVIDERS: AssetProvider[] = [
  lucideProvider,
  remixProvider,
  openverseProvider
];

export { openverseProvider, createIconifyProvider };
export type { OpenverseLicenseFilter } from "./openverse-provider";
export type {
  AssetProvider,
  AssetInsertPayload,
  AssetInsertResult,
  AssetSearchResult,
  IconRenderSpec
} from "./types";
export { ASSET_MIME } from "./types";
export { dragPayload } from "./drag";
