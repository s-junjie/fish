import { useEffect, useState } from "preact/hooks";
import { subscribeFontStatus } from "../../core/fonts/font-status";

/**
 * Re-render when a family's availability MOVED.
 *
 * Reading `textFontStatus` during render is what makes a mark correct on the
 * first paint — the resolver is decided before the load-time layout, so there is
 * no frame where the answer is unknown. This hook is what keeps it correct
 * afterwards, because a `missing` family becomes `installed` without the
 * document changing at all: the platform's face list arrives when the font
 * picker is opened.
 *
 * Called at the component that DRAWS the mark, not at the root. A root
 * subscription would be memoised away before it reached these components — the
 * node comparator and `layerPanelPropsEqual` both skip a subtree whose props did
 * not change, and "the font list finished loading" is not a prop.
 */
export function useFontStatusUpdates(): void {
  const [, bump] = useState(0);
  useEffect(() => subscribeFontStatus(() => bump((n) => n + 1)), []);
}
