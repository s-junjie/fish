import { ComponentChildren } from "preact";

export interface SegmentedItem<T extends string | boolean> {
  value: T;
  icon?: ComponentChildren;
  label?: string;
  title?: string;
  /** Stretch to fill the row (use inside a flex parent that distributes width). */
  grow?: boolean;
  /** Extra attributes for this segment's button — the suites' `data-*` hooks. */
  attrs?: Record<string, string>;
}

interface SegmentedControlProps<T extends string | boolean> {
  items: SegmentedItem<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  /** Extra attributes for the track — the suites' `data-*` hooks. */
  rowProps?: Record<string, string>;
}

const TRACK_CLASS = "flex h-[25px] bg-field p-0.5 rounded-swatch ring-1 ring-inset ring-rule";
const SEGMENT_CLASS =
  "flex items-center justify-center gap-1 rounded-sm text-row transition-colors duration-micro ease-snap";
const SEGMENT_ACTIVE_CLASS = "bg-field-active text-ink";
const SEGMENT_IDLE_CLASS = "text-ink-dim hover:text-ink";

/**
 * A press on a tool-row segment must not move focus.
 *
 * Focus is what the canvas text editor lives on: the press that writes a run
 * style is the same press that would blur the contentEditable — committing the
 * draft and ending the run selection before `onToggle` ever runs — so the style
 * lands on the whole layer instead of the selected characters. Cancelling the
 * default action of `mousedown` is what keeps the caret (and the highlighted
 * range) where the author put it. The click itself is untouched, and Tab still
 * reaches the button: only the mouse press stops stealing focus.
 */
const keepFocusOnPress = (e: MouseEvent) => e.preventDefault();

export function SegmentedControl<T extends string | boolean>({
  items,
  value,
  onChange,
  className = "",
  rowProps
}: SegmentedControlProps<T>) {
  return (
    <div {...rowProps} className={`${TRACK_CLASS} ${className}`}>
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={String(it.value)}
            {...it.attrs}
            type="button"
            title={it.title}
            onMouseDown={keepFocusOnPress}
            onClick={() => onChange(it.value)}
            className={`${it.grow ? "flex-1 " : ""}${SEGMENT_CLASS} ${active ? SEGMENT_ACTIVE_CLASS : SEGMENT_IDLE_CLASS
              } ${it.icon && !it.label ? "min-w-7" : "px-1.5"}`}
          >
            {it.icon}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

export interface ToggleItem<T extends string> {
  value: T;
  icon?: ComponentChildren;
  label?: string;
  title?: string;
  grow?: boolean;
  /** Extra attributes for this item's button — the suites' `data-*` hooks. */
  attrs?: Record<string, string>;
}

interface ToggleGroupProps<T extends string> {
  items: ToggleItem<T>[];
  /** The values currently ON. Any subset, including none. */
  values: readonly T[];
  onToggle: (value: T, next: boolean) => void;
  className?: string;
  rowProps?: Record<string, string>;
}


export function ToggleGroup<T extends string>({
  items,
  values,
  onToggle,
  className = "",
  rowProps
}: ToggleGroupProps<T>) {
  return (
    <div {...rowProps} className={`${TRACK_CLASS} ${className}`} role="group">
      {items.map((it) => {
        const active = values.includes(it.value);
        return (
          <button
            key={it.value}
            {...it.attrs}
            type="button"
            title={it.title}
            aria-pressed={active}
            onMouseDown={keepFocusOnPress}
            onClick={() => onToggle(it.value, !active)}
            className={`${it.grow ? "flex-1 " : ""}${SEGMENT_CLASS} ${active ? SEGMENT_ACTIVE_CLASS : SEGMENT_IDLE_CLASS
              } ${it.icon && !it.label ? "min-w-7" : "px-1.5"}`}
          >
            {it.icon}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
