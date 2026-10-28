import { useState, useRef, useEffect } from "preact/hooks";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2
} from "lucide-react";
import type {
  ColorToken,
  DesignDocument,
  DocumentMode,
  NumberToken,
  NumberTokenCategory
} from "../../core/dsl/types";
import {
  deleteDocumentMode,
  deleteDocumentNumberMode,
  getColorTokenModeColor,
  getNumberTokenModeValue,
  renameDocumentMode,
  renameDocumentNumberMode,
  updateColorTokenWithModes,
  updateNumberTokenWithModes,
  type ColorModePatch
} from "../../core/interactions/mode-ops";
import {
  colorTokensOf,
  createColorToken,
  tokenAlphaPct
} from "../../core/interactions/token-ops";
import {
  createNumberToken,
  isNumberToken
} from "../../core/interactions/number-token-ops";
import {
  addTokenToDoc,
  removeTokenFromDoc,
  updateTokenInDoc
} from "../../core/interactions/style-ops";
import { parseColorAlpha } from "../../core/geometry/color-utils";
import { t } from "../../i18n";
import { HexInput } from "../HexInput";
import { ScrubInput } from "../ScrubInput";
import { ColorPanel } from "../ColorPanel";
import { generateUniqueTokenName, groupTokensByName, type TokenGroup } from "./token-table-utils";
import { PAINT_SWATCH_CHECKER, PAINT_SWATCH_CLASS } from "../inspector/paint-row-style";
import { CategoryIcon, NUMBER_TOKEN_CATEGORIES } from "./CategoryIcon";

type AnyToken = ColorToken | NumberToken;

interface TokensTableProps {
  /** Which token axis this table edits — drives filtering, mode ops and cell editors. */
  variant: "color" | "number";
  doc: DesignDocument;
  docRef: { current: DesignDocument };
  commitSnapshot: (newDoc: DesignDocument) => void;
  searchQuery: string;
  /** The active axis' modes — the colour list for `color`, the NUMBER list for `number`. */
  modes: DocumentMode[];
  /** `number` variant only: which NUMBER category is being viewed. */
  activeCategory?: NumberTokenCategory | "all";
  onAddMode?: () => void;
  newlyCreatedTokenId?: string | null;
  onClearNewlyCreated?: () => void;
}

/** The value editor inside a colour-token mode cell: swatch + hex + opacity. */
function ColorModeCell({
  token,
  modeId,
  width,
  hasOverride,
  onPickColor,
  onColorChange
}: {
  token: ColorToken;
  modeId: string;
  width: number;
  hasOverride: boolean;
  onPickColor: (tokenId: string, modeId: string, el: HTMLElement) => void;
  onColorChange: (token: ColorToken, modeId: string, hex: string, opacity?: number) => void;
}) {
  const currentHex6 = parseColorAlpha(getColorTokenModeColor(token, modeId)).hex6;
  const currentOpacity = tokenAlphaPct(token, modeId) / 100;

  return (
    <td
      className="px-3 py-1.5 align-middle shrink-0 border-l border-rule"
      style={{ width: `${width}px`, minWidth: `${width}px` }}
    >
      <div className="flex items-center gap-1.5 h-7 px-1.5 rounded-swatch bg-inset/60 hover:bg-inset border border-rule/50 hover:border-rule focus-within:border-brand focus-within:bg-inset transition-colors min-w-0 group/cell relative">
        {/* Color Swatch */}
        <button
          type="button"
          style={PAINT_SWATCH_CHECKER}
          onClick={(e) => onPickColor(token.id, modeId, e.currentTarget)}
          className={`${PAINT_SWATCH_CLASS} ${
            !hasOverride ? "opacity-40 hover:opacity-100" : ""
          } transition-opacity cursor-pointer shrink-0`}
          title={currentHex6}
          aria-label={currentHex6}
        >
          <span
            className="block w-full h-full"
            style={{ backgroundColor: currentHex6, opacity: currentOpacity }}
          />
        </button>

        {/* Hex Input */}
        <div className="flex-1 min-w-0">
          <HexInput
            value={currentHex6}
            onChange={(nextHex, nextAlpha) => {
              onColorChange(
                token,
                modeId,
                nextHex,
                nextAlpha !== undefined ? nextAlpha / 100 : currentOpacity
              );
            }}
            className={`w-full bg-transparent text-code uppercase focus:outline-none tabular-nums ${
              !hasOverride ? "text-ink-muted/50" : "text-ink"
            }`}
          />
        </div>

        {/* Opacity ScrubInput */}
        <div className="w-14 shrink-0">
          <ScrubInput
            compact
            label="%"
            value={Math.round(currentOpacity * 100)}
            min={0}
            max={100}
            onChange={(pct) => {
              onColorChange(token, modeId, currentHex6, pct / 100);
            }}
            className={!hasOverride ? "opacity-50 hover:opacity-100" : ""}
          />
        </div>
      </div>
    </td>
  );
}

/** The value editor inside a number-token mode cell: a single scrubber. */
function NumberModeCell({
  token,
  modeId,
  width,
  hasOverride,
  onValueChange
}: {
  token: NumberToken;
  modeId: string;
  width: number;
  hasOverride: boolean;
  onValueChange: (token: NumberToken, modeId: string, val: number) => void;
}) {
  const currentVal = getNumberTokenModeValue(token, modeId);

  return (
    <td
      className="px-3 py-1.5 align-middle shrink-0 border-l border-rule"
      style={{ width: `${width}px`, minWidth: `${width}px` }}
    >
      <div className="flex items-center gap-1.5 h-7 px-1.5 rounded-swatch bg-inset/60 hover:bg-inset border border-rule/50 hover:border-rule focus-within:border-brand focus-within:bg-inset transition-colors w-fit max-w-[120px] group/cell relative">
        <div className="flex-1 min-w-0">
          <ScrubInput
            compact
            label="px"
            value={currentVal}
            onChange={(num) => onValueChange(token, modeId, num)}
            className={`w-full ${!hasOverride ? "opacity-50 hover:opacity-100" : ""}`}
          />
        </div>
      </div>
    </td>
  );
}

export function TokensTable({
  variant,
  doc,
  docRef,
  commitSnapshot,
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

  const findLatest = (tokenId: string): AnyToken | undefined =>
    (docRef.current.tokens || []).find(
      (entry): entry is AnyToken => entry.type === variant && entry.id === tokenId
    );

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

  const handleCommitRename = (token: AnyToken) => {
    const clean = editingNameValue.trim();
    setEditingNameId(null);
    if (!clean || clean === token.name) return;
    const current = docRef.current;
    const latest = findLatest(token.id);
    if (!latest) return;

    if (latest.type === "color") {
      const baseColor = parseColorAlpha(getColorTokenModeColor(latest, baseModeId)).hex6;
      const baseOpacity = tokenAlphaPct(latest, baseModeId) / 100;
      const modePatches: Record<string, ColorModePatch | undefined> = {};
      if (latest.modes) {
        for (const m of modes) {
          if (m.id !== baseModeId && latest.modes[m.id]) {
            modePatches[m.id] = {
              color: parseColorAlpha(getColorTokenModeColor(latest, m.id)).hex6,
              opacity: tokenAlphaPct(latest, m.id) / 100
            };
          }
        }
      }
      const updated = updateColorTokenWithModes(
        latest,
        clean,
        baseColor,
        modePatches,
        latest.description,
        baseOpacity,
        baseModeId
      );
      commitSnapshot(updateTokenInDoc(current, updated));
    } else {
      const baseVal = getNumberTokenModeValue(latest, baseModeId);
      const updated = updateNumberTokenWithModes(
        latest,
        clean,
        latest.category,
        baseVal,
        latest.modes ? { ...latest.modes } : undefined,
        latest.description,
        baseModeId
      );
      commitSnapshot(updateTokenInDoc(current, updated));
    }
  };

  const handleCategoryChange = (token: NumberToken, newCat: NumberTokenCategory) => {
    const current = docRef.current;
    const latest = (current.tokens || []).find(
      (entry): entry is NumberToken => entry.type === "number" && entry.id === token.id
    );
    if (!latest) return;
    const baseVal = getNumberTokenModeValue(latest, baseModeId);
    const updated = updateNumberTokenWithModes(
      latest,
      latest.name,
      newCat,
      baseVal,
      latest.modes ? { ...latest.modes } : undefined,
      latest.description,
      baseModeId
    );
    commitSnapshot(updateTokenInDoc(current, updated));
  };

  const handleStartRenameMode = (mode: DocumentMode) => {
    setEditingModeId(mode.id);
    setEditingModeName(mode.name);
  };

  const handleCommitRenameMode = (modeId: string) => {
    const clean = editingModeName.trim();
    setEditingModeId(null);
    if (!clean) return;
    commitSnapshot(
      variant === "color"
        ? renameDocumentMode(docRef.current, modeId, clean)
        : renameDocumentNumberMode(docRef.current, modeId, clean)
    );
  };

  const handleColorChange = (
    token: ColorToken,
    modeId: string,
    hex: string,
    opacity?: number
  ) => {
    if (!hex || !hex.trim()) {
      if (modeId !== baseModeId) {
        handleResetColorMode(token, modeId);
      }
      return;
    }
    const current = docRef.current;
    const latest = (current.tokens || []).find(
      (entry): entry is ColorToken => entry.type === "color" && entry.id === token.id
    );
    if (!latest) return;

    const cleanHex = parseColorAlpha(hex).hex6;
    const baseColor =
      modeId === baseModeId
        ? cleanHex
        : parseColorAlpha(getColorTokenModeColor(latest, baseModeId)).hex6;
    const baseOpacity = modeId === baseModeId ? opacity : tokenAlphaPct(latest, baseModeId) / 100;

    const modePatches: Record<string, ColorModePatch | undefined> = {};
    if (latest.modes) {
      for (const m of modes) {
        if (m.id !== baseModeId && latest.modes[m.id]) {
          modePatches[m.id] = {
            color: parseColorAlpha(getColorTokenModeColor(latest, m.id)).hex6,
            opacity: tokenAlphaPct(latest, m.id) / 100
          };
        }
      }
    }
    if (modeId !== baseModeId) {
      modePatches[modeId] = {
        color: cleanHex,
        opacity: opacity !== undefined ? opacity : tokenAlphaPct(latest, modeId) / 100
      };
    }

    const updated = updateColorTokenWithModes(
      latest,
      latest.name,
      baseColor,
      modePatches,
      latest.description,
      baseOpacity,
      baseModeId
    );
    commitSnapshot(updateTokenInDoc(current, updated));
  };

  const handleResetColorMode = (token: ColorToken, modeId: string) => {
    if (modeId === baseModeId) return;
    const current = docRef.current;
    const latest = (current.tokens || []).find(
      (entry): entry is ColorToken => entry.type === "color" && entry.id === token.id
    );
    if (!latest || !latest.modes || !(modeId in latest.modes)) return;

    const modePatches: Record<string, ColorModePatch | undefined> = {};
    for (const m of modes) {
      if (m.id !== baseModeId && m.id !== modeId && latest.modes[m.id]) {
        modePatches[m.id] = {
          color: parseColorAlpha(getColorTokenModeColor(latest, m.id)).hex6,
          opacity: tokenAlphaPct(latest, m.id) / 100
        };
      }
    }

    const baseColor = parseColorAlpha(getColorTokenModeColor(latest, baseModeId)).hex6;
    const baseOpacity = tokenAlphaPct(latest, baseModeId) / 100;
    const updated = updateColorTokenWithModes(
      latest,
      latest.name,
      baseColor,
      modePatches,
      latest.description,
      baseOpacity,
      baseModeId
    );
    commitSnapshot(updateTokenInDoc(current, updated));
  };

  const handleNumberValueChange = (token: NumberToken, modeId: string, val: number) => {
    if (Number.isNaN(val)) {
      if (modeId !== baseModeId) {
        handleResetNumberMode(token, modeId);
      }
      return;
    }
    const current = docRef.current;
    const latest = (current.tokens || []).find(
      (entry): entry is NumberToken => entry.type === "number" && entry.id === token.id
    );
    if (!latest) return;
    const baseVal = modeId === baseModeId ? val : getNumberTokenModeValue(latest, baseModeId);

    const modePatches: Record<string, number | undefined> = {};
    if (latest.modes) {
      for (const m of modes) {
        if (m.id !== baseModeId && latest.modes[m.id] !== undefined) {
          modePatches[m.id] = getNumberTokenModeValue(latest, m.id);
        }
      }
    }
    if (modeId !== baseModeId) {
      modePatches[modeId] = val;
    }

    const updated = updateNumberTokenWithModes(
      latest,
      latest.name,
      latest.category,
      baseVal,
      modePatches,
      latest.description,
      baseModeId
    );
    commitSnapshot(updateTokenInDoc(current, updated));
  };

  const handleResetNumberMode = (token: NumberToken, modeId: string) => {
    if (modeId === baseModeId) return;
    const current = docRef.current;
    const latest = (current.tokens || []).find(
      (entry): entry is NumberToken => entry.type === "number" && entry.id === token.id
    );
    if (!latest || !latest.modes || !(modeId in latest.modes)) return;

    const modePatches: Record<string, number | undefined> = {};
    for (const m of modes) {
      if (m.id !== baseModeId && m.id !== modeId && latest.modes[m.id] !== undefined) {
        modePatches[m.id] = getNumberTokenModeValue(latest, m.id);
      }
    }

    const baseVal = getNumberTokenModeValue(latest, baseModeId);
    const updated = updateNumberTokenWithModes(
      latest,
      latest.name,
      latest.category,
      baseVal,
      modePatches,
      latest.description,
      baseModeId
    );
    commitSnapshot(updateTokenInDoc(current, updated));
  };

  const handleDeleteToken = (tokenId: string) => {
    commitSnapshot(removeTokenFromDoc(docRef.current, tokenId));
  };

  const handleCreateTokenInGroup = (groupName: string) => {
    const current = docRef.current;
    const created =
      variant === "color"
        ? createColorToken(
            generateUniqueTokenName(allTokens, "color", groupName),
            "#1B72FF"
          )
        : createNumberToken(
            generateUniqueTokenName(
              allTokens,
              activeCategory === "all" || !activeCategory ? "spacing" : activeCategory,
              groupName
            ),
            8,
            activeCategory === "all" || !activeCategory ? "spacing" : activeCategory
          );
    commitSnapshot(addTokenToDoc(current, created));
    setEditingNameId(created.id);
    setEditingNameValue(created.name);
  };

  const handleDeleteMode = (modeId: string) => {
    if (modes.length <= 1) return;
    commitSnapshot(
      variant === "color"
        ? deleteDocumentMode(docRef.current, modeId)
        : deleteDocumentNumberMode(docRef.current, modeId)
    );
  };

  const activePanelToken = colorPanelAnchor
    ? allTokens.find(
        (tok): tok is ColorToken => tok.type === "color" && tok.id === colorPanelAnchor.tokenId
      )
    : null;
  const activePanelColor = activePanelToken && colorPanelAnchor
    ? parseColorAlpha(getColorTokenModeColor(activePanelToken, colorPanelAnchor.modeId)).hex6
    : "#000000";
  const activePanelOpacity = activePanelToken && colorPanelAnchor
    ? tokenAlphaPct(activePanelToken, colorPanelAnchor.modeId) / 100
    : 1;

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
                <div
                  role="separator"
                  aria-orientation="vertical"
                  onPointerDown={(e) => startColResize("name", e)}
                  className="absolute top-0 -right-1.5 w-3 h-full cursor-col-resize z-20 group/resize flex justify-center items-center"
                  aria-hidden="true"
                >
                  <div
                    className={`w-[2px] h-full transition-colors ${
                      resizingColKey === "name" ? "bg-brand" : "group-hover/resize:bg-brand/70"
                    }`}
                  />
                </div>
              </th>
              {modes.map((mode) => {
                const modeW = modeColW(mode.id);
                const isEditingThisMode = editingModeId === mode.id;

                return (
                  <th
                    key={mode.id}
                    className="px-3 py-2 shrink-0 group/col relative border-l border-rule"
                    style={{ width: `${modeW}px`, minWidth: `${modeW}px` }}
                  >
                    <div className="flex items-center justify-between gap-1.5 min-w-0 pr-1">
                      {isEditingThisMode ? (
                        <input
                          ref={editModeInputRef}
                          name="token-mode-name"
                          value={editingModeName}
                          onInput={(e) => setEditingModeName((e.currentTarget as HTMLInputElement).value)}
                          onBlur={() => handleCommitRenameMode(mode.id)}
                          onKeyDown={(e) => {
                            if (e.isComposing || (e as any).keyCode === 229) return;
                            if (e.key === "Enter") handleCommitRenameMode(mode.id);
                            if (e.key === "Escape") setEditingModeId(null);
                          }}
                          className="w-full bg-inset rounded-swatch px-1 text-ui text-ink focus:outline-none ring-1 ring-brand"
                        />
                      ) : singleMode ? (
                        // One mode is not a choice, so the column is titled by
                        // what it holds. Renaming it would name a switch nobody
                        // can flip.
                        <span className="truncate" title={t("tokens.columnValue")}>
                          {t("tokens.columnValue")}
                        </span>
                      ) : (
                        <span
                          onDblClick={() => handleStartRenameMode(mode)}
                          className="truncate cursor-text hover:text-ink transition-colors"
                          title={mode.name}
                        >
                          {mode.name}
                        </span>
                      )}
                      {modes.length > 1 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteMode(mode.id);
                          }}
                          className="opacity-0 group-hover/col:opacity-100 p-0.5 rounded-ctl text-ink-muted hover:text-measure-coral transition-opacity shrink-0"
                          title={t("tokens.deleteMode")}
                          aria-label={t("tokens.deleteMode")}
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      onPointerDown={(e) => startColResize(mode.id, e)}
                      className="absolute top-0 -right-1.5 w-3 h-full cursor-col-resize z-20 group/resize flex justify-center items-center"
                      aria-hidden="true"
                    >
                      <div
                        className={`w-[2px] h-full transition-colors ${
                          resizingColKey === mode.id ? "bg-brand" : "group-hover/resize:bg-brand/70"
                        }`}
                      />
                    </div>
                  </th>
                );
              })}
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
                      <tr
                        key={`group-${group.groupName}`}
                        className="bg-surface/70 hover:bg-surface transition-colors cursor-pointer"
                        onClick={() => toggleGroup(group.groupName)}
                      >
                        <td colSpan={totalCols} className="px-3 py-1.5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 font-medium text-ink">
                              {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                              <span className="text-ui font-medium">{group.groupName}</span>
                              <span className="text-micro text-ink-muted font-normal">
                                ({group.items.length})
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCreateTokenInGroup(group.groupName);
                              }}
                              className="flex items-center gap-1 px-1.5 py-0.5 rounded-ctl text-micro text-ink-dim hover:text-ink hover:bg-raised transition-colors"
                              title={t("tokens.addToken")}
                              aria-label={t("tokens.addToken")}
                            >
                              <Plus size={11} />
                              <span>{t("tokens.addToken")}</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}

                    {!isCollapsed &&
                      group.items.map(({ token, displayName, fullName }) => {
                        const isEditingName = editingNameId === token.id;

                        return (
                          <tr
                            key={token.id}
                            className="group hover:bg-surface/30 transition-colors border-b border-rule/30"
                          >
                            {/* Token Name Column (Sticky left) */}
                            <td
                              className="sticky left-0 z-10 bg-panel border-r border-rule px-3 py-1.5 align-middle group-hover:bg-surface transition-colors shrink-0"
                              style={{ width: `${nameColW}px`, minWidth: `${nameColW}px` }}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <button
                                  type="button"
                                  onClick={() => handleDeleteToken(token.id)}
                                  className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-muted hover:text-measure-coral transition-all rounded-ctl shrink-0"
                                  title={t("tokens.deleteAction")}
                                  aria-label={t("tokens.deleteAction")}
                                >
                                  <Trash2 size={12} />
                                </button>
                                {token.type === "color" ? (
                                  <div
                                    style={PAINT_SWATCH_CHECKER}
                                    className={`${PAINT_SWATCH_CLASS} shrink-0`}
                                  >
                                    <span
                                      className="block w-full h-full"
                                      style={{
                                        backgroundColor: parseColorAlpha(
                                          getColorTokenModeColor(token, baseModeId)
                                        ).hex6,
                                        opacity: tokenAlphaPct(token, baseModeId) / 100
                                      }}
                                    />
                                  </div>
                                ) : (
                                  <div
                                    className="relative group/cat shrink-0 flex items-center justify-center cursor-pointer"
                                    title={`${t("tokens.category")}: ${t(`tokens.categories.${token.category ?? "spacing"}`)}`}
                                  >
                                    <CategoryIcon category={token.category} />
                                    <select
                                      name="token-category"
                                      value={token.category ?? "spacing"}
                                      onChange={(e) =>
                                        handleCategoryChange(
                                          token,
                                          (e.target as HTMLSelectElement).value as NumberTokenCategory
                                        )
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
                                    onInput={(e) =>
                                      setEditingNameValue((e.currentTarget as HTMLInputElement).value)
                                    }
                                    onKeyDown={(e) => {
                                      if (e.isComposing || (e as any).keyCode === 229) return;
                                      if (e.key === "Enter") handleCommitRename(token);
                                      if (e.key === "Escape") setEditingNameId(null);
                                    }}
                                    onBlur={() => handleCommitRename(token)}
                                    className="flex-1 min-w-0 h-6 px-1.5 text-row text-ink bg-inset rounded-swatch border border-rule focus:outline-none focus:border-brand"
                                  />
                                ) : (
                                  <span
                                    onDblClick={() => handleStartRename(token)}
                                    className="truncate text-row cursor-text text-ink hover:text-brand transition-colors"
                                    title={fullName}
                                  >
                                    {displayName}
                                  </span>
                                )}
                              </div>
                            </td>

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
                                  width={modeW}
                                  hasOverride={hasOverride}
                                  onPickColor={(tokenId, mId, el) =>
                                    setColorPanelAnchor({ tokenId, modeId: mId, el })
                                  }
                                  onColorChange={handleColorChange}
                                />
                              ) : (
                                <NumberModeCell
                                  key={mode.id}
                                  token={token}
                                  modeId={mode.id}
                                  width={modeW}
                                  hasOverride={hasOverride}
                                  onValueChange={handleNumberValueChange}
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
          onChange={(paint) => {
            if (paint.type === "solid") {
              handleColorChange(
                activePanelToken,
                colorPanelAnchor.modeId,
                paint.color,
                paint.opacity ?? 1
              );
            }
          }}
          onClose={() => setColorPanelAnchor(null)}
        />
      )}

      {resizingColKey && (
        <div className="fixed inset-0 z-50 cursor-col-resize select-none pointer-events-none" />
      )}
    </div>
  );
}
