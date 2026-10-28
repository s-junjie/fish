import type { JSX } from "preact";
import type { PluginHostContext } from "../../core/plugins/plugin-contract";
import { CutoutPluginView } from "./CutoutPluginView";

export const apiVersion = "1";

export function Component({ context }: { context: PluginHostContext }): JSX.Element {
  return <CutoutPluginView context={context} />;
}
