import { useEffect, useMemo, useState } from "preact/hooks";
import { AlertTriangle, X } from "lucide-react";
import { t } from "../i18n";
import type { DesignDocument, DesignElement } from "../core/dsl/types";
import { getActivePage } from "../core/dsl/types";
import { fontStatusSnapshot, textFontStatus, subscribeFontStatus } from "../core/fonts/font-status";
import type { FontUsage } from "../core/fonts/font-status";
import { replaceFontFamily } from "../core/interactions/font-replace";
import { flattenElements } from "../core/geometry/tree-ops";
import { closeMissingFonts, missingFontsState, subscribeMissingFonts } from "./missing-fonts";
import { useWindowKeydown } from "./hooks/useWindowKeydown";
import { Button } from "./Button";
import { SegmentedControl } from "./SegmentedControl";
import { FontFamilyPicker } from "./inspector/FontFamilyPicker";
import { ROW_CLASS } from "./row-style";
import { SUB_LABEL_CLASS } from "./label-tier";

/**
 * One line of "how much of the file this costs".
 *
 * Built from the counts rather than from a template with three placeholders:
 * a run of `0` is not information, and `0 text styles` in a list of three
 * numbers is the kind of line a reader stops reading. Each part is its own key
 * so a language with different plural rules can answer per part.
 */
function usageLine(entry: FontUsage): string {
  const parts: string[] = [];
  if (entry.texts > 0) {
    parts.push(entry.texts === 1 ? t("fonts.usageTextsOne") : t("fonts.usageTexts", { n: entry.texts }));
  }
  if (entry.spans > 0) {
    parts.push(entry.spans === 1 ? t("fonts.usageRunsOne") : t("fonts.usageRuns", { n: entry.spans }));
  }
  if (entry.styles > 0) {
    parts.push(entry.styles === 1 ? t("fonts.usageStylesOne") : t("fonts.usageStyles", { n: entry.styles }));
  }
  return parts.join(" · ");
}

/** The layers under `ids` that a replacement in the SELECTION scope would touch. */
function missingUsers(elements: DesignElement[], ids?: ReadonlySet<string>): number {
  let count = 0;
  for (const el of flattenElements(elements)) {
    if (el.type !== "text") continue;
    if (ids && !ids.has(el.id)) continue;
    if (textFontStatus(el)?.status === "missing") count++;
  }
  return count;
}

interface MissingFontsDialogProps {
  doc: DesignDocument;
  /** One history entry for one replacement: the whole point is that it is undoable. */
  commitSnapshot: (doc: DesignDocument) => void;
  selectedIds: ReadonlySet<string>;
}

/**
 * The one surface the missing-font state has: why a double-click did not open a
 * caret, and what to do about it.
 *
 * It is a dialog rather than a toast because everything here is a CHOICE — which
 * family replaces which, over what — and a toast that removes itself in four
 * seconds cannot carry a choice. It is not docked to a panel either: the layer
 * row already marks the file, so this is only ever opened deliberately.
 *
 * Two scopes, because they are two different intentions and the panel can count
 * them: the layers the author has selected (their fix, now) and the whole
 * document (the file's fix, including the shared text styles a single layer
 * cannot carry). `Replace…` per family is one control rather than two buttons,
 * so what it does is decided by a toggle that says its consequence out loud
 * instead of by which of two similar buttons was clicked.
 *
 * No `Download` here yet: a web font service does not exist in this build, and a
 * button that cannot do anything is worse than its absence.
 */
export function MissingFontsDialog({ doc, commitSnapshot, selectedIds }: MissingFontsDialogProps) {
  const [panel, setPanel] = useState(missingFontsState());
  const [scope, setScope] = useState<"selection" | "document">("document");
  const [pendingReplacements, setPendingReplacements] = useState<Record<string, string>>({});
  const [, bump] = useState(0);

  const missing = fontStatusSnapshot().filter((entry) => entry.status === "missing");

  useEffect(() => subscribeMissingFonts(() => {
    setPanel(missingFontsState());
    setPendingReplacements({});
  }), []);

  useEffect(() => subscribeFontStatus(() => bump((n) => n + 1)), []);

  useEffect(() => {
    if (panel.open && missing.length === 0) {
      closeMissingFonts();
    }
  }, [panel.open, missing.length]);

  useWindowKeydown(
    (e) => {
      if (e.key === "Escape") closeMissingFonts();
    },
    [panel.open]
  );
  const activePage = useMemo(() => getActivePage(doc), [doc]);
  const selectedCount = useMemo(
    () => (panel.open ? missingUsers(activePage.children ?? [], selectedIds) : 0),
    [panel.open, activePage, selectedIds]
  );
  const documentCount = useMemo(
    () => (panel.open ? missingUsers(activePage.children ?? []) : 0),
    [panel.open, activePage]
  );

  if (!panel.open) return null;

  const handleConfirmReplace = () => {
    let nextDoc = doc;
    for (const [from, to] of Object.entries(pendingReplacements)) {
      if (!to) continue;
      nextDoc = replaceFontFamily(
        nextDoc,
        from,
        to,
        scope === "document" ? "document" : { elementIds: selectedIds }
      );
    }
    if (nextDoc !== doc) commitSnapshot(nextDoc);
    setPendingReplacements({});
    const remainingMissing = fontStatusSnapshot().filter((entry) => entry.status === "missing");
    if (remainingMissing.length === 0) {
      closeMissingFonts();
    }
  };

  const hasReplacements = Object.values(pendingReplacements).some((v) => Boolean(v));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("fonts.panelTitle")}
      data-missing-fonts-dialog="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeMissingFonts();
      }}
    >
      <div className="bg-panel border border-rule rounded-panel shadow-modal w-full max-w-lg max-h-[85vh] flex flex-col text-ink animate-pop-in">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-rule">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-measure-coral shrink-0" />
            <span className="font-sans font-semibold text-displaySm">{t("fonts.panelTitle")}</span>
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={closeMissingFonts}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <X size={14} />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-3.5 flex flex-col gap-3 font-sans">
          <p className="text-ui text-ink-dim leading-relaxed">{t("fonts.panelIntro")}</p>

          {missing.length === 0 ? (
            <p className="text-ui text-ink-muted py-4 text-center">{t("fonts.panelEmpty")}</p>
          ) : (
            <>
              <div className={ROW_CLASS}>
                <span className={SUB_LABEL_CLASS}>{t("fonts.scopeLabel")}</span>
                <SegmentedControl
                  rowProps={{ "data-font-scope": "true" }}
                  items={[
                    {
                      value: "selection" as const,
                      label: `${t("fonts.scopeSelection")} (${selectedCount})`,
                      title: selectedCount
                        ? t("fonts.scopeSelectionHint")
                        : t("fonts.scopeSelectionEmpty")
                    },
                    {
                      value: "document" as const,
                      label: `${t("fonts.scopeDocument")} (${documentCount})`
                    }
                  ]}
                  value={scope}
                  onChange={setScope}
                />
              </div>

              <div className="flex flex-col gap-2 mt-1">
                {missing.map((entry) => {
                  const currentReplacement = pendingReplacements[entry.family];
                  return (
                    <div
                      key={entry.family}
                      data-missing-family={entry.family}
                      className="border border-rule rounded-ctl p-2.5 flex items-center justify-between gap-3 bg-raised/20"
                    >
                      <div className="flex flex-col min-w-0 flex-1">
                        <span data-missing-family-name="true" className="font-sans font-medium text-ui text-ink truncate">
                          {entry.family}
                        </span>
                        <span data-missing-family-usage="true" className="font-sans text-meta text-ink-muted">
                          {usageLine(entry)}
                        </span>
                      </div>
                      <div className="w-52 shrink-0">
                        <FontFamilyPicker
                          value={currentReplacement ?? ""}
                          label={currentReplacement || t("fonts.replaceWith")}
                          onChange={(replacement) => {
                            setPendingReplacements((prev) => ({
                              ...prev,
                              [entry.family]: replacement
                            }));
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Footer with confirmation button */}
        {missing.length > 0 && (
          <div className="border-t border-rule px-4 py-3 flex items-center justify-end gap-2 bg-panel rounded-b-panel">
            <Button size="field" variant="ghost" onClick={closeMissingFonts}>
              {t("common.cancel")}
            </Button>
            <Button
              size="field"
              variant="primary"
              data-replace-fonts-confirm="true"
              disabled={!hasReplacements}
              onClick={handleConfirmReplace}
            >
              {t("fonts.replaceAction")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
