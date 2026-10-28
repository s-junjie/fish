export interface CompileDiagnostic {
  level: "info" | "warning" | "error";
  message: string;
  elementId?: string;
}

export { rectToPathData, ellipseToPathData, polygonToPathData, starToPathData, effectiveCornerSmoothing } from "./geometry/shape-path";
export * from "./layout/box";
export * from "./layout/auto-layout";
export * from "./layout/grid-layout";
export * from "./layout/text-sizing";
export * from "./layout/stack-resize";
export * from "./interactions/drop-slot";
