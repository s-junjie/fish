import type { DesignDocument, DesignElement } from "../dsl/types";
import type { Button } from "../../ui/Button";
import type { SegmentedControl } from "../../ui/SegmentedControl";
import type { ColorField } from "../../ui/ColorField";

/**
 * Host Design System & Services exposed to plugins.
 * Plugins consume this context rather than bundling their own UI components or hacking host state.
 */
export interface PluginHostContext {
  ui: {
    Button: typeof Button;
    /**
     * A segmented control belongs to the design system, not to a panel: the
     * track, the armed step and the "a press must not move focus" rule are all
     * decisions the shell already made. A plugin that re-draws one ships a
     * second opinion about what a switch looks like.
     */
    SegmentedControl: typeof SegmentedControl;
    ColorField?: typeof ColorField;
    checkerboardStyle: Record<string, string>;
    /** Idempotent injection for CSS shipped inside the plugin bundle. */
    injectStyles: (css: string) => void;
  };
  docRef: { current: DesignDocument };
  primarySelected: DesignElement | null;
  commitSnapshot: (doc: DesignDocument) => void;
  notify: (msg: string) => void;
  locale: string;
  /**
   * Top-left of a `size` box at the centre of what the user can see through the
   * panels. A plugin places an element the user has not aimed at — an icon from
   * a search grid — through this, so the answer is always on screen: a panel is
   * not the canvas, and a page coordinate that reads as "middle" in the code is
   * wherever the user happened to scroll to.
   */
  dropTopLeft: (size: { width: number; height: number }) => { x: number; y: number };
}

export type PluginResizeMode = "none" | "vertical" | "horizontal" | "both";

export interface PluginAttribution {
  name: string;
  url: string;
}

