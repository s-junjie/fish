import { useState, useEffect, useMemo, useRef } from "preact/hooks";
import { memo } from "./memo";
import { t } from "../i18n";
import { LayoutGrid, LayoutList, Trash2, Upload } from "lucide-react";
import { Button } from "./Button";
import { SegmentedControl } from "./SegmentedControl";
import { TEXT_FIELD_CLASS } from "./ScrubInput";
import { FILE_DROP_BUTTON_CLASS, FILE_DROP_RESTING_CLASS } from "./file-drop-style";
import { AssetCard, AssetsViewMode, ComponentCard, thumbnailContext } from "./assets/asset-cards";
import { filterAssets, filterComponentItems } from "./assets/asset-filter";
import { groupComponentSets } from "../core/interactions/component-inventory";
import { videoAssetIds } from "../core/interactions/video-loader";
import type { ComponentEntry } from "../core/interactions/component-inventory";
import type { AssetInsertPayload } from "../core/plugins/types";
import type { AssetRef, DesignDocument } from "../core/dsl/types";

export interface AssetsPanelProps {
  assets: AssetRef[];
  components: ComponentEntry[];
  /** Live document — thumbnails resolve nested instances through it. */
  docRef: { current: DesignDocument };
  /** Asset id → how many places point at it; counted by the shell, not here. */
  usage?: Map<string, number>;
  onInsert?: (payload: AssetInsertPayload, worldX?: number, worldY?: number) => void;
  onLocateComponent?: (componentId: string) => void;
  onImportComponents?: (file: File) => void;
  onCleanUnused?: () => void;
}

const EMPTY_HINT_CLASS = "px-2 py-6 text-center text-row leading-snug text-ink-muted select-none";
const DEBOUNCE_MS = 150;
const VIEW_MODE_STORAGE_KEY = "fish_assets_view_mode_v1";

/**
 * A member's caption inside an expanded set: its coordinates, without the set's
 * name above it. `Size · Hover` under a `Size` card says everything the member's
 * own `Size=Small, State=Hover` name says, in a third of the width.
 */
function coordsLabel(coords: Record<string, string> | undefined): string | undefined {
  const values = Object.values(coords ?? {});
  return values.length > 0 ? values.join(" · ") : undefined;
}

function ImportRow({ onImport }: { onImport?: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  if (!onImport) return null;
  return (
    <>
      <button
        type="button"
        data-asset-import="true"
        onClick={() => inputRef.current?.click()}
        className={`${FILE_DROP_BUTTON_CLASS} ${FILE_DROP_RESTING_CLASS} mb-2`}
      >
        <Upload size={12} />
        <span>{t("assets.importComponents")}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        name="asset-file"
        accept=".html,.htm"
        className="hidden"
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          const file = input.files?.[0];
          if (file) onImport(file);
          input.value = "";
        }}
      />
    </>
  );
}

export function assetsPanelPropsEqual(prev: AssetsPanelProps, next: AssetsPanelProps): boolean {
  return (
    prev.assets === next.assets &&
    prev.components === next.components &&
    prev.docRef === next.docRef &&
    prev.usage === next.usage &&
    prev.onInsert === next.onInsert &&
    prev.onLocateComponent === next.onLocateComponent &&
    prev.onImportComponents === next.onImportComponents &&
    prev.onCleanUnused === next.onCleanUnused
  );
}

export const AssetsPanel = memo(function AssetsPanelInner({
  assets,
  components,
  docRef,
  usage,
  onInsert,
  onLocateComponent,
  onImportComponents,
  onCleanUnused
}: AssetsPanelProps) {
  const [docTab, setDocTab] = useState<"images" | "components">(() =>
    assets.length === 0 && components.length > 0 ? "components" : "images"
  );
  const [viewMode, setViewMode] = useState<AssetsViewMode>(() => {
    try {
      const saved = window.localStorage?.getItem(VIEW_MODE_STORAGE_KEY);
      if (saved === "grid" || saved === "list") return saved;
    } catch {
      // ignore in sandboxed environments without allow-same-origin
    }
    return "grid";
  });
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  /** Which variant sets are showing their members. */
  const [expandedSets, setExpandedSets] = useState<Set<string>>(new Set());
  const toggleSetExpanded = (setId: string) =>
    setExpandedSets((prev) => {
      const next = new Set(prev);
      if (next.has(setId)) next.delete(setId);
      else next.add(setId);
      return next;
    });

  useEffect(() => {
    try {
      window.localStorage?.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
    } catch {
      // ignore in sandboxed environments without allow-same-origin
    }
  }, [viewMode]);

  useEffect(() => {
    const id = setTimeout(() => setSearch(query), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  const docAssets = useMemo(() => filterAssets(assets, search), [assets, search]);

  const docComponents = useMemo(() => {
    const { sets, singles } = groupComponentSets(docRef.current, components);
    return filterComponentItems(sets, singles, search);
  }, [components, search, docRef]);

  const thumbCtx = useMemo(() => thumbnailContext(docRef), [docRef]);

  // One document walk shared by every card, instead of one per card per render.
  const videoIds = videoAssetIds(docRef.current);

  const unusedCount = assets.filter((a) => (usage?.get(a.id) ?? 0) === 0).length;
  const hasSets = docComponents.some((c) => c.kind === "set");

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-asset-page="__doc__">
      <div className="shrink-0 px-2">
        <div className="pt-2 pb-2" data-asset-doctabs="true">
          <SegmentedControl
            items={[
              { value: "images", label: t("assets.tabImages"), grow: true },
              { value: "components", label: t("assets.tabComponents"), grow: true }
            ]}
            value={docTab}
            onChange={(next) => setDocTab(next)}
            className="w-full"
          />
        </div>

        {(docTab === "images" ? assets.length > 0 : components.length > 0) && (
          <div className="flex items-center gap-1.5 pb-2">
            <input
              type="text"
              name="asset-search"
              value={query}
              placeholder={t("assets.search")}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              data-testid="assets-search"
              className={`${TEXT_FIELD_CLASS} flex-1 cursor-text`}
            />
            <SegmentedControl<AssetsViewMode>
              items={[
                {
                  value: "grid",
                  icon: <LayoutGrid size={12} />,
                  title: t("assets.viewGrid"),
                  attrs: {
                    "data-testid": "assets-view-grid",
                    "aria-label": t("assets.viewGrid"),
                    "aria-pressed": String(viewMode === "grid")
                  }
                },
                {
                  value: "list",
                  icon: <LayoutList size={12} />,
                  title: t("assets.viewList"),
                  attrs: {
                    "data-testid": "assets-view-list",
                    "aria-label": t("assets.viewList"),
                    "aria-pressed": String(viewMode === "list")
                  }
                }
              ]}
              value={viewMode}
              onChange={setViewMode}
              rowProps={{ "data-asset-view-toggle": "true" }}
              className="shrink-0"
            />
          </div>
        )}
      </div>

      {/* Items container */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2" data-asset-scroll data-asset-view={viewMode}>
        {docTab === "images" && docAssets.length === 0 && (
          <div className={EMPTY_HINT_CLASS}>
            {t("assets.noResults")}
          </div>
        )}
        {docTab === "images" && docAssets.length > 0 && (
          <div className={viewMode === "list" ? "flex flex-col gap-0.5 px-1" : "grid grid-cols-2 gap-1.5 px-1 items-start"}>
            {docAssets.map((a) => (
              <AssetCard
                key={a.id}
                asset={a}
                isVideo={videoIds.has(a.id)}
                usage={usage?.get(a.id) ?? 0}
                onInsert={onInsert}
                viewMode={viewMode}
              />
            ))}
          </div>
        )}

        {docTab === "components" && <ImportRow onImport={onImportComponents} />}
        {docTab === "components" && docComponents.length === 0 && (
          <div className={EMPTY_HINT_CLASS}>
            {components.length === 0 ? (
              <>
                <div>{t("assets.noComponents")}</div>
                <div className="pt-1 text-ink-muted">{t("assets.noComponentsHint")}</div>
              </>
            ) : (
              t("assets.noResults")
            )}
          </div>
        )}
        {docTab === "components" && docComponents.length > 0 && (
          <div className={viewMode === "list" ? "flex flex-col gap-0.5 px-1" : "grid grid-cols-2 gap-1.5 px-1 items-start"}>
            {docComponents.flatMap((card) => {
              if (card.kind !== "set") {
                return [
                  <ComponentCard
                    key={card.entry.id}
                    entry={card.entry}
                    ctx={thumbCtx}
                    onInsert={onInsert}
                    onLocate={onLocateComponent}
                    viewMode={viewMode}
                    reserveExpanderSlot={hasSets}
                  />
                ];
              }
              const expanded = expandedSets.has(card.set.setId);
              const locateId = expanded ? card.entry.id : card.set.setNodeId || card.entry.id;
              const cards = [
                <ComponentCard
                  key={`set_${card.set.setId}`}
                  entry={card.entry}
                  ctx={thumbCtx}
                  onInsert={onInsert}
                  onLocate={onLocateComponent}
                  locateId={locateId}
                  name={card.set.name}
                  count={card.set.members.length}
                  onToggleVariants={() => toggleSetExpanded(card.set.setId)}
                  expanded={expanded}
                  viewMode={viewMode}
                />
              ];
              if (expanded) {
                cards.push(
                  <div
                    key={`members_${card.set.setId}`}
                    data-asset-variant-group={card.set.setId}
                    className={
                      viewMode === "list"
                        ? "ml-2 border-l border-rule pl-1.5 flex flex-col gap-0.5"
                        : "col-span-2 ml-0.5 border-l border-rule pl-1.5 pt-0.5"
                    }
                  >
                    <div className={viewMode === "list" ? "flex flex-col gap-0.5" : "grid grid-cols-2 gap-1.5 items-start"}>
                      {card.set.members.map((member) => (
                        <ComponentCard
                          key={member.id}
                          entry={member}
                          ctx={thumbCtx}
                          onInsert={onInsert}
                          onLocate={onLocateComponent}
                          variant
                          name={coordsLabel(member.variantProperties)}
                          viewMode={viewMode}
                        />
                      ))}
                    </div>
                  </div>
                );
              }
              return cards;
            })}
          </div>
        )}
      </div>

      {/* The panel's one destructive action, docked under the grid rather than
          beside the search: a control that deletes sits where a list is read,
          not where it is filtered. Absent, not disabled, when there is nothing
          to delete — a greyed-out row is still a row claiming a decision. */}
      {docTab === "images" && unusedCount > 0 && onCleanUnused && (
        <div className="shrink-0 border-t border-rule px-2 py-2">
          <Button
            variant="danger"
            size="field"
            block
            onClick={onCleanUnused}
            title={t("assets.removeUnusedTitle")}
            data-testid="assets-clean-unused"
            className="gap-1.5"
          >
            <Trash2 size={12} />
            <span>{t("assets.removeUnused", { count: unusedCount })}</span>
          </Button>
        </div>
      )}
    </div>
  );
}, assetsPanelPropsEqual);
