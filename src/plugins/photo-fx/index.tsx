import type { PluginHostContext } from "../../core/plugins/plugin-contract";
import { PhotoFxPluginView } from "./PhotoFxPluginView";

export const apiVersion = "1";

export function Component({ context }: { context: PluginHostContext }) {
  return <PhotoFxPluginView context={context} />;
}
