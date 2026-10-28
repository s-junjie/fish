import type { ComponentChildren } from "preact";
import { X } from "lucide-react";
import { Button } from "./Button";
import { t } from "../i18n";
import { ROW_DENSE_CLASS, ROW_SPREAD_CLASS } from "./row-style";

/**
 * Shared header for the workbench's floating panels — the popovers and dialogs
 * that name themselves (stroke, effect, advanced layout, style picker, image
 * URL). A sans-serif `text-displaySm` title on the left and action buttons on
 * the right.
 *
 * The title names a panel, not a value, so it uses the same `font-sans` family
 * as the inspector's subject line — not the default mono. Every panel used to
 * hand-roll its own `<div className="flex ...">` plus a close `<Button>`, which
 * is exactly how the titles drifted between mono and sans and between `text-ui`
 * and `text-displaySm`. Owning the title and the close button here keeps them
 * one definition.
 *
 * `className` overrides the row's chrome (padding / divider); the title itself
 * stays `font-sans text-displaySm text-ink`. `actions` are extra buttons shown
 * before the close button (e.g. the style picker's detach / create).
 */
export function PanelHeader({
  title,
  onClose,
  actions,
  className = "",
  titleClassName = ""
}: {
  title: ComponentChildren;
  onClose?: () => void;
  actions?: ComponentChildren;
  className?: string;
  /** Only for a title that is data and can be long — a layer name, not a label. */
  titleClassName?: string;
}) {
  return (
    <div className={`${ROW_SPREAD_CLASS} ${className}`.trim()}>
      <span className={`font-sans text-displaySm text-ink ${titleClassName}`.trim()}>{title}</span>
      {(actions || onClose) && (
        <div className={`${ROW_DENSE_CLASS} shrink-0`}>
          {actions}
          {onClose && (
            <Button
              size="icon"
              type="button"
              onClick={onClose}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <X size={12} />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
