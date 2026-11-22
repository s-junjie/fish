/**
 * Split on whitespace, but keep anything inside `()` whole so a
 * `minmax(1fr, 2fr)` track list or `rgba(0, 0, 0, .1)` colour stays as one
 * token instead of being torn apart at its internal spaces.
 *
 * The rule lives in `dsl/length-expr` beside the rest of the CSS value
 * readers; this name is the one the import layer already calls it by.
 */
export { splitTopLevelWhitespace as splitTopLevel } from "../dsl/length-expr";
