import { AlignmentType } from "../../core/interactions/alignment";
import {
  AlignHorizontalJustifyStart,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd
} from "lucide-react";
import { t } from "../../i18n";
import { iconCell } from "./icon-cell-style";

interface AlignmentToolbarProps {
  onAlign: (type: AlignmentType) => void;
  /** The selection's position is owned by an auto-layout container, so align has nothing to move. */
  disabled?: boolean;
}

// `iconCell` is the six cells' shared box — see icon-cell-style.ts. The
// disabled half is theirs alone: why a row is dead is a property of the
// selection, not of the grid.
const BUTTON =
  `${iconCell()} ` +
  "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-field disabled:hover:text-ink-muted";

export function AlignmentToolbar({ onAlign, disabled = false }: AlignmentToolbarProps) {
  // One hint for the whole row: why it is dead is a property of the selection,
  // not of any one of the six alignments.
  const blockedTitle = disabled ? t("stack.sizingControlled") : undefined;
  const title = (key: string) => blockedTitle ?? t(`alignText.${key}`);

  return (
    <div data-align-row="true" className="grid grid-cols-6 gap-1 mt-2 mb-0.5">
      <button onClick={() => onAlign("left")} className={BUTTON} disabled={disabled} title={title("left")} aria-label={title("left")}>
        <AlignHorizontalJustifyStart size={13} />
      </button>
      <button onClick={() => onAlign("center")} className={BUTTON} disabled={disabled} title={title("center")} aria-label={title("center")}>
        <AlignHorizontalJustifyCenter size={13} />
      </button>
      <button onClick={() => onAlign("right")} className={BUTTON} disabled={disabled} title={title("right")} aria-label={title("right")}>
        <AlignHorizontalJustifyEnd size={13} />
      </button>
      <button onClick={() => onAlign("top")} className={BUTTON} disabled={disabled} title={title("top")} aria-label={title("top")}>
        <AlignVerticalJustifyStart size={13} />
      </button>
      <button onClick={() => onAlign("middle")} className={BUTTON} disabled={disabled} title={title("middle")} aria-label={title("middle")}>
        <AlignVerticalJustifyCenter size={13} />
      </button>
      <button onClick={() => onAlign("bottom")} className={BUTTON} disabled={disabled} title={title("bottom")} aria-label={title("bottom")}>
        <AlignVerticalJustifyEnd size={13} />
      </button>
    </div>
  );
}
