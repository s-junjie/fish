/**
 * The typeface the editor's OWN chrome speaks when it has to be drawn inside the
 * SVG — the measurement badge, the size badge, a component set's title, the
 * spacing read-outs.
 *
 * These labels are not the design. Nothing about them belongs to the document,
 * so nothing about them should change because the machine that opened the file
 * happens to have a webfont installed — and that is exactly what the four
 * sites this replaces were doing: they wrote the DOCUMENT's default
 * (`Inter, sans-serif`, see dsl.md §fonts) into an editor badge, so the badge
 * rendered as Inter on one machine and as whatever sans-serif resolved to on
 * another. The shell's own stack is installed everywhere it runs.
 *
 * Mono rather than sans because these are read-outs: DESIGN.md makes `readout`
 * the one mono step ("every NUMBER … tabular so digits do not shift"), and the
 * badges that use this are nearly all digits — a measurement that re-spaced
 * itself as you dragged would be unreadable.
 *
 * Document CONTENT keeps whatever family the author named, defaulting to
 * `system-ui` (`DEFAULT_FONT_FAMILY` in `src/core/font-stack.ts`) and completed
 * into a stack at paint time by `resolveStack`. An author who names a font gets
 * that font. Changing this constant changes the editor's chrome, not the
 * documents it edits.
 */
export const CANVAS_CHROME_TEXT =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';