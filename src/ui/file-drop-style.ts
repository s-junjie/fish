/**
 * The button that opens a file picker, and the well it invites a file into.
 *
 * Its copy is a SENTENCE, so it wears the humanist stack — the same opt-in
 * `Button.tsx` makes for every button label, and for the same reason (DESIGN.md
 * §Typography reserves sans for prose). At 12px mono the sentence measured 252px
 * against a 228px well and wrapped to two lines, turning a 35px button into 53px;
 * in sans it is 206px and stays on one.
 *
 * THE COLOUR IS A SEPARATE CONSTANT, and that is not tidiness. `border-rule-
 * strong` and `border-brand` are two `border-color` utilities of equal
 * specificity, so a button carrying both resolves by stylesheet order rather than
 * by class order — and the armed state silently renders in the resting colour.
 * Exactly one of {@link FILE_DROP_RESTING_CLASS} / {@link FILE_DROP_TARGET_CLASS}
 * is applied, so there is never a second opinion to lose to.
 *
 * `FILE_DROP_TARGET_CLASS` arms only while a drag is over it, because an
 * always-warm drop target reads as a control the user has not pressed yet.
 */
export const FILE_DROP_BUTTON_CLASS =
  "w-full flex items-center justify-center gap-1.5 px-2 py-2 rounded-ctl border border-dashed " +
  "font-sans text-ui text-ink-dim hover:text-ink cursor-default transition-colors";

export const FILE_DROP_RESTING_CLASS = "border-rule-strong hover:border-brand";

export const FILE_DROP_TARGET_CLASS = "border-brand bg-brand-wash text-ink";
