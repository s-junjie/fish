import type { JSX } from "preact";
import type { PluginHostContext } from "../../core/plugins/plugin-contract";
import { WikimediaPluginView } from "./WikimediaPluginView";

export const apiVersion = "1";

export function Component({ context }: { context: PluginHostContext }): JSX.Element {
  return <WikimediaPluginView context={context} />;
}
