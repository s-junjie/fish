import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Plus } from "lucide-react";
import type {
  ColorToken,
  DesignDocument,
  DocumentMode,
  NumberToken,
  NumberTokenCategory
} from "../../core/dsl/types";
import { getColorTokenModeColor } from "../../core/interactions/mode-ops";
import { colorTokensOf, tokenAlphaPct } from "../../core/interactions/token-ops";
import { isTokenAliasRef, lookupToken, rawTokenSlot, toTokenMap } from "../../core/dsl/token-value";
import { isNumberToken } from "../../core/interactions/number-token-ops";
import { parseColorAlpha } from "../../core/geometry/color-utils";
import { t } from "../../i18n";
import { ColorPanel } from "../ColorPanel";
import { ColorModeCell, NumberModeCell } from "./TokenModeCells";
import { ColumnResizer, GroupRow, ModeHeaderCell, TokenNameCell } from "./TokenTableParts";
import { TokenAliasPicker } from "./TokenAliasPicker";
import { createTokensTableActions, type AnyTableToken } from "./token-table-actions";
import { groupTokensByName, type TokenGroup } from "./token-table-utils";

type AnyToken = AnyTableToken;

interface TokensTableProps {
  /** Which token axis this table edits — drives filtering, mode ops and cell editors. */
  variant: "color" | "number";
  doc: DesignDocument;
  docRef: { current: DesignDocument };
  commitSnapshot: (newDoc: DesignDocument) => void;
  /**
   * A drag's frames, written without history; `onDragStart`/`onDragEnd` bracket
   * them into one undo step. Without `setDoc` every frame records its own step,
   * which is what a scrub of a mode cell used to do.
   */
  setDoc?: (updater: (doc: DesignDocument) => DesignDocument) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  searchQuery: string;
  /** The active axis' modes — the colour list for `color`, the NUMBER list for `number`. */
  modes: DocumentMode[];
  /** `number` variant only: which NUMBER category is being viewed. */
  activeCategory?: NumberTokenCategory | "all";
  onAddMode?: () => void;
  newlyCreatedTokenId?: string | null;
  onClearNewlyCreated?: () => void;
}

export function TokensTable({
  variant,
  doc,
  docRef,
  commitSnapshot,
  setDoc,
  onDragStart,
  onDragEnd,
  searchQuery,
  modes,
  activeCategory,
  onAddMode,
  newlyCreatedTokenId,
  onClearNewlyCreated
}: TokensTableProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editingNameValue, setEditingNameValue] = useState("");

  const [editingModeId, setEditingModeId] = useState<string | null>(null);
  const [editingModeName, setEditingModeName] = useState("");
  const editModeInputRef = useRef<HTMLInputElement | null>(null);

  const [colWidths, setColWidths] = useState<Record<string, number>>({
    name: 130
  });
  const [resizingColKey, setResizingColKey] = useState<string | null>(null);
  const resizingColRef = useRef<{
    key: string;
    startX: number;
    startW: number;
  } | null>(null);

  const [colorPanelAnchor, setColorPanelAnchor] = useState<{
    tokenId: string;
    modeId: string;
    el: HTMLElement;
  } | null>(null);
  const [aliasPickerAnchor, setAliasPickerAnchor] = useState<{
    tokenId: string;
    modeId: string;
    el: HTMLElement;
  } | null>(null);

  const editNameInputRef = useRef<HTMLInputElement | null>(null);

  const baseModeId = modes[0]?.id || "default";
  const singleMode = modes.length <= 1;

  // Colour values are wide (hex + opacity); numbers need far less room.
  const modeColDefaultW = variant === "color" ? 190 : 110;
  const modeColMinW = variant === "color" ? 130 : 80;

  useEffect(() => {
    if (editingNameId) {
      editNameInputRef.current?.focus();
      editNameInputRef.current?.select();
    }
  }, [editingNameId]);

  useEffect(() => {
    if (editingModeId) {
      editModeInputRef.current?.focus();
      editModeInputRef.current?.select();
    }
  }, [editingModeId]);

  const startColResize = (colKey: string, e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const currentW = colWidths[colKey] || (colKey === "name" ? 130 : modeColDefaultW);
    resizingColRef.current = {
      key: colKey,
      startX: e.clientX,
      startW: currentW
    };
    setResizingColKey(colKey);

    const onPointerMove = (ev: PointerEvent) => {
      if (!resizingColRef.current) return;
      const dx = ev.clientX - resizingColRef.current.startX;
      const minW = colKey === "name" ? 90 : modeColMinW;
      const nextW = Math.max(minW, resizingColRef.current.startW + dx);
      setColWidths((prev) => ({
        ...prev,
        [resizingColRef.current!.key]: Math.round(nextW)
      }));
    };

    const onPointerUp = () => {
      resizingColRef.current = null;
      setResizingColKey(null);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const docTokens = doc.tokens || [];
  const tokenMap = useMemo(() => toTokenMap(docTokens), [docTokens]);
  const allTokens: AnyToken[] =
    variant === "color"
      ? colorTokensOf(doc.tokens)
      : (doc.tokens || [])
          .filter(isNumberToken)
          .filter((tok) => {
            if ((activeCategory ?? "all") === "all") return true;
            return (tok.category ?? "spacing") === activeCategory;
          });
  const groups: TokenGroup<AnyToken>[] = groupTokensByName(allTokens, searchQuery);

  useEffect(() => {
    if (newlyCreatedTokenId) {
      const target = allTokens.find((t) => t.id === newlyCreatedTokenId);
      if (target) {
        setEditingNameId(target.id);
        setEditingNameValue(target.name);
        onClearNewlyCreated?.();
      }
    }
  }, [newlyCreatedTokenId, allTokens]);

  const toggleGroup = (groupName: string) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [groupName]: !prev[groupName]
    }));
  };

  const handleStartRename = (token: AnyToken) => {
    setEditingNameId(token.id);
    setEditingNameValue(token.name);
  };

  const handleStartRenameMode = (mode: DocumentMode) => {
    setEditingModeId(mode.id);
    setEditingModeName(mode.name);
  };

  const writeDoc = (nextDoc: DesignDocument, discrete?: boolean) => {
    if (discrete || !setDoc) commitSnapshot(nextDoc);
    else setDoc(() => nextDoc);
  };

  const actions = createTokensTableActions({
    variant,
    docRef,
    modes,
    baseModeId,
    commitSnapshot,
    writeDoc
  });

  const handleCommitRename = (token: AnyToken) => {
    setEditingNameId(null);
    actions.commitRenameToken(token, editingNameValue);
  };

  const handleCommitRenameMode = (modeId: string) => {
    setEditingModeId(null);
    actions.commitRenameMode(modeId, editingModeName);
  };

  const panelLookup = colorPanelAnchor ? lookupToken(tokenMap, colorPanelAnchor.tokenId) : undefined;
  const activePanelToken = panelLookup?.type === "color" ? panelLookup : null;
  const activePanelColor = activePanelToken && colorPanelAnchor
    ? parseColorAlpha(getColorTokenModeColor(activePanelToken, colorPanelAnchor.modeId, tokenMap)).hex6
    : "#000000";
  const activePanelOpacity = activePanelToken && colorPanelAnchor
    ? tokenAlphaPct(activePanelToken, colorPanelAnchor.modeId, tokenMap) / 100
    : 1;
  const aliasLookup = aliasPickerAnchor ? lookupToken(tokenMap, aliasPickerAnchor.tokenId) : undefined;
  const activeAliasSource =
    aliasLookup && (aliasLookup.type === "color" || aliasLookup.type === "number")
      ? aliasLookup
      : null;
  const activeAliasRawSlot =
    activeAliasSource && aliasPickerAnchor
      ? rawTokenSlot(activeAliasSource, aliasPickerAnchor.modeId, baseModeId)
      : undefined;
  const activeAliasRefId = isTokenAliasRef(activeAliasRawSlot) ? activeAliasRawSlot.ref : undefined;
  const activeAliasHasOverride =
    Boolean(activeAliasSource && aliasPickerAnchor) &&
    (aliasPickerAnchor!.modeId === baseModeId ||
      Boolean(activeAliasSource?.modes && aliasPickerAnchor!.modeId in activeAliasSource.modes));

  const totalCols = 1 + modes.length + 1;
  const nameColW = colWidths["name"] || 130;
  const modeColW = (modeId: string) => colWidths[modeId] || modeColDefaultW;

  return (
    <div className="flex-1 flex flex-col min-h-0 select-none">
      <div className="flex-1 overflow-auto min-h-0">
        <table className="min-w-full w-max text-left border-collapse">
          <thead className="sticky top-0 z-20 bg-surface border-b border-rule text-micro font-medium uppercase tracking-wider text-ink-muted">
            <tr>
              <th
                className="sticky left-0 top-0 z-30 bg-surface border-r border-rule px-3 py-2 shrink-0 relative group/th"
                style={{ width: `${nameColW}px`, minWidth: `${nameColW}px` }}
              >
                <span>{t("tokens.columnName")}</span>
                <ColumnResizer
                  colKey="name"
                  active={resizingColKey === "name"}
                  onStart={startColResize}
                />
              </th>
              {modes.map((mode) => (
                <ModeHeaderCell
                  key={mode.id}
                  mode={mode}
                  width={modeColW(mode.id)}
                  singleMode={singleMode}
                  showDelete={modes.length > 1}
                  editing={editingModeId === mode.id}
                  editingName={editingModeName}
                  inputRef={editModeInputRef}
                  resizing={resizingColKey === mode.id}
                  onStartResize={startColResize}
                  onStartRename={handleStartRenameMode}
                  onChangeName={setEditingModeName}
                  onCommitName={() => handleCommitRenameMode(mode.id)}
                  onCancelRename={() => setEditingModeId(null)}
                  onDelete={() => actions.deleteMode(mode.id)}
                />
              ))}
              {/* Placeholder column with New mode button */}
              <th className="px-3 py-1.5 shrink-0 min-w-[110px] text-left border-l border-rule">
                {onAddMode && (
                  <button
                    type="button"
                    onClick={onAddMode}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-ctl text-micro font-medium text-ink-muted hover:text-ink hover:bg-raised transition-colors border border-dashed border-rule-strong hover:border-rule whitespace-nowrap"
                    title={t("tokens.addMode")}
                    aria-label={t("tokens.addMode")}
                  >
                    <Plus size={11} className="shrink-0" />
                    <span className="whitespace-nowrap">{t("tokens.addMode")}</span>
                  </button>
                )}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule/60 text-row text-ink">
            {groups.length === 0 ? (
              <tr>
                <td colSpan={totalCols} className="px-4 py-8 text-center text-ink-muted">
                  {t("tokens.noMatches")}
                </td>
              </tr>
            ) : (
              groups.map((group) => {
                const isGrouped = Boolean(group.groupName);
                const isCollapsed = isGrouped && Boolean(collapsedGroups[group.groupName]);

                return (
                  <>
                    {isGrouped && (
                      <GroupRow
                        key={`group-${group.groupName}`}
                        name={group.groupName}
                        count={group.items.length}
                        collapsed={isCollapsed}
                        colSpan={totalCols}
                        onToggle={() => toggleGroup(group.groupName)}
                      />
                    )}

                    {!isCollapsed &&
                      group.items.map(({ token, displayName, fullName }) => {
                        const isEditingName = editingNameId === token.id;

                        return (
                          <tr
                            key={token.id}
                            className="group hover:bg-surface/30 transition-colors border-b border-rule/30"
                          >
                            <TokenNameCell
                              token={token}
                              displayName={displayName}
                              fullName={fullName}
                              width={nameColW}
                              isEditingName={isEditingName}
                              editingNameValue={editingNameValue}
                              editNameInputRef={editNameInputRef}
                              onDelete={() => actions.deleteToken(token.id)}
                              onCategoryChange={(cat) => actions.changeCategory(token as NumberToken, cat)}
                              onStartRename={() => handleStartRename(token)}
                              onChangeEditingName={setEditingNameValue}
                              onCommitRename={() => handleCommitRename(token)}
                              onCancelRename={() => setEditingNameId(null)}
                            />

                            {/* Mode Columns */}
                            {modes.map((mode) => {
                              const isBase = mode.id === baseModeId;
                              const hasOverride =
                                isBase ||
                                (Boolean(token.modes) && mode.id in (token.modes || {}));
                              const modeW = modeColW(mode.id);

                              return token.type === "color" ? (
                                <ColorModeCell
                                  key={mode.id}
                                  token={token}
                                  modeId={mode.id}
                                  baseModeId={baseModeId}
                                  tokenMap={tokenMap}
                                  width={modeW}
                                  hasOverride={hasOverride}
                                  onPickColor={(tokenId, mId, el) =>
                                    setColorPanelAnchor({ tokenId, modeId: mId, el })
                                  }
                                  onColorChange={actions.changeColor}
                                  onOpenAliasPicker={(tok, mId, el) =>
                                    setAliasPickerAnchor({ tokenId: tok.id, modeId: mId, el })
                                  }
                                  onDetachAlias={actions.detachAlias}
                                  onDragStart={onDragStart}
                                  onDragEnd={onDragEnd}
                                />
                              ) : (
                                <NumberModeCell
                                  key={mode.id}
                                  token={token}
                                  modeId={mode.id}
                                  baseModeId={baseModeId}
                                  tokenMap={tokenMap}
                                  width={modeW}
                                  hasOverride={hasOverride}
                                  onValueChange={actions.changeNumberValue}
                                  onOpenAliasPicker={(tok, mId, el) =>
                                    setAliasPickerAnchor({ tokenId: tok.id, modeId: mId, el })
                                  }
                                  onDetachAlias={actions.detachAlias}
                                  onDragStart={onDragStart}
                                  onDragEnd={onDragEnd}
                                />
                              );
                            })}

                            {/* Placeholder cell beneath New mode header */}
                            <td className="px-3 py-1.5 min-w-[110px] border-l border-rule/60" />
                          </tr>
                        );
                      })}
                  </>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {colorPanelAnchor && activePanelToken && variant === "color" && (
        <ColorPanel
          title={t("paint.color")}
          paint={{
            type: "solid",
            color: activePanelColor,
            opacity: activePanelOpacity
          }}
          anchor={colorPanelAnchor.el}
          zIndex="z-[90]"
          tabs={["solid"]}
          onGestureStart={onDragStart}
          onGestureEnd={onDragEnd}
          onChange={(paint, discrete) => {
            if (paint.type === "solid") {
              actions.changeColor(
                activePanelToken,
                colorPanelAnchor.modeId,
                paint.color,
                paint.opacity ?? 1,
                discrete
              );
            }
          }}
          onClose={() => setColorPanelAnchor(null)}
        />
      )}

      {aliasPickerAnchor && activeAliasSource && (
        <TokenAliasPicker
          sourceToken={activeAliasSource}
          modeId={aliasPickerAnchor.modeId}
          baseModeId={baseModeId}
          allTokens={docTokens}
          anchor={aliasPickerAnchor.el}
          currentRefId={activeAliasRefId}
          onSelect={(targetId) => actions.bindAlias(activeAliasSource, aliasPickerAnchor.modeId, targetId)}
          onDetach={
            activeAliasRefId && activeAliasHasOverride
              ? () => {
                  actions.detachAlias(activeAliasSource, aliasPickerAnchor.modeId);
                  setAliasPickerAnchor(null);
                }
              : undefined
          }
          onClose={() => setAliasPickerAnchor(null)}
        />
      )}

      {resizingColKey && (
        <div className="fixed inset-0 z-50 cursor-col-resize select-none pointer-events-none" />
      )}
    </div>
  );
}
