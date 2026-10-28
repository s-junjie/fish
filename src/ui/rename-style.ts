/**
 * The inline rename field — a name turned into an input in its own slot.
 *
 * Three sites edit a name this way (layer rows, page rows, the version
 * history's label), and they must stay one object: an `inset` well, the `row`
 * step the surrounding label is set in, and an amber hairline while it holds
 * focus — brand marks the commit that is about to happen, which is the one
 * thing amber is for. Written once so a fourth site cannot spell it differently.
 *
 * `placeholder:text-ink-muted` is here because only the history field has a
 * placeholder; it costs the other two nothing.
 */
export const INLINE_RENAME_INPUT_CLASS =
  "bg-inset text-ink text-row px-1 py-0.5 rounded-ctl border border-brand focus:outline-none w-full cursor-text placeholder:text-ink-muted";
