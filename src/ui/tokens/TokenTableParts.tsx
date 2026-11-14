import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import type { ColorToken, DocumentMode, NumberToken, NumberTokenCategory } from "../../core/dsl/types";
import { t } from "../../i18n";
import { CategoryIcon, NUMBER_TOKEN_CATEGORIES } from "./CategoryIcon";

/** The grip that resizes a column — the name column and every mode column. */
export function ColumnResizer({
  colKey,
  active,
  onStart
}: {
  colKey: string;
  active: boolean;
  onStart: (colKey: string, e: PointerEvent) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => onStart(colKey, e)}
      className="absolute top-0 -right-1.5 w-3 h-full cursor-col-resize z-20 group/resize flex justify-center items-center"
      aria-hidden="true"
    >
      <div
        className={`w-[2px] h-full transition-colors ${
          active ? "bg-brand" : "group-hover/resize:bg-brand/70"
        }`}
      />
    </div>
  );
}

/** One mode's header: its name (double-click renames), its delete, its width grip. */
export function ModeHeaderCell({
  mode,
  width,
  singleMode,
  showDelete,
  editing,
  editingName,
  inputRef,
  resizing,
  onStartResize,
  onStartRename,
  onChangeName,
  onCommitName,
  onCancelRename,
  onDelete
}: {
  mode: DocumentMode;
  width: number;
  /** One mode is not a choice, so the column is titled by what it holds. */
  singleMode: boolean;
  showDelete: boolean;
  editing: boolean;
  editingName: string;
  inputRef: { current: HTMLInputElement | null };
  resizing: boolean;
  onStartResize: (colKey: string, e: PointerEvent) => void;
  onStartRename: (mode: DocumentMode) => void;
  onChangeName: (next: string) => void;
  onCommitName: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) {
  return (
    <th
      className="px-3 py-2 shrink-0 group/col relative border-l border-rule"
      style={{ width: `${width}px`, minWidth: `${width}px` }}
    >
      <div className="flex items-center justify-between gap-1.5 min-w-0 pr-1">
        {editing ? (
          <input
            ref={inputRef}
            name="token-mode-name"
            value={editingName}
            onInput={(e) => onChangeName((e.currentTarget as HTMLInputElement).value)}
            onBlur={onCommitName}
            onKeyDown={(e) => {
              if (e.isComposing || (e as any).keyCode === 229) return;
              if (e.key === "Enter") onCommitName();
              if (e.key === "Escape") onCancelRename();
            }}
            className="w-full bg-inset rounded-swatch px-1 text-ui text-ink focus:outline-none ring-1 ring-brand"
          />
        ) : singleMode ? (
          <span className="truncate" title={t("tokens.columnValue")}>
            {t("tokens.columnValue")}
          </span>
        ) : (
          <span
            onDblClick={() => onStartRename(mode)}
            className="truncate cursor-text hover:text-ink transition-colors"
            title={mode.name}
          >
            {mode.name}
          </span>
        )}
        {showDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="opacity-0 group-hover/col:opacity-100 p-0.5 rounded-ctl text-ink-muted hover:text-measure-coral transition-opacity shrink-0"
            title={t("tokens.deleteMode")}
            aria-label={t("tokens.deleteMode")}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      <ColumnResizer colKey={mode.id} active={resizing} onStart={onStartResize} />
    </th>
  );
}

/** A `bg/…` group's own row: collapse toggle and item count. */
export function GroupRow({
  name,
  count,
  collapsed,
  colSpan,
  onToggle
}: {
  name: string;
  count: number;
  collapsed: boolean;
  colSpan: number;
  onToggle: () => void;
}) {
  return (
    <tr
      className="bg-surface/70 hover:bg-surface transition-colors cursor-pointer"
      onClick={onToggle}
    >
      <td colSpan={colSpan} className="px-3 py-1.5">
        <div className="flex items-center gap-1.5 font-medium text-ink">
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span className="text-ui font-medium">{name}</span>
          <span className="text-micro text-ink-muted font-normal">({count})</span>
        </div>
      </td>
    </tr>
  );
}

/** The sticky left name column for a colour or number token row. */
export function TokenNameCell({
  token,
  displayName,
  fullName,
  width,
  isEditingName,
  editingNameValue,
  editNameInputRef,
  onDelete,
  onCategoryChange,
  onStartRename,
  onChangeEditingName,
  onCommitRename,
  onCancelRename
}: {
  token: ColorToken | NumberToken;
  displayName: string;
  fullName: string;
  width: number;
  isEditingName: boolean;
  editingNameValue: string;
  editNameInputRef: { current: HTMLInputElement | null };
  onDelete: () => void;
  onCategoryChange: (category: NumberTokenCategory) => void;
  onStartRename: () => void;
  onChangeEditingName: (next: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}) {
  return (
    <td
      className="sticky left-0 z-10 bg-panel border-r border-rule px-3 py-1.5 align-middle group-hover:bg-surface transition-colors shrink-0"
      style={{ width: `${width}px`, minWidth: `${width}px` }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={onDelete}
          className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-muted hover:text-measure-coral transition-all rounded-ctl shrink-0"
          title={t("tokens.deleteAction")}
          aria-label={t("tokens.deleteAction")}
        >
          <Trash2 size={12} />
        </button>
        {token.type === "number" && (
          <div
            className="relative group/cat shrink-0 flex items-center justify-center cursor-pointer"
            title={`${t("tokens.category")}: ${t(`tokens.categories.${token.category ?? "spacing"}`)}`}
          >
            <CategoryIcon category={token.category} />
            <select
              name="token-category"
              value={token.category ?? "spacing"}
              onChange={(e) =>
                onCategoryChange((e.target as HTMLSelectElement).value as NumberTokenCategory)
              }
              className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
              title={t("tokens.category")}
              aria-label={t("tokens.category")}
            >
              {NUMBER_TOKEN_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {t(`tokens.categories.${cat}`)}
                </option>
              ))}
            </select>
          </div>
        )}
        {isEditingName ? (
          <input
            ref={editNameInputRef}
            name="token-name"
            value={editingNameValue}
            onInput={(e) => onChangeEditingName((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.isComposing || (e as any).keyCode === 229) return;
              if (e.key === "Enter") onCommitRename();
              if (e.key === "Escape") onCancelRename();
            }}
            onBlur={onCommitRename}
            className="flex-1 min-w-0 h-6 px-1.5 text-row text-ink bg-inset rounded-swatch border border-rule focus:outline-none focus:border-brand"
          />
        ) : (
          <span
            onDblClick={onStartRename}
            className="truncate text-row cursor-text text-ink hover:text-brand transition-colors"
            title={fullName}
          >
            {displayName}
          </span>
        )}
      </div>
    </td>
  );
}
