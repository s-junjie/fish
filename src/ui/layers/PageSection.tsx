import { useState, useRef, useEffect } from "preact/hooks";
import { Page } from "../../core/dsl/types";
import { t } from "../../i18n";
import { Plus, File } from "lucide-react";
import { RailSectionHeader } from "./RailSectionHeader";
import { Button } from "../Button";
import { INLINE_RENAME_INPUT_CLASS } from "../rename-style";

interface PageSectionProps {
  pages: Page[];
  activePageId?: string;
  onSelectPage?: (pageId: string) => void;
  onAddPage?: () => void;
  /** Arm rename on the page: the same controlled id the layer tree uses. */
  onStartRenamePage?: (pageId: string) => void;
  onRenamePage?: (pageId: string, newName: string) => void;
  onDeletePage?: (pageId: string) => void;
  onDuplicatePage?: (pageId: string) => void;
  onPageContextMenu?: (e: MouseEvent, page: Page) => void;
  /**
   * Which page is being renamed, owned by the shell. A page row is a layer row
   * in another list, so its rename is armed the same way — one id, one owner —
   * and the draft below is the only state that lives here.
   */
  renamingPageId?: string | null;
  onCancelRenamePage?: () => void;
}

export function PageSection({
  pages,
  activePageId,
  onSelectPage,
  onAddPage,
  onStartRenamePage,
  onRenamePage,
  onDeletePage,
  onDuplicatePage,
  onPageContextMenu,
  renamingPageId,
  onCancelRenamePage
}: PageSectionProps) {
  const [isPagesCollapsed, setIsPagesCollapsed] = useState(false);
  const [pageRenameDraft, setPageRenameDraft] = useState("");
  const pageRenameInputRef = useRef<HTMLInputElement>(null);
  /* The field unmounts the moment the rename ends, and unmounting a focused
     input fires its `blur` — so Enter and Escape both re-enter the commit path
     with the draft still in hand. This flag marks the exit as already decided,
     which is what keeps Escape a discard rather than a late commit. */
  const renameSettledRef = useRef(false);

  // Seed the draft from the page `renamingPageId` names, the way the layer tree
  // does: the id arrives from the shell (double-click, or the menu), and this is
  // the one place that turns it into a focused field.
  useEffect(() => {
    if (!renamingPageId) return;
    const target = pages.find((p) => p.id === renamingPageId);
    if (!target) return;
    renameSettledRef.current = false;
    setPageRenameDraft(target.name);
    requestAnimationFrame(() => {
      pageRenameInputRef.current?.focus();
      pageRenameInputRef.current?.select();
    });
  }, [renamingPageId]);

  const handleContextMenu = (e: MouseEvent, page: Page) => {
    e.preventDefault();
    e.stopPropagation();
    onPageContextMenu?.(e, page);
  };

  /* One exit path for all three ways out (blur, Enter, Escape): `commit` says
     whether the draft is worth writing, and the flag says so once. */
  const endRename = (pageId: string, commit: boolean) => {
    if (renameSettledRef.current) return;
    renameSettledRef.current = true;
    const trimmed = pageRenameDraft.trim();
    if (commit && trimmed && onRenamePage) onRenamePage(pageId, trimmed);
    onCancelRenamePage?.();
  };

  return (
    /* No `border-b`: the reference layout separates these blocks with the
       leader rule that closes each section label, not with a hard divider —
       a full-width rule here competed with the two labels it sat between. */
    <div data-pages-section="true" className="shrink-0">
      {/* The gutter lives on the LABEL, not the row. The chevron hangs in the
          12px gutter itself (absolutely positioned to its left), so
          "PAGES" starts on the same 12px edge as the tabs and the layer
          rows instead of 17px further in. */}
      <RailSectionHeader
        label={t("pages.title")}
        collapsed={isPagesCollapsed}
        onToggle={() => setIsPagesCollapsed((prev) => !prev)}
        trailing={
          onAddPage ? (
            <Button
              size="icon"
              type="button"
              onClick={onAddPage}
              title={t("pages.add")}
            >
              <Plus size={13} />
            </Button>
          ) : null
        }
      />

      {!isPagesCollapsed && (
        <div className="px-2 pb-2 space-y-0.5 max-h-48 overflow-y-auto">
          {pages.map((page) => {
            const isActive = page.id === activePageId;
            const isRenamingThis = renamingPageId === page.id;

            return (
              <div
                key={page.id}
                data-page-id={page.id}
                onClick={() => {
                  if (!isRenamingThis && onSelectPage) {
                    onSelectPage(page.id);
                  }
                }}
                onDblClick={(e) => {
                  e.stopPropagation();
                  onStartRenamePage?.(page.id);
                }}
                onContextMenu={(e) => handleContextMenu(e, page)}
                className={`group relative flex items-center justify-between h-[26px] rounded-ctl text-ui transition-colors duration-micro ease-snap cursor-default ${
                  isActive
                    ? "bg-selection text-ink"
                    : "text-ink-dim hover:text-ink hover:bg-raised"
                }`}
                /* A page row is a depth-0 row, so its ICON must land on the same
                   column a depth-0 layer's icon does. The layer icon sits at
                   30px: the scroller's 8px inset plus the 8px BASE_PADDING plus
                   the 14px twisty slot — there is NO gap between the twisty and
                   the icon (the row's `gap-1.5` only separates icon and label).
                   This row has no twisty, so `paddingLeft` absorbs the whole
                   22px and there is deliberately NO spacer span here. The label
                   then follows icon + 6px gap, landing on the same 49px as a
                   layer's. */
                style={{ paddingLeft: "22px", paddingRight: "10px" }}
              >
                {/* The same selection mark a layer row wears, at the same
                    height: a page is a row in the same list, not a different
                    species. Absolute so it costs no layout. */}
                {isActive && (
                  <span
                    aria-hidden="true"
                    data-page-selected-bar={page.id}
                    className="absolute left-1 top-1/2 -translate-y-1/2 w-0.5 h-3.5 rounded-full bg-brand pointer-events-none"
                  />
                )}
                <div className="flex items-center gap-1.5 truncate flex-1 min-w-0">
                  <File size={13} className={isActive ? "text-ink shrink-0" : "text-ink-muted shrink-0"} />
                  {isRenamingThis ? (
                    <input
                      ref={pageRenameInputRef}
                      data-page-rename={page.id}
                      type="text"
                      name="page-name"
                      value={pageRenameDraft}
                      onInput={(e) => setPageRenameDraft((e.target as HTMLInputElement).value)}
                      onBlur={() => endRename(page.id, true)}
                      onKeyDown={(e) => {
                        if (e.isComposing || (e as any).keyCode === 229) return;
                        if (e.key === "Enter") {
                          e.preventDefault();
                          endRename(page.id, true);
                        } else if (e.key === "Escape") {
                          endRename(page.id, false);
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onDblClick={(e) => e.stopPropagation()}
                      className={INLINE_RENAME_INPUT_CLASS}
                    />
                  ) : (
                    <span className="truncate select-none">{page.name}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
