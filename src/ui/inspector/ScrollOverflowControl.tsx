import type { JSX } from "preact";
import type { DesignElement, ScrollOverflow } from "../../core/dsl/types";
import { CheckRow } from "../CheckRow";
import { Select } from "../Select";
import { t } from "../../i18n";
import { SUB_LABEL_CLASS } from "../label-tier";

interface ScrollOverflowControlProps {
  element: DesignElement;
  onMutate: (updater: (el: DesignElement) => DesignElement, recordSnapshot?: boolean) => void;
}

export function ScrollOverflowControl({ element, onMutate }: ScrollOverflowControlProps): JSX.Element {
  const el = element as {
    clipContent?: boolean;
    scrollOverflow?: ScrollOverflow;
  };

  const clip = Boolean(el.clipContent);
  const overflow = el.scrollOverflow ?? "none";

  const handleClipChange = (checked: boolean) => {
    onMutate(
      (curr) =>
        ({
          ...curr,
          clipContent: checked,
          ...(checked ? {} : { scrollOverflow: "none" })
        }) as DesignElement,
      true
    );
  };

  const handleOverflowChange = (val: string) => {
    const nextOverflow = val as ScrollOverflow;
    onMutate(
      (curr) =>
        ({
          ...curr,
          scrollOverflow: nextOverflow,
          clipContent: nextOverflow !== "none" ? true : curr.clipContent
        }) as DesignElement,
      true
    );
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
            className="w-28"
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
