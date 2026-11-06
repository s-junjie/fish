import type { JSX } from "preact";
import type { DesignDocument, DesignElement, InstanceElement, ScrollOverflow } from "../../core/dsl/types";
import { CheckRow } from "../CheckRow";
import { Select } from "../Select";
import { t } from "../../i18n";
import { SUB_LABEL_CLASS } from "../label-tier";
import { findMasterComponent } from "../../core/interactions/component-inventory";

interface ScrollOverflowControlProps {
  element: DesignElement;
  docRef?: { current: DesignDocument };
  onMutate: (updater: (el: DesignElement) => DesignElement, recordSnapshot?: boolean) => void;
}

/**
 * Turning clipping off ends the scroll.
 *
 * Both renderers offset a container's children only while it clips, so a scroll
 * position left behind on a container that stopped clipping is invisible on the
 * canvas and still moves the box that hit testing and the selection frame read.
 * The overflow goes with it — there is nothing left to overflow into.
 */
export function withClipContent(el: DesignElement, checked: boolean): DesignElement {
  if (checked) return { ...el, clipContent: true } as unknown as DesignElement;
  return {
    ...el,
    clipContent: false,
    scrollOverflow: "none",
    scrollX: undefined,
    scrollY: undefined
  } as unknown as DesignElement;
}

/** Picking a mode: anything that scrolls needs clipping, and "none" ends the pan. */
export function withScrollOverflow(el: DesignElement, value: ScrollOverflow): DesignElement {
  if (value === "none") {
    return {
      ...el,
      scrollOverflow: "none",
      clipContent: Boolean((el as { clipContent?: boolean }).clipContent),
      scrollX: undefined,
      scrollY: undefined
    } as unknown as DesignElement;
  }
  return { ...el, scrollOverflow: value, clipContent: true } as unknown as DesignElement;
}

export function ScrollOverflowControl({ element, docRef, onMutate }: ScrollOverflowControlProps): JSX.Element {
  const el = element as {
    clipContent?: boolean;
    scrollOverflow?: ScrollOverflow;
  };

  const master =
    element.type === "instance" && docRef
      ? findMasterComponent(docRef.current, (element as InstanceElement).componentId)
      : null;

  const clip = el.clipContent !== undefined ? Boolean(el.clipContent) : Boolean(master?.clipContent);
  const overflow = el.scrollOverflow ?? master?.scrollOverflow ?? "none";

  const handleClipChange = (checked: boolean) => {
    onMutate((curr) => withClipContent(curr, checked), true);
  };

  const handleOverflowChange = (val: string) => {
    onMutate((curr) => withScrollOverflow(curr, val as ScrollOverflow), true);
  };

  return (
    <div className="flex flex-col gap-2">
      <CheckRow
        testId="clip-content"
        checked={clip}
        onChange={handleClipChange}
        label={t("stack.clipContent")}
      />

      {clip && (
        <div className="flex items-center gap-2">
          <span className={`${SUB_LABEL_CLASS} shrink-0`}>{t("stack.overflow")}</span>
          <Select
            className="flex-1 min-w-0"
            value={overflow}
            onChange={handleOverflowChange}
          >
            <option value="none">{t("stack.overflowNone")}</option>
            <option value="vertical">{t("stack.overflowVertical")}</option>
            <option value="horizontal">{t("stack.overflowHorizontal")}</option>
            <option value="both">{t("stack.overflowBoth")}</option>
          </Select>
        </div>
      )}
    </div>
  );
}
