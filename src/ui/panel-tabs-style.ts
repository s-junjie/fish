/**
 * The tab strip that chooses between views of the same thing.
 *
 * One definition because it was written out three times — twice in the layer
 * panel and once in the Figma import dialog — and three copies of a 5px-tall
 * active indicator are three chances to spell it slightly differently, which is
 * how a panel ends up with two tab styles nobody chose.
 *
 * The active tab wears a 1.5px `brand` underline over a `brand-wash` fill, not
 * just the underline: at 11px mono against `ink-muted`, an underline alone is a
 * hairline telling you which of two nearly identical words is current, which is
 * not the job of the one control that says what the panel is showing.
 */
export function tabClass(active: boolean): string {
  return [
    "flex items-center px-1.5 text-tab rounded-t-ctl border-b-[1.5px] transition-colors",
    "duration-micro ease-snap cursor-default",
    active ? "border-brand bg-brand-wash text-ink" : "border-transparent text-ink-muted hover:text-ink-dim"
  ].join(" ");
}
