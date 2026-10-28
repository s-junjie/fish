import type { ComponentChildren } from "preact";
import { Link2Off } from "lucide-react";
import { StyleCard, STYLE_CARD_TRAILING_BG } from "./StyleCard";
import { Button } from "../Button";

interface StylePillProps {
  styleName: string;
  preview: ComponentChildren;
  /** Second line. Only a style with something to say past its name carries one. */
  subtitle?: string;
  /** Opens the style picker, anchored on the card. */
  onSelect: (el: HTMLElement) => void;
  onUnlink: () => void;
  selectTitle?: string;
  unlinkTitle?: string;
  rowProps?: Record<string, string>;
  /** Buttons belonging to the row but not to the pill's own two actions. */
  trailing?: ComponentChildren;
}
export function StylePill({
  styleName,
  preview,
  subtitle,
  onSelect,
  onUnlink,
  selectTitle,
  unlinkTitle,
  rowProps,
  trailing
}: StylePillProps) {
  return (
    <StyleCard
      rowProps={{
        "data-style-pill-select": "",
        ...(selectTitle ? { title: selectTitle } : {}),
        ...rowProps
      }}
      preview={preview}
      name={styleName}
      subtitle={subtitle}
      onClick={(e) => onSelect(e.currentTarget as HTMLElement)}
      className="group"
      trailing={
        <>
          {/* The unlink button appears on hover */}
          <Button
            size="icon"
            type="button"
            data-style-pill-unlink=""
            onClick={(e) => {
              e.stopPropagation();
              onUnlink();
            }}
            title={unlinkTitle}
            aria-label={unlinkTitle}
            className={`${STYLE_CARD_TRAILING_BG} opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-base ease-snap`}
          >
            <Link2Off size={13} />
          </Button>
          {trailing}
        </>
      }
    />
  );
}
