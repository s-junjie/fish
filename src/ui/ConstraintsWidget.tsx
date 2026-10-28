import { LayoutConstraints } from "../core/dsl/types";
import { SUB_LABEL_CLASS } from "./label-tier";
import { t } from "../i18n";
import { Select } from "./Select";
import { ROW_TIGHT_CLASS } from "./row-style";

interface ConstraintsWidgetProps {
  constraints?: LayoutConstraints;
  onChange: (next: LayoutConstraints) => void;
}

type HMode = NonNullable<LayoutConstraints["horizontal"]>;
type VMode = NonNullable<LayoutConstraints["vertical"]>;

export function ConstraintsWidget({ constraints, onChange }: ConstraintsWidgetProps) {
  const horizontal = constraints?.horizontal || "left";
  const vertical = constraints?.vertical || "top";

  const isLeft = horizontal === "left" || horizontal === "stretch" || horizontal === "scale";
  const isRight = horizontal === "right" || horizontal === "stretch" || horizontal === "scale";
  const isHCenter = horizontal === "center";

  const isTop = vertical === "top" || vertical === "stretch" || vertical === "scale";
  const isBottom = vertical === "bottom" || vertical === "stretch" || vertical === "scale";
  const isVCenter = vertical === "center";

  const setHorizontal = (target: HMode) => onChange({ ...constraints, horizontal: target });
  const setVertical = (target: VMode) => onChange({ ...constraints, vertical: target });

  const state = (on: boolean) => (on ? t("stack.constraintOn") : t("stack.constraintOff"));
  const pinTitle = (key: string, on: boolean) => t(key, { state: state(on) });

  // Bars are mutually exclusive: clicking a side pins that side alone and
  // clears the other. left+right / scale are reachable via the dropdowns only.
  const toggleLeft = () => setHorizontal("left");
  const toggleRight = () => setHorizontal("right");
  const toggleTop = () => setVertical("top");
  const toggleBottom = () => setVertical("bottom");

  return (
    <div className="flex items-center gap-3">
      {/* Visual interactive constraints box */}
      <div
        className="relative w-[56px] h-[56px] bg-panel rounded-ctl border border-rule-strong flex items-center justify-center select-none"
        title={t("stack.constraints")}
      >
        {/* Outer dashed border frame representation */}
        <div className="absolute inset-[6px] rounded-swatch border border-dashed border-rule-strong pointer-events-none" />

        {/* Top Pin Bar */}
        <button
          type="button"
          onClick={toggleTop}
          className="absolute top-[6px] left-[20px] right-[20px] h-[10px] flex items-center justify-center cursor-default group"
          title={pinTitle("stack.constraintPinTop", isTop)}
        >
          <div
            className={`w-[2px] h-full rounded-ctl transition-colors ${
              isTop ? "bg-brand" : "bg-rule-strong group-hover:bg-ink-muted"
            }`}
          />
        </button>

        {/* Bottom Pin Bar */}
        <button
          type="button"
          onClick={toggleBottom}
          className="absolute bottom-[6px] left-[20px] right-[20px] h-[10px] flex items-center justify-center cursor-default group"
          title={pinTitle("stack.constraintPinBottom", isBottom)}
        >
          <div
            className={`w-[2px] h-full rounded-ctl transition-colors ${
              isBottom ? "bg-brand" : "bg-rule-strong group-hover:bg-ink-muted"
            }`}
          />
        </button>

        {/* Left Pin Bar */}
        <button
          type="button"
          onClick={toggleLeft}
          className="absolute left-[6px] top-[20px] bottom-[20px] w-[10px] flex items-center justify-center cursor-default group"
          title={pinTitle("stack.constraintPinLeft", isLeft)}
        >
          <div
            className={`h-[2px] w-full rounded-ctl transition-colors ${
              isLeft ? "bg-brand" : "bg-rule-strong group-hover:bg-ink-muted"
            }`}
          />
        </button>

        {/* Right Pin Bar */}
        <button
          type="button"
          onClick={toggleRight}
          className="absolute right-[6px] top-[20px] bottom-[20px] w-[10px] flex items-center justify-center cursor-default group"
          title={pinTitle("stack.constraintPinRight", isRight)}
        >
          <div
            className={`h-[2px] w-full rounded-ctl transition-colors ${
              isRight ? "bg-brand" : "bg-rule-strong group-hover:bg-ink-muted"
            }`}
          />
        </button>

        {/* Center lines: horizontal and vertical are independent toggles */}
        <div className="relative w-[18px] h-[18px] bg-raised border border-rule-strong rounded-swatch cursor-default hover:border-ink-muted transition-colors">
          {/* Horizontal center line */}
          <button
            type="button"
            onClick={() => setHorizontal(isHCenter ? "left" : "center")}
            className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[7px] flex items-center justify-center group"
            title={pinTitle("stack.constraintPinHCenter", isHCenter)}
          >
            <div
              className={`w-full h-[1px] ${
                isHCenter
                  ? "bg-brand"
                  : "border-t border-dashed border-ink-muted group-hover:border-ink-muted"
              }`}
            />
          </button>
          {/* Vertical center line */}
          <button
            type="button"
            onClick={() => setVertical(isVCenter ? "top" : "center")}
            className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-[7px] flex items-center justify-center group"
            title={pinTitle("stack.constraintPinVCenter", isVCenter)}
          >
            <div
              className={`h-full w-[1px] ${
                isVCenter
                  ? "bg-brand"
                  : "border-l border-dashed border-ink-muted group-hover:border-ink-muted"
              }`}
            />
          </button>
        </div>
      </div>

      {/* Constraints Dropdowns */}
      <div className="flex-1 space-y-1.5">
        <div className={ROW_TIGHT_CLASS}>
          <span className={`${SUB_LABEL_CLASS} w-3`}>H</span>
          <Select
            className="flex-1"
            data-constraints-axis="h"
            value={horizontal}
            onChange={(v) => setHorizontal(v as HMode)}
          >
            <option value="left">{t("stack.constraintLeft")}</option>
            <option value="right">{t("stack.constraintRight")}</option>
            <option value="center">{t("stack.constraintCenter")}</option>
            <option value="stretch">{t("stack.constraintStretch")}</option>
            <option value="scale">{t("stack.constraintScale")}</option>
          </Select>
        </div>

        <div className={ROW_TIGHT_CLASS}>
          <span className={`${SUB_LABEL_CLASS} w-3`}>V</span>
          <Select
            className="flex-1"
            data-constraints-axis="v"
            value={vertical}
            onChange={(v) => setVertical(v as VMode)}
          >
            <option value="top">{t("stack.constraintTop")}</option>
            <option value="bottom">{t("stack.constraintBottom")}</option>
            <option value="center">{t("stack.constraintCenter")}</option>
            <option value="stretch">{t("stack.constraintStretch")}</option>
            <option value="scale">{t("stack.constraintScale")}</option>
          </Select>
        </div>
      </div>
    </div>
  );
}
