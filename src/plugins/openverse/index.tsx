import type { JSX } from "preact";
import type { PluginHostContext } from "../../core/plugins/plugin-contract";
import { OpenversePluginView } from "./OpenversePluginView";

export const apiVersion = "1";

export function Component({ context }: { context: PluginHostContext }): JSX.Element {
  return <OpenversePluginView context={context} />;
}
