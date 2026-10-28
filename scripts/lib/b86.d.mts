// Types for scripts/lib/b86.mjs, which tsc does not read (allowJs is off and the
// scripts are build-time only). tests/shell-compression.test.ts imports it, so the
// contract it relies on is declared here rather than cast away at the import.
export declare const ALPHABET: string;
export declare const BASE: number;
export declare const FORBIDDEN: string[];
export declare const LOADER_DECODER: string;
export declare function encode(bytes: Uint8Array): string;
export declare function decode(text: string): Uint8Array;