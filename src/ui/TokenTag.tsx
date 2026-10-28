import type { ComponentChildren, JSX } from "preact";
import { X } from "lucide-react";
import { t } from "../i18n";

export interface TokenTagProps {
  /** The token name or missing placeholder. */
  name: string;
  /** Optional resolved value to display beside the name (e.g. "26px", "8"). */
  value?: ComponentChildren;
  /** Whether the token is missing from the document tokens list. */
  missing?: boolean;
  /** Custom hover title. */
  title?: string;
  /** Click handler to open the token picker. */
  onClick?: JSX.MouseEventHandler<HTMLDivElement>;
  /** Double click handler to detach the token. */
  onDblClick?: JSX.MouseEventHandler<HTMLDivElement>;
  /** Pointer down handler to intercept drags. */
  onPointerDown?: JSX.PointerEventHandler<HTMLDivElement>;
  /** Detach handler. When provided, renders the close (x) button. */
  onDetach?: () => void;
  detachTitle?: string;
  className?: string;
  tagProps?: Record<string, string | undefined>;
  detachProps?: Record<string, string | undefined>;
}

/**
 * Standard tag badge for bound tokens across number inputs, color rows, and gradient stops.
 */
export function TokenTag({
  name,
  value,
  missing = false,
  title,
  onClick,
  onDblClick,
  onPointerDown,
  onDetach,
  detachTitle,
  className = "",
  tagProps,
  detachProps
}: TokenTagProps) {
  const isClickable = Boolean(onClick);

  return (
    <div
      {...tagProps}
      title={title ?? name}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDblClick={onDblClick}
      className={`group/tag inline-flex items-center gap-1 max-w-full min-w-0 h-[19px] px-1.5 rounded-sm bg-raised border border-rule text-meta transition-colors ${
        isClickable ? "cursor-pointer hover:border-rule-strong" : "cursor-default"
      } ${className}`}
    >
      <span
        className={`truncate font-medium select-none ${
          missing ? "text-ink-muted italic" : "text-ink"
        }`}
      >
        {name}
      </span>
      {value !== undefined && (
        <span className="text-ink-muted font-normal shrink-0 select-none">
          {value}
        </span>
      )}
      {onDetach ? (
        <button
          type="button"
          {...detachProps}
          title={detachTitle ?? t("tokens.detach")}
          aria-label={detachTitle ?? t("tokens.detach")}
          onClick={(e) => {
            e.stopPropagation();
            onDetach();
          }}
          className="shrink-0 -mr-0.5 p-0.5 rounded-sm text-ink-muted hover:text-ink hover:bg-raised transition-colors"
        >
          <X size={10} />
        </button>
      ) : null}
    </div>
  );
}
