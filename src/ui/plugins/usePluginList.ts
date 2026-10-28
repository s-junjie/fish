import { useEffect, useState } from "preact/hooks";
import { getPluginList, hydratePlugins, subscribePlugins, type PluginListSnapshot } from "../../core/plugins/store";

/**
 * The catalog as a value. The list is populated by a storage read, so the first
 * render is legitimately empty; `ready` is what tells the panel to say "loading"
 * rather than "there is nothing here".
 */
export function usePluginList(): PluginListSnapshot {
  const [snap, setSnap] = useState<PluginListSnapshot>(getPluginList);

  useEffect(() => {
    // Catch up on anything that changed between the last render and this effect,
    // then follow. Both are cheap and the snapshot is a stable object.
    setSnap(getPluginList());
    const off = subscribePlugins(() => setSnap(getPluginList()));
    void hydratePlugins();
    return off;
  }, []);

  return snap;
}
