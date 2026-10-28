import { X, MessageSquare } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../Button";
import { TITLE_BAR_HEIGHT } from "../toolbar/titlebar-layout";
import { CommentsPanel, type CommentsPanelProps } from "./CommentsPanel";

export interface CommentsRailProps extends CommentsPanelProps {
  hidden?: boolean;
  /** Leaves comment mode, which is what hides this rail again. */
  onExit: () => void;
}

/**
 * The comment rail: the right column while the comment tool is armed.
 *
 * It takes the inspector's slot rather than floating beside it — the two are
 * both 288px plates on the same edge, and a comment is about the layer under
 * the pin, not about the selection the inspector would be describing. Swapping
 * the plate (rather than adding a second one) keeps the canvas geometry, and
 * with it `unobstructedArea` and every fit-to-view measurement, unchanged.
 *
 * It is visible ONLY in comment mode: a designer with no comments in mind gets
 * their inspector, and the way back to the list is the tool that created it.
 */
export function CommentsRail({ hidden = false, onExit, ...panel }: CommentsRailProps) {
  return (
    <div
      data-ui-panel="right"
      data-comment-rail="true"
      style={{ top: TITLE_BAR_HEIGHT }}
      className={`absolute right-0 bottom-0 w-72 bg-panel border-l border-rule flex flex-col z-20 shrink-0 text-ui overflow-hidden transition-transform duration-slide ease-slide ${
        hidden ? "translate-x-full" : "translate-x-0"
      }`}
    >
      <div className="h-10 px-2.5 border-b border-rule flex items-center justify-between gap-2 shrink-0 bg-panel">
        <span className="font-sans text-displaySm text-ink flex items-center gap-1.5 min-w-0">
          <MessageSquare size={12} className="text-brand shrink-0" />
          <span className="truncate">{t("comments.tab")}</span>
        </span>
        <Button
          size="icon"
          type="button"
          onClick={onExit}
          title={t("comments.exit")}
          aria-label={t("comments.exit")}
        >
          <X size={12} />
        </Button>
      </div>

      <CommentsPanel {...panel} />
    </div>
  );
}
