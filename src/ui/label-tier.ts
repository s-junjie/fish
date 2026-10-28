/**
 * The label that names a control on its row — `Clip content`, `Distribute`,
 * `Angle`, `Stop 1/2`, `Text Styles` — in ONE definition.
 *
 * This is the fourth label tier, and it exists because the same level was
 * written in two colours: the style groups wore `ink-dim` while `Clip content`
 * and its siblings wore `ink-muted`, so two labels of exactly the same rank
 * read as two different ranks. The tier is `meta` (9.5px mono) rather than the
 * `ui` (12px) it replaces for the reason the mono default made urgent: 12px
 * monospace labels are wider than the values they name, and the reference
 * layout's keys are 9–9.5px. `ink-dim` (7.0:1) rather than `ink-muted`
 * (3.3:1) because a label at 9.5px is small enough that the darker grey
 * dropped it below legible.
 *
 * NOT this tier: prose and empty states (`No styles yet`, the autosave
    description) — those still run on `ui`; and field KEYS (`X`, `W`, `%`),
 * which `ScrubInput` renders in `meta` + `ink-muted` already, inside the well
 * they belong to.
 */
export const SUB_LABEL_CLASS = "text-meta text-ink-dim";
