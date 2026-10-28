import { useState, useRef, useEffect } from "preact/hooks";
import { createPortal } from "preact/compat";
import {
  Hash,
  Palette,
  Plus,
  Search,
  SwatchBook,
  X
} from "lucide-react";
import type { DesignDocument, NumberTokenCategory } from "../../core/dsl/types";
import {
  addDocumentMode,
  addDocumentNumberMode,
  getDocumentModes,
  getDocumentNumberModes
} from "../../core/interactions/mode-ops";
import { colorTokensOf, createColorToken } from "../../core/interactions/token-ops";
import {
  createNumberToken,
  isNumberToken
} from "../../core/interactions/number-token-ops";
import { addTokenToDoc } from "../../core/interactions/style-ops";
import { t } from "../../i18n";
import { Button } from "../Button";
import { TokensTable } from "./TokensTable";
import { AddModeModal } from "./AddModeModal";
import { generateUniqueTokenName } from "./token-table-utils";
import { CategoryIcon, NUMBER_TOKEN_CATEGORIES } from "./CategoryIcon";

interface TokensTablePanelProps {
  doc: DesignDocument;
  docRef: { current: DesignDocument };
  commitSnapshot: (newDoc: DesignDocument) => void;
  isOpen: boolean;
  onClose: () => void;
}

export function TokensTablePanel({
  doc,
  docRef,
  commitSnapshot,
  isOpen,
  onClose
}: TokensTablePanelProps) {
  if (!isOpen) return null;

  const [activeTab, setActiveTab] = useState<"colors" | "numbers">("colors");
  const [activeCategory, setActiveCategory] = useState<NumberTokenCategory | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isAddModeModalOpen, setIsAddModeModalOpen] = useState(false);
  const [newlyCreatedTokenId, setNewlyCreatedTokenId] = useState<string | null>(null);

  // Position and size state for floating panel
  const [pos, setPos] = useState(() => ({
    x: Math.max(20, Math.round((window.innerWidth - 760) / 2)),
    y: Math.max(30, Math.round((window.innerHeight - 520) / 2))
  }));
  const [size, setSize] = useState({ width: 760, height: 520 });

  const posRef = useRef(pos);
  posRef.current = pos;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, startX: 0, startY: 0 });

  const isResizingRef = useRef(false);
  const resizeModeRef = useRef<"both" | "width" | "height">("both");
  const resizeStartRef = useRef({ mouseX: 0, mouseY: 0, startW: 0, startH: 0 });

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (isDraggingRef.current) {
        const dx = e.clientX - dragStartRef.current.mouseX;
        const dy = e.clientY - dragStartRef.current.mouseY;
        const curW = sizeRef.current.width;
        setPos({
          x: Math.max(10, Math.min(window.innerWidth - curW - 10, dragStartRef.current.startX + dx)),
          y: Math.max(10, Math.min(window.innerHeight - 80, dragStartRef.current.startY + dy))
        });
      } else if (isResizingRef.current) {
        const dx = e.clientX - resizeStartRef.current.mouseX;
        const dy = e.clientY - resizeStartRef.current.mouseY;
        const curX = posRef.current.x;
        const curY = posRef.current.y;
        const minW = 560;
        const minH = 360;
        const maxW = Math.max(minW, window.innerWidth - curX - 16);
        const maxH = Math.max(minH, window.innerHeight - curY - 16);

        const mode = resizeModeRef.current;
        const nextW = mode === "height"
          ? sizeRef.current.width
          : Math.max(minW, Math.min(maxW, resizeStartRef.current.startW + dx));
        const nextH = mode === "width"
          ? sizeRef.current.height
          : Math.max(minH, Math.min(maxH, resizeStartRef.current.startH + dy));

        setSize({ width: Math.round(nextW), height: Math.round(nextH) });
      }
    };

    const onPointerUp = () => {
      isDraggingRef.current = false;
      isResizingRef.current = false;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  const handleHeaderPointerDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, input, select")) return;
    isDraggingRef.current = true;
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: pos.x,
      startY: pos.y
    };
  };

  const handleResizePointerDown = (e: PointerEvent, mode: "both" | "width" | "height") => {
    e.stopPropagation();
    e.preventDefault();
    isResizingRef.current = true;
    resizeModeRef.current = mode;
    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startW: sizeRef.current.width,
      startH: sizeRef.current.height
    };
  };

  // The panel shows ONE axis at a time, so the mode columns come from the axis
  // the active tab belongs to: `Dark` is a colour question and `Compact` a
  // spatial one, and a table that offered both in both views is the defect the
  // split exists to remove.
  const colorModes = getDocumentModes(doc);
  const numberModes = getDocumentNumberModes(doc);
  const modes = activeTab === "colors" ? colorModes : numberModes;
  const colorCount = colorTokensOf(doc.tokens).length;
  const allNumberTokens = (doc.tokens || []).filter(isNumberToken);
  const numberCount = allNumberTokens.length;
  const categoryCounts: Record<string, number> = {
    all: numberCount,
    spacing: allNumberTokens.filter((t) => (t.category ?? "spacing") === "spacing").length,
    radius: allNumberTokens.filter((t) => t.category === "radius").length,
    stroke: allNumberTokens.filter((t) => t.category === "stroke").length,
    size: allNumberTokens.filter((t) => t.category === "size").length,
    typography: allNumberTokens.filter((t) => t.category === "typography").length,
    effect: allNumberTokens.filter((t) => t.category === "effect").length
  };

  const handleConfirmAddMode = (cleanName: string) => {
    const { doc: nextDoc } =
      activeTab === "colors"
        ? addDocumentMode(docRef.current, cleanName)
        : addDocumentNumberMode(docRef.current, cleanName);
    commitSnapshot(nextDoc);
  };

  const handleCreateNewToken = () => {
    const current = docRef.current;
    if (activeTab === "colors") {
      const existing = colorTokensOf(current.tokens);
      const name = generateUniqueTokenName(existing, "color");
      const created = createColorToken(name, "#1B72FF");
      commitSnapshot(addTokenToDoc(current, created));
      setNewlyCreatedTokenId(created.id);
    } else {
      const existing = allNumberTokens;
      const cat: NumberTokenCategory = activeCategory === "all" ? "spacing" : activeCategory;
      const name = generateUniqueTokenName(existing, cat);
      const created = createNumberToken(name, 8, cat);
      commitSnapshot(addTokenToDoc(current, created));
      setNewlyCreatedTokenId(created.id);
    }
  };

  return createPortal(
    <div
      style={{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        width: `${size.width}px`,
        height: `${size.height}px`
      }}
      className="fixed z-[70] bg-panel border border-rule-strong shadow-popover rounded-panel flex flex-col overflow-hidden font-sans select-none animate-pop-in"
    >
      {/* Header */}
      <div
        onPointerDown={handleHeaderPointerDown}
        className="flex items-center justify-between px-3 h-10 border-b border-rule cursor-move bg-surface text-ink font-sans flex-none gap-2"
      >
        <div className="flex items-center gap-2 shrink-0">
          <SwatchBook size={14} className="text-ink-muted shrink-0" />
          <span className="text-ui font-medium truncate">{t("tokens.tableTitle")}</span>
        </div>

        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center w-6 h-6 rounded-ctl text-ink-dim hover:text-ink hover:bg-raised transition-colors"
          title={t("common.close")}
          aria-label={t("common.close")}
        >
          <X size={13} />
        </button>
      </div>

      {/* Body: Left Tabs + Right Matrix Table */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Sidebar Tabs & Category Tree */}
        <div className="w-44 bg-surface/40 border-r border-rule flex flex-col p-2 space-y-1 shrink-0 overflow-y-auto">
          {/* Colors Tab */}
          <button
            type="button"
            onClick={() => setActiveTab("colors")}
            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-ctl text-ui transition-colors text-left ${
              activeTab === "colors"
                ? "bg-raised text-ink font-medium"
                : "text-ink-dim hover:text-ink hover:bg-raised/50"
            }`}
          >
            <Palette
              size={13}
              className={`shrink-0 ${activeTab === "colors" ? "text-ink" : "text-ink-muted"}`}
            />
            <span className="flex-1 truncate">{t("tokens.tabColors")}</span>
            <span className="text-micro text-ink-muted">{colorCount}</span>
          </button>

          {/* Numbers Tab (represents all numbers) */}
          <button
            type="button"
            onClick={() => {
              setActiveTab("numbers");
              setActiveCategory("all");
            }}
            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-ctl text-ui transition-colors text-left ${
              activeTab === "numbers" && activeCategory === "all"
                ? "bg-raised text-ink font-medium"
                : "text-ink-dim hover:text-ink hover:bg-raised/50"
            }`}
          >
            <Hash
              size={13}
              className={`shrink-0 ${
                activeTab === "numbers" && activeCategory === "all" ? "text-ink" : "text-ink-muted"
              }`}
            />
            <span className="flex-1 truncate">{t("tokens.tabNumbers")}</span>
            <span className="text-micro text-ink-muted">{numberCount}</span>
          </button>

          {/* Sub-categories */}
          <div className="flex flex-col pl-3 space-y-0.5 border-l border-rule/50 ml-3">
            {NUMBER_TOKEN_CATEGORIES.map((cat) => {
              const isSelected = activeTab === "numbers" && activeCategory === cat;
              const count = categoryCounts[cat] || 0;

              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => {
                    setActiveTab("numbers");
                    setActiveCategory(cat);
                  }}
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-ctl text-ui transition-colors text-left ${
                    isSelected
                      ? "bg-raised text-ink font-medium"
                      : "text-ink-dim hover:text-ink hover:bg-raised/50"
                  }`}
                >
                  <CategoryIcon
                    category={cat}
                    size={12}
                    className={isSelected ? "text-ink" : "text-ink-muted"}
                  />
                  <span className="flex-1 truncate">{t(`tokens.categories.${cat}`)}</span>
                  <span className="text-micro text-ink-muted">{count}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Matrix Table View */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-panel">
          {/* Table Sub-Toolbar */}
          <div className="flex items-center justify-between px-3 h-10 border-b border-rule bg-surface/30 gap-2 shrink-0">
            {/* Search Input */}
            <div className="relative flex items-center w-56 min-w-0">
              <Search size={12} className="absolute left-2.5 text-ink-muted pointer-events-none" />
              <input
                name="token-filter"
                value={searchQuery}
                onInput={(e) => setSearchQuery((e.currentTarget as HTMLInputElement).value)}
                placeholder={t("tokens.filterPlaceholder")}
                className="w-full h-6 pl-7 pr-2 bg-inset rounded-ctl text-row text-ink placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </div>

            {/* Actions: Create Token */}
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                variant="primary"
                size="text"
                type="button"
                onClick={handleCreateNewToken}
                className="flex items-center gap-1 shrink-0"
                title={t("tokens.addToken")}
                aria-label={t("tokens.addToken")}
              >
                <Plus size={12} />
                <span>{t("tokens.addToken")}</span>
              </Button>
            </div>
          </div>

          <TokensTable
            // Remount per axis so collapse/column state resets when the tab
            // flips, matching the behaviour of the original split tables.
            key={activeTab}
            variant={activeTab === "colors" ? "color" : "number"}
            doc={doc}
            docRef={docRef}
            commitSnapshot={commitSnapshot}
            searchQuery={searchQuery}
            modes={modes}
            activeCategory={activeCategory}
            onAddMode={() => setIsAddModeModalOpen(true)}
            newlyCreatedTokenId={newlyCreatedTokenId}
            onClearNewlyCreated={() => setNewlyCreatedTokenId(null)}
          />
        </div>
      </div>

      <AddModeModal
        isOpen={isAddModeModalOpen}
        onClose={() => setIsAddModeModalOpen(false)}
        onAdd={handleConfirmAddMode}
      />

      {/* Resize handles */}
      {/* Right edge */}
      <div
        onPointerDown={(e) => handleResizePointerDown(e, "width")}
        className="absolute top-10 bottom-3 right-0 w-1.5 cursor-ew-resize hover:bg-brand/20 transition-colors"
        aria-hidden="true"
      />
      {/* Bottom edge */}
      <div
        onPointerDown={(e) => handleResizePointerDown(e, "height")}
        className="absolute bottom-0 left-0 right-3 h-1.5 cursor-ns-resize hover:bg-brand/20 transition-colors"
        aria-hidden="true"
      />
      {/* Bottom-right corner */}
      <div
        onPointerDown={(e) => handleResizePointerDown(e, "both")}
        className="absolute bottom-0 right-0 w-3.5 h-3.5 cursor-nwse-resize flex items-end justify-end p-0.5 z-20 select-none text-ink-muted/50 hover:text-ink transition-colors"
        aria-hidden="true"
      >
        <svg width="7" height="7" viewBox="0 0 7 7" fill="none" className="pointer-events-none">
          <path
            d="M6 1L1 6M6 3.5L3.5 6M6 6H6.01"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>,
    document.body
  );
}
