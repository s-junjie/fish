export interface CompileDiagnostic {
  level: "info" | "warning" | "error";
  message: string;
  elementId?: string;
  /**
   * The DSL edit that resolves this finding, in the dialect's own spelling
   * (`sizing.height: "fit-content"`). Optional because a structural finding — a
   * dangling component id, an override that addresses nothing — has a repair,
   * not a key/value. `fish check` prints it as `— fix: …` and carries it in
   * `--json`, so an agent can act without translating prose.
   */
  hint?: string;
}

export { rectToPathData, ellipseToPathData, polygonToPathData, starToPathData, effectiveCornerSmoothing } from "./geometry/shape-path";
export * from "./layout/box";
export * from "./layout/auto-layout";
export * from "./layout/grid-layout";
export * from "./layout/text-sizing";
export * from "./layout/stack-resize";
export * from "./interactions/drop-slot";
