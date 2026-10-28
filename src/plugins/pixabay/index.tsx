import type { JSX } from "preact";
import type { PluginHostContext } from "../../core/plugins/plugin-contract";
import { PixabayPluginView } from "./PixabayPluginView";

export const apiVersion = "1";

export function Component({ context }: { context: PluginHostContext }): JSX.Element {
  return <PixabayPluginView context={context} />;
}
