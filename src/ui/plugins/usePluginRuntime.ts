import { useEffect, useState } from "preact/hooks";
import { openPlugin } from "../../core/plugins/loader";
import type { PluginManifest, PluginModule } from "../../core/plugins/manifest";

export type PluginRuntime =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; manifest: PluginManifest; mod: PluginModule }
  | { status: "error"; error: string };

/**
 * Opening a panel is asynchronous now: the bytes come from storage and the module
 * is evaluated on the way — including its own signed manifest, which is why the
 * title is unknown until the load finishes. `EditorShell` used to do a synchronous
 * lookup and render `null` when it missed; with a load in between, that `null` is
 * the "clicked it, nothing happened" bug.
 *
 * There is no "built in" branch any more: every plugin is one of these.
 */
export function usePluginRuntime(id: string | null): PluginRuntime {
  const [runtime, setRuntime] = useState<PluginRuntime>({ status: "idle" });

  useEffect(() => {
    if (!id) {
      setRuntime({ status: "idle" });
      return;
    }

    let live = true;
    setRuntime({ status: "loading" });
    openPlugin(id)
      .then(({ manifest, mod }) => {
        if (live) setRuntime({ status: "ready", manifest, mod });
      })
      .catch((err: unknown) => {
        if (live) setRuntime({ status: "error", error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      live = false;
    };
  }, [id]);

  return runtime;
}
