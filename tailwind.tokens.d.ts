export declare const COLOR_TOKENS: Record<
  string,
  string | { from: string; alpha: number } | Record<string, string>
>;
export declare const RADIUS_TOKENS: Record<string, string>;
export declare const SHADOW_TOKENS: Record<string, string>;
export declare const DURATION_TOKENS: Record<string, string>;
export declare const EASING_TOKENS: Record<string, string>;
export declare const COLOR_NAMES: string[];
export declare const FLAT_COLOR_NAMES: string[];
export declare function color(name: string): string;
export declare function radius(name: string): string;
export declare function shadow(name: string): string;
export declare function duration(name: string): string;
export declare function easing(name: string): string;
export declare function cssVariables(): Record<string, string>;
