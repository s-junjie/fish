import { ComponentChildren } from "preact";
import { useRef, useState, useEffect } from "preact/hooks";
import { Tag, X } from "lucide-react";
import { evaluateMathExpression } from "./math-expression";
import { MIXED_LABEL } from "./inspector/mixed";
import { TokenTag } from "./TokenTag";
import { t } from "../i18n";

/**
 * A square button that sits BESIDE a field and therefore has to match its box.
 */
export const FIELD_BUTTON_CLASS =
  "flex-none h-[25px] w-[25px] flex items-center justify-center rounded-swatch border transition-colors cursor-default";


export const TEXT_FIELD_CLASS =
  "min-w-0 w-full h-[25px] px-[7px] bg-inset rounded-swatch text-row text-ink placeholder:text-ink-muted focus:outline-none ring-1 ring-inset ring-transparent focus:ring-brand";

interface ScrubInputProps {
  /**
   * Drag-handle content: a short unit label or an icon.
   *
   * May be a string OR an element, and the two are interchangeable to every
   * consumer — `data-scrub-label` is what `isValueEdit` tests to decide a press is
   * editing a value rather than pressing a button, and gating that attribute on the
   * label being a string meant every ICON-labelled field silently kept its
   * selection overlay up while its number was being scrubbed.
   */
  label: ComponentChildren;
  value?: number;
  /**
   * `discrete` says whether this frame ENDS an edit rather than continues a
   * gesture: a pointer-drag frame is `false`, a typed value or an arrow key is
   * `true`.
   *
   * The `onDragStart`/`onDragEnd` bracket is enough only for a caller that
   * writes every frame WITHOUT recording it. A caller that has to say
   * "record this" per edit (a paint write, where a click and a drag share one
   * handler) cannot derive it from the bracket — the bracket also wraps a typed
   * commit — and a field that answered `true` unconditionally pushed one undo
   * step per pointermove.
   */
  onChange: (val: number, discrete?: boolean) => void;
  /**
   * The field's unit, when the user may TYPE it rather than pick it from a menu
   * (`150%`). `parse` then splits a draft into the number to store and the unit
   * it spelled, so a typed unit can change the field even when the digits do not
   * (`24` px → `24%`). The spelling is handed to `onUnit` just before the matching
   * `onChange`, so a caller can re-express the value in that unit. Without either,
   * a draft is a bare arithmetic expression and the field is unitless.
   */
  unit?: string;
  parse?: (raw: string, unit: string) => { value: number; unit: string } | null;
  onUnit?: (unit: string) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  min?: number;
  max?: number;
  /** When true and min/max are provided, dragging past min/max wraps continuously instead of clamping. */
  wrap?: boolean;
  step?: number;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  defaultVal?: number;
  title?: string;
  /** Rendered after the value: a mode name, a dropdown caret, a unit. */
  trailing?: ComponentChildren;
  /**
   * Enter means "apply" rather than "done" — for a field inside a dialog, where
   * committing the number and leaving the caret behind is only half the action.
   * Called after the value has been committed; the field still blurs.
   */
  onEnter?: () => void;
  /**
   * A field that lives INSIDE a 30px paint card — the alpha well in a fill or
   * stroke row.
   *
   * A 25px well with 2.5px above and below reads as a control crammed into the
   * card; 20px leaves the card's own padding visible and the row reads as one
   * object with a number in it. It is a prop rather than a class the caller
   * appends, because two `h-*` utilities resolve by stylesheet order, not by
   * class order — the caller's height would win or lose at random.
   */
  compact?: boolean;
  /**
   * The selection disagrees, so there is no number to show or to move from.
   *
   * The field shows `MIXED_LABEL` and accepts a TYPED value, which lands on every
   * selected layer — the only edit that means anything when they differ.
   *
   * Dragging and the arrow keys are refused rather than guessed. Both start from
   * the field's current value, and a mixed field has none: starting the first
   * pixel of a drag from the fallback `0` would move five layers to zero before
   * the pointer had travelled anywhere, which is the one thing a field saying
   * "Mixed" must not do.
   */
  mixed?: boolean;
  /** When bound to a number token, the token's display name. */
  tokenName?: string;
  /** Callback to detach the bound token and restore raw editing. */
  onDetachToken?: () => void;
  /** Callback to open the number token picker popover. */
  onOpenTokenPicker?: (anchor: HTMLElement) => void;
}

const toValStr = (v?: number) => (v != null ? String(v) : "");

/** The default draft parser: a bare arithmetic expression, in the field's unit. */
const parsePlain = (raw: string, unit: string): { value: number; unit: string } | null => {
  const n = evaluateMathExpression(raw);
  return n === null ? null : { value: n, unit };
};

export function ScrubInput({
  label,
  value,
  onChange,
  unit,
  parse,
  onUnit,
  onDragStart,
  onDragEnd,
  min,
  max,
  wrap = false,
  step = 1,
  className = "",
  disabled = false,
  placeholder,
  defaultVal,
  title,
  trailing,
  onEnter,
  compact = false,
  mixed = false,
  tokenName,
  onDetachToken,
  onOpenTokenPicker
}: ScrubInputProps) {
  const isDragging = useRef(false);
  const startMouseX = useRef(0);
  const startVal = useRef(value ?? defaultVal ?? 0);
  /**
   * The last number this field pushed out, held until the document's own `value`
   * arrives. Enter commits and then blurs inside the SAME task, so the parent has
   * not re-rendered yet and `value` is still the pre-commit number — a second
   * commit from that blur would apply the same edit twice. Absolute fields (W/H,
   * rotation) absorb the duplicate; a DELTA one (X/Y) lands at old + 2 × delta,
   * which is how a typed 123 became -354.
   */
  const emitted = useRef<number | null>(null);
  const [localVal, setLocalVal] = useState<string>(toValStr(value));

  const suppressTagClickRef = useRef(false);

  useEffect(() => {
    if (!isDragging.current) {
      emitted.current = null;
      setLocalVal(mixed ? "" : toValStr(value));
    }
  }, [value, mixed]);

  const onLabelPointerDown = (e: PointerEvent) => {
    if (disabled || mixed) return;
    const startX = e.clientX;
    const startNumber = value ?? defaultVal ?? 0;
    isDragging.current = true;
    startMouseX.current = startX;
    startVal.current = startNumber;
    let didDetach = false;

    onDragStart?.();

    const onMove = (moveEv: PointerEvent) => {
      const dx = moveEv.clientX - startX;
      if (tokenName && onDetachToken && !didDetach && Math.abs(dx) >= 1) {
        didDetach = true;
        onDetachToken();
      }
      const multiplier = moveEv.shiftKey ? step * 8 : moveEv.altKey ? step * 0.1 : step;
      let next = startNumber + Math.round(dx) * multiplier;
      if (wrap && min !== undefined && max !== undefined && max > min) {
        const range = max - min;
        next = ((((next - min) % range) + range) % range) + min;
      } else {
        if (min !== undefined) next = Math.max(min, next);
        if (max !== undefined) next = Math.min(max, next);
      }
      next = Math.round(next * 100) / 100;
      setLocalVal(String(next));
      onChange(next, false);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      isDragging.current = false;
      onDragEnd?.();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onTagPointerDown = (e: PointerEvent) => {
    if (disabled) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const startX = e.clientX;
    const startNumber = value ?? defaultVal ?? 0;
    let didMove = false;

    const onMove = (moveEv: PointerEvent) => {
      const dx = moveEv.clientX - startX;
      if (!didMove && Math.abs(dx) >= 3) {
        didMove = true;
        suppressTagClickRef.current = true;
        isDragging.current = true;
        startMouseX.current = startX;
        startVal.current = startNumber;
        onDetachToken?.();
        onDragStart?.();
      }
      if (didMove) {
        const multiplier = moveEv.shiftKey ? step * 8 : moveEv.altKey ? step * 0.1 : step;
        let next = startNumber + Math.round(dx) * multiplier;
        if (wrap && min !== undefined && max !== undefined && max > min) {
          const range = max - min;
          next = ((((next - min) % range) + range) % range) + min;
        } else {
          if (min !== undefined) next = Math.max(min, next);
          if (max !== undefined) next = Math.min(max, next);
        }
        next = Math.round(next * 100) / 100;
        setLocalVal(String(next));
        onChange(next, false);
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (didMove) {
        isDragging.current = false;
        onDragEnd?.();
        setTimeout(() => {
          suppressTagClickRef.current = false;
        }, 50);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const commitDirectInput = (valStr: string) => {
    // The field is a calculator: `1000/2` commits 500, so a resize is one edit
    // instead of a mental sum and a second one.
    const trimmed = valStr.trim().toLowerCase();
    if (!trimmed || trimmed === "auto") {
      setLocalVal("");
      if (value !== undefined) {
        onDragStart?.();
        onChange(0, true);
        onDragEnd?.();
      }
      return;
    }
    const parsed = parse ? parse(valStr, unit ?? "") : parsePlain(valStr, unit ?? "");
    if (parsed === null) {
      setLocalVal(toValStr(value));
      return;
    }
    let num = parsed.value;
    if (min !== undefined) num = Math.max(min, num);
    if (max !== undefined) num = Math.min(max, num);
    setLocalVal(String(num));
    // A typed UNIT can change the field even when the digits do not (`24` px →
    // `24%`), so the no-op test is the (number, unit) pair, not the number alone.
    const sameUnit = parsed.unit === (unit ?? "");
    if (sameUnit && (num === value || emitted.current === num)) return;
    emitted.current = num;
    onDragStart?.();
    onUnit?.(parsed.unit);
    onChange(num, true);
    onDragEnd?.();
  };

  if (tokenName) {
    return (
      <div
        title={title ?? `${tokenName} (${value ?? 0}${unit ?? ""})`}
        className={`group flex items-center justify-between ${
          compact ? "h-5" : "h-[25px]"
        } bg-inset rounded-swatch px-1 text-ui transition-colors ${className}`}
      >
        {label ? (
          <span
            onPointerDown={onLabelPointerDown}
            className={`flex-none flex items-center pl-1 pr-1 text-meta select-none text-ink-muted ${
              disabled || mixed ? "" : "cursor-ew-resize hover:text-ink transition-colors"
            }`}
          >
            {label}
          </span>
        ) : null}
        <div className="flex-1 min-w-0 flex items-center justify-end">
          <TokenTag
            name={tokenName}
            value={`${value ?? 0}${unit ?? ""}`}
            title={title ?? `${tokenName} (${value ?? 0}${unit ?? ""})`}
            onPointerDown={onTagPointerDown}
            onClick={(e) => {
              if (suppressTagClickRef.current) return;
              onOpenTokenPicker?.(e.currentTarget);
            }}
            onDblClick={(e) => {
              e.stopPropagation();
              onDetachToken?.();
            }}
            onDetach={onDetachToken}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      title={title}
      className={`group flex items-center ${compact ? "h-5" : "h-[25px]"
        } bg-inset rounded-swatch overflow-hidden text-ui ${className}`}
    >
      {label ? (
        /* The key is `flex-none` and wears no divider: the demo runs `.k` straight
           into a right-aligned `.v`, so the well reads as one field rather than
           two boxes bolted together. `fieldKey` (9px/400) not `micro` (9px/600 +
           0.18em) — the latter is a SECTION heading's weight, and it made `X`
           louder than the number it labels.

           `meta` (9.5px) rather than `unit` (8.5px): a `%`, a `°` or an `R` at
           8.5px beside a 12px value read as a speck the eye skipped, and these
           keys are how a column of identical-looking wells is told apart. The
           demo's `.k` is 9px. */
        <span
          data-scrub-label={typeof label === "string" ? label : ""}
          onPointerDown={onLabelPointerDown}
          /* Scrub, keep the caret. Dragging this handle is how a run is given
             its own size, and the canvas text editor lives on focus: without
             this the press blurs the contentEditable, commits the draft and ends
             the run selection before the first `onChange` — so the drag grew the
             whole layer. The field itself is left alone: typing needs the focus
             this refuses. */
          onMouseDown={(e) => e.preventDefault()}
          className={`flex-none flex items-center gap-1 ${
            compact ? "pl-1 pr-0.5" : "pl-[7px] pr-1"
          } text-meta select-none text-ink-muted transition-colors duration-micro ease-snap ${
            disabled || mixed ? "opacity-50" : "hover:text-brand cursor-ew-resize"
          }`}
        >
          {label}
        </span>
      ) : null}
      <input
        data-scrub-field={typeof label === "string" ? label : label ? "" : undefined}
        name={typeof label === "string" && label ? label : "scrub-input"}
        /* `text`, not `number`: a number field drops every `/`, `*` and `(` at
           the keystroke, so the arithmetic this field accepts could never be
           typed. `inputMode` keeps the numeric keypad, the spinner is gone
           either way (it was hidden, and arrow keys are handled by hand above),
           and an unparseable draft falls back to the previous value on commit. */
        type="text"
        inputMode="decimal"
        placeholder={mixed ? MIXED_LABEL : placeholder}
        data-mixed={mixed ? "true" : undefined}
        value={localVal}
        disabled={disabled}
        onFocus={(e) => {
          if (!disabled) (e.target as HTMLInputElement).select();
        }}
        onKeyDown={(e) => {
          if (e.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            // Enter commits this field; without preventDefault the browser would
            // also implicitly submit the enclosing form (the style panel's).
            e.preventDefault();
            commitDirectInput((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
            onEnter?.();
            return;
          }
          if (disabled || mixed || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          // The canvas has to follow every key press, not wait for blur; and the
          // field may hold an expression, so `1000/2` resolves to 500 first.
          e.preventDefault();
          const arrow = parse ? parse((e.target as HTMLInputElement).value, unit ?? "") : parsePlain((e.target as HTMLInputElement).value, unit ?? "");
          const base = arrow?.value ?? value ?? defaultVal ?? 0;
          const mult = e.shiftKey ? 8 : e.altKey ? 0.1 : 1;
          let next = base + (e.key === "ArrowUp" ? 1 : -1) * step * mult;
          if (wrap && min !== undefined && max !== undefined && max > min) {
            const range = max - min;
            next = ((((next - min) % range) + range) % range) + min;
          } else {
            if (min !== undefined) next = Math.max(min, next);
            if (max !== undefined) next = Math.min(max, next);
          }
          next = Math.round(next * 100) / 100;
          if (next === value) return;
          setLocalVal(String(next));
          emitted.current = next;
          onDragStart?.();
          onChange(next, true);
          onDragEnd?.();
        }}
        onBlur={(e) => {
          commitDirectInput((e.target as HTMLInputElement).value);
        }}
        onInput={(e) => {
          // A fresh string is a fresh intent: a number the document refused
          // earlier must not stay suppressed for a later, deliberate retype.
          emitted.current = null;
          setLocalVal((e.target as HTMLInputElement).value);
        }}
        className={`min-w-0 w-full bg-transparent ${
          compact ? "pl-0.5 pr-1" : "pl-1 pr-[7px]"
        } text-right tabular-nums text-ink placeholder:text-ink-muted focus:outline-none text-row ${
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-text"
        }`}
      />
      {onOpenTokenPicker ? (
        <button
          type="button"
          data-token-picker-trigger="1"
          title={t("tokens.pickNumber")}
          onClick={(e) => onOpenTokenPicker(e.currentTarget)}
          className="flex-none p-1 rounded-swatch text-ink-dim hover:text-ink hover:bg-raised opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all mr-0.5"
        >
          <Tag size={10} />
        </button>
      ) : null}
      {trailing}
    </div>
  );
}
