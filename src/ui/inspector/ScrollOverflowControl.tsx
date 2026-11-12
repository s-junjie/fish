import type { JSX } from "preact";
import type { DesignDocument, DesignElement, InstanceElement } from "../../core/dsl/types";
import { resolveOverflow, type Overflow, type OverflowFields } from "../../core/dsl/overflow";
import { Select } from "../Select";
import { t } from "../../i18n";
import { SUB_LABEL_CLASS } from "../label-tier";
import { findMasterComponent } from "../../core/interactions/component-inventory";

interface ScrollOverflowControlProps {
  element: DesignElement;
  docRef?: { current: DesignDocument };
  onMutate: (updater: (el: DesignElement) => DesignElement, recordSnapshot?: boolean) => void;
}

/** The reading a two-axis file gets in a one-value menu. Never offered as a choice. */
const MIXED = "mixed";

/**
 * Writes the axes as ONE value, which is what picking from this menu means: the
 * longhand pair goes with it, because leaving `overflowX` behind would shadow
 * the shorthand the user just chose and the menu would snap back to `Mixed`.
 *
 * Only `auto` can scroll, so any other value also ends the pan — an offset left
 * on a box that no longer scrolls paints the children at a position nothing can
 * bring back.
 */
export function withOverflow(el: DesignElement, value: Overflow): DesignElement {
  const next = { ...el } as Record<string, unknown>;
  next.overflow = value;
  delete next.overflowX;
  delete next.overflowY;
  if (value !== "auto") {
    next.scrollX = undefined;
    next.scrollY = undefined;
  }
  return next as unknown as DesignElement;
}

/**
 * One dropdown, three values. The file says `hidden` and `auto` because those
 * are CSS's words; the panel says `Clip` and `Scroll` because those are the
 * words this audience learned from Figma. The mapping lives here and nowhere
 * else — the reader and the writer never see the UI's half of it.
 */
export function ScrollOverflowControl({ element, docRef, onMutate }: ScrollOverflowControlProps): JSX.Element {
  const master =
    element.type === "instance" && docRef
      ? findMasterComponent(docRef.current, (element as InstanceElement).componentId)
      : null;

  const axes = resolveOverflow(element as OverflowFields, master as OverflowFields | null);
  const value = axes.x === axes.y ? axes.x : MIXED;

  return (
    <div className="flex items-center gap-2">
      <span className={`${SUB_LABEL_CLASS} shrink-0`}>{t("stack.overflow")}</span>
      <Select
        className="flex-1 min-w-0"
        data-testid="overflow"
        value={value}
        onChange={(next) => {
          if (next === MIXED) return;
          onMutate((curr) => withOverflow(curr, next as Overflow), true);
        }}
      >
        {value === MIXED && (
          <option value={MIXED} disabled>
            {t("stack.overflowMixed")}
          </option>
        )}
        <option value="visible">{t("stack.overflowVisible")}</option>
        <option value="hidden">{t("stack.overflowClip")}</option>
        <option value="auto">{t("stack.overflowScroll")}</option>
      </Select>
    </div>
  );
}
