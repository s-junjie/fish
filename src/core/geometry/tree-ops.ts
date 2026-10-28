/**
 * The tree family: reading it, writing it, moving things inside it, asking where
 * a node sits, and asking what is under a point.
 *
 * This file is the barrel those five live behind, so the ~95 callers that import
 * `tree-ops` keep importing `tree-ops`. The split is about each question having
 * one home, not about anyone's import lines.
 *
 * The dependency order is the one below, and it has no cycles: a writer may ask a
 * reader, a mover may ask a writer, a locator may ask a mover — never back.
 */

export * from "./tree-query";
export * from "./tree-edit";
export * from "./tree-reparent";
export * from "./tree-coords";
export * from "./tree-hit";
