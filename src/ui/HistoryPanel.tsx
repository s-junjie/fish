import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useWindowKeydown } from "./hooks/useWindowKeydown";
import { createPortal } from "preact/compat";
import { MoreHorizontal, X } from "lucide-react";
import { t } from "../i18n";
import type { VersionSummary } from "../core/persistence/autosave-controller";
import { TITLE_BAR_HEIGHT } from "./toolbar/titlebar-layout";
import { Button } from "./Button";
import { INLINE_RENAME_INPUT_CLASS } from "./rename-style";
import { ContextMenu, type ContextMenuEntry } from "./context-menu/ContextMenu";
import { ROW_SPREAD_GAP_CLASS } from "./row-style";

/** How long a row click waits to learn it was the first of a double-click. */
const CLICK_SETTLE_MS = 300;

interface HistoryPanelProps {
  versions: VersionSummary[];
  /** The version the canvas is showing, if any — the row it belongs to wears the selection wash. */
  previewingId: string | null;
  /**
   * Stowed with the chrome when Tab clears the screen — like every other
   * panel, it slides away while history mode itself stays on.
   */
  hidden?: boolean;
  onClose: () => void;
  /** Loads a version onto the canvas. */
  onPreview: (id: string) => void | Promise<void>;
  /** Leaves the version and returns to the live document; the panel stays open. */
  onExitPreview: () => void;
  onRestore: (id: string) => void;
  onName: (id: string, label: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

/**
 * Line one of a row: the version's identity, never its timestamp.
 *
 * A `label` only names the version when the user wrote it — an auto, restored
 * or pre-restore record carries a default in `label`, so those are named from
 * `kind` instead. Printing `createdAt` here (the old fallback for an unnamed
 * row) put the same time twice on one row and left the list with nothing to
 * scan for.
 */
function versionName(v: VersionSummary): string {
  if (v.named && v.label) return v.label;
  if (v.kind === "pre-restore") return t("history.beforeRestore");
  if (v.kind === "restored") return t("history.restored");
  return t("history.auto");
}

/**
 * What a row's `⋯` offers.
 *
 * The three actions were one icon each on the row — a restore and an export
 * competing with the row's own name, and a destructive one sitting beside them
 * where a stray click finds it. They are one menu now, with delete in a group
 * of its own behind a separator so the pointer has to travel between "use this
 * version" and "throw it away".
 */
function versionMenu(
  v: VersionSummary,
  handlers: Pick<HistoryPanelProps, "onRestore" | "onExport" | "onDelete">
): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = [
    { id: "restore", label: t("history.restore"), onSelect: () => handlers.onRestore(v.id) },
    { id: "export", label: t("history.export"), onSelect: () => handlers.onExport(v.id) }
  ];
  // The controller refuses to delete a named version, so its row is absent
  // rather than shown dead — the rule the icon row followed before it.
  if (!v.named) {
    entries.push(
      { separator: true },
      { id: "delete", label: t("history.delete"), onSelect: () => handlers.onDelete(v.id) }
    );
  }
  return entries;
}

export function HistoryPanel(props: HistoryPanelProps) {
  const { versions, onClose, onName, previewingId, onPreview, onExitPreview, hidden = false } = props;
  const [namingId, setNamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // The anchor is kept, not re-queried: the menu has to outlive any re-render
  // of the row it was opened from, and the button is stable for its lifetime.
  const [menu, setMenu] = useState<{ id: string; el: HTMLElement } | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  // A double-click is two clicks. Toggling on the first would enter the preview
  // and leave it again before the rename field opened — the canvas swapping
  // under a rename that never asked for it — so the toggle waits out the second
  // click. Single-click latency is paid in a load that is async anyway.
  const pendingToggle = useRef<number | null>(null);
  const clearPendingToggle = useCallback(() => {
    if (pendingToggle.current !== null) {
      clearTimeout(pendingToggle.current);
      pendingToggle.current = null;
    }
  }, []);
  useEffect(() => clearPendingToggle, [clearPendingToggle]);

  const scheduleToggle = useCallback(
    (v: VersionSummary) => {
      clearPendingToggle();
      pendingToggle.current = window.setTimeout(() => {
        pendingToggle.current = null;
        if (previewingId === v.id) onExitPreview();
        else void onPreview(v.id);
      }, CLICK_SETTLE_MS);
    },
    [clearPendingToggle, previewingId, onPreview, onExitPreview]
  );

  // Escape peels the panel off one layer at a time: a rename in progress (the
  // field's own handler takes it, and this listener stands clear of editable
  // targets per AGENTS §8), then a pending click, then the preview, then the
  // panel itself. The open `⋯` menu answers Escape before this runs and is
  // still open when it does, so the menu alone closes.
  //
  // Tab is not a key this panel listens for: it hides the chrome, and the panel
  // goes with it as `hidden` — sliding out without leaving history mode.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key !== "Escape") return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    if (menu) return;
    if (pendingToggle.current !== null) {
      clearPendingToggle();
      return;
    }
    if (previewingId) {
      onExitPreview();
      return;
    }
    onClose();
  };
  useWindowKeydown(onKeyDown, [menu, previewingId, onExitPreview, onClose, clearPendingToggle]);

  // The input only exists once `namingId` lands, so focus has to wait a frame.
  useEffect(() => {
    if (!namingId) return;
    const raf = requestAnimationFrame(() => {
      renameRef.current?.focus();
      renameRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [namingId]);

  const startNaming = useCallback((v: VersionSummary) => {
    setNamingId(v.id);
    setDraft(v.named && v.label ? v.label : "");
  }, []);

  const commitName = useCallback(
    (id: string) => {
      const trimmed = draft.trim();
      if (trimmed) onName(id, trimmed);
      setNamingId(null);
      setDraft("");
    },
    [draft, onName]
  );

  const cancelName = useCallback(() => {
    setNamingId(null);
    setDraft("");
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);
  const menuVersion = menu ? versions.find((v) => v.id === menu.id) : undefined;

  return (
    <div
      data-history-panel="true"
      style={{ top: TITLE_BAR_HEIGHT }}
      className={`fixed right-0 bottom-0 w-72 bg-panel border-l border-rule z-50 flex flex-col transition-transform duration-slide ease-slide ${
        hidden ? "translate-x-full" : "translate-x-0"
      }`}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-rule">
        {/* A panel/popover title: the third of the three `font-sans` places. */}
        <span className="font-sans text-displaySm text-ink">{t("history.title")}</span>
        <Button size="icon" variant="ghost" onClick={onClose} title={t("history.close")} aria-label={t("history.close")}>
          <X size={13} />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {versions.length === 0 ? (
          <div className="p-4 text-ui text-ink-muted">{t("history.empty")}</div>
        ) : (
          <ul className="divide-y divide-rule">
            {versions.map((v) => {
              const previewing = previewingId === v.id;
              return (
              <li
                key={v.id}
                data-history-row={v.id}
                data-previewing={previewing ? "true" : undefined}
                onClick={(e) => {
                  // The field and the menu own their clicks: neither may be
                  // read as "this row, please" — a toggle under a rename or an
                  // open menu is a state change nobody asked for.
                  const target = e.target as HTMLElement;
                  if (target.closest("button, input")) return;
                  scheduleToggle(v);
                }}
                className={`p-3 transition-colors duration-micro ease-snap ${
                  previewing ? "bg-selection" : "hover:bg-raised"
                }`}
              >
                <div className={ROW_SPREAD_GAP_CLASS}>
                  {namingId === v.id ? (
                    <input
                      ref={renameRef}
                      data-history-rename={v.id}
                      type="text"
                      name="history-name"
                      value={draft}
                      aria-label={t("history.rename")}
                      placeholder={t("history.rename")}
                      onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
                      onBlur={() => commitName(v.id)}
                      onKeyDown={(e) => {
                        // Enter while an IME is composing selects a candidate,
                        // it does not mean "done" — committing here would save a
                        // half-typed label.
                        if ((e as KeyboardEvent).isComposing || (e as KeyboardEvent).keyCode === 229) return;
                        if ((e as KeyboardEvent).key === "Enter") {
                          e.preventDefault();
                          commitName(v.id);
                        } else if ((e as KeyboardEvent).key === "Escape") {
                          cancelName();
                        }
                      }}
                      className={`${INLINE_RENAME_INPUT_CLASS} min-w-0 flex-1`}
                    />
                  ) : (
                    /* Double-click renames in place, the way a layer row does:
                       the name is the field, so the field has to take the
                       name's slot rather than open a second row of controls.
                       The click that preceded it was a click on this row, so
                       its pending toggle is cancelled here rather than being
                       allowed to land mid-rename. */
                    <span
                      title={t("history.renameHint")}
                      onDblClick={() => {
                        clearPendingToggle();
                        startNaming(v);
                      }}
                      className="flex min-w-0 items-center gap-1 text-row text-ink select-none"
                    >
                      {v.named && (
                        <span aria-hidden="true" className="flex-none text-ink-dim">
                          ★
                        </span>
                      )}
                      <span className="truncate">{versionName(v)}</span>
                    </span>
                  )}
                  {/* One control, not three: the actions are a menu, so the row
                      keeps its name and its meta line as the only things on it. */}
                  <Button
                    size="icon"
                    variant="ghost"
                    title={t("history.moreMenu")}
                    aria-label={t("history.moreMenu")}
                    aria-haspopup="menu"
                    aria-expanded={menu?.id === v.id}
                    onClick={(e) => {
                      const el = e.currentTarget as HTMLElement;
                      setMenu((m) => (m?.id === v.id ? null : { id: v.id, el }));
                    }}
                  >
                    <MoreHorizontal size={13} />
                  </Button>
                </div>
                <div className="mt-0.5 truncate text-meta tabular-nums text-ink-dim">
                  {formatTime(v.createdAt)} · {formatBytes(v.sizeBytes)}
                </div>
              </li>
              );
            })}
          </ul>
        )}
      </div>
      {/* Portalled: the list scrolls, and a menu inside it would be clipped by
          its own overflow the first time it opened near the bottom. It mounts
          after the panel, so at the same z-index it paints above it. */}
      {menu && menuVersion &&
        createPortal(
          <ContextMenu anchor={menu.el} entries={versionMenu(menuVersion, props)} onClose={closeMenu} />,
          document.body
        )}
    </div>
  );
}
