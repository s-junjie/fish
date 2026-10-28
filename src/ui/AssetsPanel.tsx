import { useState, useEffect, useMemo, useRef } from "preact/hooks";
import { memo } from "./memo";
import { t } from "../i18n";
import { Trash2, Upload } from "lucide-react";
import { Button } from "./Button";
import { SegmentedControl } from "./SegmentedControl";
import { TEXT_FIELD_CLASS } from "./ScrubInput";
import { FILE_DROP_BUTTON_CLASS, FILE_DROP_RESTING_CLASS } from "./file-drop-style";
import { AssetCard, ComponentCard, thumbnailContext } from "./assets/asset-cards";
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
const DEBOUNCE_MS = 250;

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
    const id = setTimeout(() => setSearch(query), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  const docAssets = useMemo(() => {
    if (!search.trim()) return assets;
    const q = search.trim().toLowerCase();
    return assets.filter((a) => a.name.toLowerCase().includes(q));
  }, [assets, search]);

  const docComponents = useMemo(() => {
    const { sets, singles } = groupComponentSets(docRef.current, components);
    const q = search.trim().toLowerCase();
    const matches = (e: ComponentEntry) =>
      e.name.toLowerCase().includes(q) ||
      (
        e.variantProperties
          ? Object.values(e.variantProperties).some((v) => v.toLowerCase().includes(q))
          : false
      );

    const keptSets = q
      ? sets
          .map((s) => ({ ...s, members: s.members.filter(matches) }))
          .filter((s) => s.members.length > 0 || s.name.toLowerCase().includes(q))
          .map((s) => ({
            ...s,
            defaultMember: s.members.find((m) => m.id === s.defaultMember.id) || s.members[0]
          }))
          .filter((s) => s.defaultMember)
      : sets;

    const keptSingles = q ? singles.filter(matches) : singles;
    return [
      ...keptSets.map((s) => ({ kind: "set" as const, set: s, entry: s.defaultMember })),
      ...keptSingles.map((e) => ({ kind: "single" as const, entry: e }))
    ];
  }, [components, search, docRef]);

  const thumbCtx = useMemo(() => thumbnailContext(docRef), [docRef]);

  // One document walk shared by every card, instead of one per card per render.
  const videoIds = videoAssetIds(docRef.current);

  const unusedCount = assets.filter((a) => (usage?.get(a.id) ?? 0) === 0).length;

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
          <div className="pb-2">
            <input
              type="text"
              name="asset-search"
              value={query}
              placeholder={t("assets.search")}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              data-testid="assets-search"
              className={`${TEXT_FIELD_CLASS} cursor-text`}
            />
          </div>
        )}
      </div>

      {/* Grid container */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2" data-asset-scroll>
        {docTab === "images" && docAssets.length === 0 && (
          <div className={EMPTY_HINT_CLASS}>
            {t("assets.noResults")}
          </div>
        )}
        {docTab === "images" && (
          <div className="grid grid-cols-2 gap-1.5 px-1">
            {docAssets.map((a) => (
              <AssetCard
                key={a.id}
                asset={a}
                isVideo={videoIds.has(a.id)}
                usage={usage?.get(a.id) ?? 0}
                onInsert={onInsert}
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
        {docTab === "components" && (
          <div className="grid grid-cols-2 gap-1.5 px-1">
            {docComponents.flatMap((card) => {
              if (card.kind !== "set") {
                return [
                  <ComponentCard
                    key={card.entry.id}
                    entry={card.entry}
                    ctx={thumbCtx}
                    onInsert={onInsert}
                    onLocate={onLocateComponent}
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
                  subtitle={`${card.set.members.length} variants`}
                  onToggleVariants={() => toggleSetExpanded(card.set.setId)}
                  expanded={expanded}
                />
              ];
              if (expanded) {
                for (const member of card.set.members) {
                  cards.push(
                    <ComponentCard
                      key={member.id}
                      entry={member}
                      ctx={thumbCtx}
                      onInsert={onInsert}
                      onLocate={onLocateComponent}
                    />
                  );
                }
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
