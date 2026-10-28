/**
 * Fault-tolerant normalization for Design DSL v0.1.
 *
 * LLMs do not emit the DSL verbatim: they reach for CSS-ish spellings
 * (`shadow`, `borderWidth`, `backgroundColor`, `objectFit`) and for role words
 * that are not in the vocabulary (`accent`, `primary`). Because the JSON Schema
 * deliberately ignores unknown properties, such documents *validate* and then
 * render with those properties silently dropped — the worst possible failure
 * mode, since the poster simply looks wrong with no error anywhere.
 *
 * This module is the single canonicalization layer. It is pure, UI-independent
 * and dependency-free (AGENTS.md §2), so the agent harness, the editor store and
 * the tests all share one definition of "a well-formed document".
 *
 * Two invariants it must uphold:
 *  1. The returned document contains ONLY canonical DSL properties, so it passes
 *     the strict schema (`unevaluatedProperties: false`).
 *  2. Nothing meaningful is lost — aliases are translated, not discarded.
 */

export * from "./normalize/shared";
export * from "./normalize/blend-mode";
export * from "./normalize/paint";
export * from "./normalize/stroke";
export * from "./normalize/effects";
export * from "./normalize/text-sizing";
export * from "./normalize/auto-layout";
export * from "./normalize/css-absorb";
export * from "./normalize/resolve-values";
export * from "./normalize/element";
export * from "./normalize/document";
