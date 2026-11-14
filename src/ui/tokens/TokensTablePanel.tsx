import { useState } from "preact/hooks";
import {
  Hash,
  Palette,
  Plus,
  Search,
  SwatchBook
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
import { FloatingWindow } from "../FloatingWindow";
import { TokensTable } from "./TokensTable";
import { AddModeModal } from "./AddModeModal";
import { generateUniqueTokenName } from "./token-table-utils";
import { CategoryIcon, NUMBER_TOKEN_CATEGORIES } from "./CategoryIcon";

const DEFAULT_WIDTH = 760;
const DEFAULT_HEIGHT = 520;
const MIN_WIDTH = 560;
const MIN_HEIGHT = 360;

interface TokensTablePanelProps {
  doc: DesignDocument;
  docRef: { current: DesignDocument };
  commitSnapshot: (newDoc: DesignDocument) => void;
  /** Drag frames of a cell value: written without history, closed by the pair below. */
  setDoc: (updater: (doc: DesignDocument) => DesignDocument) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  isOpen: boolean;
  onClose: () => void;
}

export function TokensTablePanel({
  doc,
  docRef,
  commitSnapshot,
  setDoc,
  onDragStart,
  onDragEnd,
  isOpen,
  onClose
}: TokensTablePanelProps) {
  const [activeTab, setActiveTab] = useState<"colors" | "numbers">("colors");
  const [activeCategory, setActiveCategory] = useState<NumberTokenCategory | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isAddModeModalOpen, setIsAddModeModalOpen] = useState(false);
  const [newlyCreatedTokenId, setNewlyCreatedTokenId] = useState<string | null>(null);

  if (!isOpen) return null;

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

  const initialX = Math.round((window.innerWidth - DEFAULT_WIDTH) / 2);
  const initialY = Math.round((window.innerHeight - DEFAULT_HEIGHT) / 2);

  return (
    <>
      <FloatingWindow
        title={t("tokens.tableTitle")}
        icon={<SwatchBook size={14} className="text-ink-muted shrink-0" />}
        onClose={onClose}
        initialX={initialX}
        initialY={initialY}
        width={DEFAULT_WIDTH}
        height={DEFAULT_HEIGHT}
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        resize="both"
        zIndexClass="z-[46]"
      >
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
              setDoc={setDoc}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              searchQuery={searchQuery}
              modes={modes}
              activeCategory={activeCategory}
              onAddMode={() => setIsAddModeModalOpen(true)}
              newlyCreatedTokenId={newlyCreatedTokenId}
              onClearNewlyCreated={() => setNewlyCreatedTokenId(null)}
            />
          </div>
        </div>
      </FloatingWindow>

      <AddModeModal
        isOpen={isAddModeModalOpen}
        onClose={() => setIsAddModeModalOpen(false)}
        onAdd={handleConfirmAddMode}
      />
    </>
  );
}
