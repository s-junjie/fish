import type { JSX } from "preact";
import type { PluginHostContext } from "../../core/plugins/plugin-contract";
import { IconsPluginView } from "./IconsPluginView";

/**
 * A plugin bundle exports behaviour and nothing else. Identity — id, name, icon,
 * version, fingerprint — lives in `plugin.json` and is baked into the catalog, so
 * renaming a panel does not need a new bundle and a bundle cannot claim to be a
 * plugin it is not.
 */
export const apiVersion = "1";

export function Component({ context }: { context: PluginHostContext }): JSX.Element {
  return <IconsPluginView context={context} />;
}
