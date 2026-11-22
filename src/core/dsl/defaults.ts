/**
 * The colours a newly drawn element starts in.
 *
 * Two of them, split by what the element is rather than by what it is filled
 * with. A closed shape is a placeholder until the user says what it is, so it
 * gets Figma's neutral fill (`#D9D9D9`); the previous per-type defaults (blue
 * rectangle, purple ellipse, green polygon) made a fresh canvas look like a
 * decision had already been made. Anything that reads as a line drawing — a
 * line, an arrow, a pen path, an icon dropped from the assets panel — is ink on
 * white and gets Figma's default stroke instead: the placeholder grey is a 1.41:1
 * contrast against white, so at 1–2px it is barely a line at all.
 */
export const DEFAULT_ELEMENT_COLOR = "#D9D9D9";

export const DEFAULT_STROKE_COLOR = "#000000";

/**
 * The two inks a new text layer can start in, and nothing else: which one it
 * gets is decided by what it lands on (`geometry/ink-on.ts`), never by the
 * document's theme. A single `#000000` default was invisible on the page a new
 * file opens on — see that module for the walk.
 */
export const DEFAULT_TEXT_INK_ON_LIGHT = "#000000";

export const DEFAULT_TEXT_INK_ON_DARK = "#FFFFFF";

/**
 * The page a new document starts on.
 *
 * The workbench's own obsidian, so the workspace reads as one continuous
 * surface rather than a light plate sitting inside a dark shell. It used to be
 * `#EEEEEE`, which made the canvas the brightest thing on screen and the chrome
 * look like a frame bolted around it.
 */
export const DEFAULT_CANVAS_BACKGROUND = "#101010";

/**
 * The plate a new section sits on — one step brighter than the page, so a named
 * region reads as a raised sheet rather than as a second background. Figma's
 * ratio between its canvas and its section, applied to this tool's obsidian.
 *
 * Two values because the page can be either: a file imported from Figma arrives
 * on white. Which one a new section takes is read from the page it lands on,
 * the same way a new text layer reads its ink (`geometry/ink-on.ts`).
 */
export const DEFAULT_SECTION_FILL_ON_DARK = "#1E1E1E";

export const DEFAULT_SECTION_FILL_ON_LIGHT = "#FFFFFF";
