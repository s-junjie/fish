import { useRef } from "preact/hooks";
import { RefreshCw, ExternalLink, Newspaper } from "lucide-react";
import { t } from "../../i18n";
import { getFileHandle } from "../../core/data-bridge";
import type { UpdateStatus } from "../hooks/useUpdateStatus";
import type { DisabledReason } from "../../core/update";
import { useDismiss } from "../hooks/useDismiss";
import { Button } from "../Button";
import { CheckRow } from "../CheckRow";
import { MENU_ITEM_CLASS, POPOVER_SURFACE_CLASS } from "../menu-style";
import { DARK_RING_CLASS } from "../ring-style";
import { ROW_CLASS } from "../row-style";
import { FishLogo } from "../FishLogo";

interface LogoMenuProps {
  status: UpdateStatus;
}

/**
 * Top-left application menu anchored on the FISH brand logo.
 *
 * Houses app-level metadata, versioning, and the update engine.
 * When an update is detected, the logo cells rotate with a subtle, gentle
 * marquee wave to announce the availability without interrupting canvas work.
 */
export function LogoMenu({ status }: LogoMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useDismiss(status.panelOpen, status.closePanel, panelRef, containerRef);

  const release = status.check?.status === "update" ? status.check.release : null;
  const pending = release !== null && status.applied === null;
  const appliedOk = status.applied?.ok === true ? status.applied : null;

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <button
        type="button"
        data-logo-menu="true"
        data-update-button="true"
        aria-expanded={status.panelOpen}
        aria-label={pending ? t("updates.titleAvailable") : t("titlebar.brand")}
        title={pending ? t("updates.available", { v: release.version }) : t("titlebar.brand")}
        onClick={() => (status.panelOpen ? status.closePanel() : status.openPanel())}
        className={`relative shrink-0 flex items-center justify-center w-7 h-7 rounded-ctl transition-all duration-200 select-none ${
          pending
            ? "bg-brand/15 hover:bg-brand/25 ring-1 ring-brand/50 shadow-[0_0_8px_rgba(232,163,61,0.25)] text-ink"
            : status.panelOpen
              ? "bg-raised text-ink"
              : "text-ink hover:bg-raised/70 active:bg-raised"
        }`}
      >
        <FishLogo size={18} lod={false} highlight={pending} />

        {pending && (
          <span
            data-update-badge="true"
            className="absolute -top-0.5 -right-0.5 flex h-2 w-2"
          >
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand opacity-75" />
            <span className={`relative inline-flex rounded-full h-2 w-2 bg-brand ${DARK_RING_CLASS}`} />
          </span>
        )}
      </button>

      {status.panelOpen && (
        <div
          ref={panelRef}
          data-update-popover="true"
          className={`absolute left-0 top-full mt-1.5 w-72 origin-top-left ${POPOVER_SURFACE_CLASS} font-sans px-3 py-3 text-ui text-ink flex flex-col gap-2.5 animate-pop-in z-50`}
        >
          {/* Brand header */}
          <div className="flex items-center justify-between gap-2 pb-2 border-b border-rule">
            <div className="flex items-center gap-2 select-none">
              <FishLogo size={16} lod={false} highlight={pending} />
              <span className="font-semibold text-displaySm text-ink leading-tight">FISH</span>
            </div>
            <span className="text-row text-ink-dim tabular-nums px-1.5 py-0.5 rounded-ctl bg-raised text-micro font-mono">
              v{status.version}
            </span>
          </div>

          {/* Update announcement / Action card */}
          {pending ? (
            <div className="flex flex-col gap-2.5 pb-2.5 border-b border-rule">
              <p data-update-status="true" className="text-displaySm font-medium text-ink leading-tight">
                {statusText(status, release?.version)}
              </p>
              <Button
                variant="primary"
                size="field"
                block
                disabled={status.applying}
                data-update-apply="true"
                onClick={status.update}
              >
                <span className="text-brand-ink font-medium">
                  {status.applying
                    ? t("updates.verifying")
                    : getFileHandle()
                      ? t("updates.updateFile")
                      : t("updates.updateFilePick")}
                </span>
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p data-update-status="true" className="text-row text-ink-dim leading-normal">
                {statusText(status, release?.version)}
              </p>

              {appliedOk?.method === "in-place" && (
                <Button variant="primary" size="field" block onClick={status.reload}>
                  <span className="text-brand-ink font-medium">{t("updates.reload")}</span>
                </Button>
              )}

              {!appliedOk && (
                <button
                  onClick={() => {
                    status.checkNow();
                  }}
                  data-update-check="true"
                  disabled={status.checking || !status.checkable}
                  className={`${MENU_ITEM_CLASS} justify-between`}
                >
                  <div className={ROW_CLASS}>
                    <RefreshCw size={13} className={status.checking ? "animate-spin" : ""} />
                    <span>{status.checking ? t("updates.checking") : t("updates.check")}</span>
                  </div>
                </button>
              )}
            </div>
          )}

          {/* Background launch check setting */}
          <div className="border-t border-rule pt-2">
            <CheckRow
              testId="update-auto-check"
              checked={status.autoCheck}
              onChange={status.setAutoCheck}
              label={t("updates.autoCheck")}
            />
          </div>

          {/* App Links */}
          <div className="border-t border-rule pt-1.5 -mx-1 flex flex-col gap-0.5">
            <a
              href="https://github.com/s-junjie/fish/releases"
              target="_blank"
              rel="noreferrer"
              onClick={() => status.closePanel()}
              className={`${MENU_ITEM_CLASS} justify-between`}
            >
              <div className={ROW_CLASS}>
                <Newspaper size={13} />
                <span>{t("updates.whatsNew")}</span>
              </div>
              <ExternalLink size={12} className="opacity-60 group-hover:opacity-100" />
            </a>

            <a
              href="https://github.com/s-junjie/fish"
              target="_blank"
              rel="noreferrer"
              onClick={() => status.closePanel()}
              className={`${MENU_ITEM_CLASS} justify-between`}
            >
              <div className={ROW_CLASS}>
                <GithubIcon size={13} />
                <span>{t("updates.githubRepo")}</span>
              </div>
              <ExternalLink size={12} className="opacity-60 group-hover:opacity-100" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function statusText(status: UpdateStatus, releaseVersion?: string): string {
  if (status.applied && !status.applied.ok) return t("updates.failed", { m: status.applied.message });
  if (status.applied?.ok) {
    const vars = { v: status.applied.version, now: status.version };
    return status.applied.method === "in-place"
      ? t("updates.writtenReload", vars)
      : t("updates.savedElsewhere", vars);
  }
  if (status.checking) return t("updates.checking");
  if (status.check?.status === "update") {
    return t("updates.available", { v: releaseVersion ?? status.check.release.version });
  }
  if (status.check?.status === "current") return t("updates.current", { v: status.check.version });
  if (status.check?.status === "error") return t("updates.failed", { m: status.check.message });
  if (status.check?.status === "disabled") return blockedText(status.check.reason);
  if (status.blocked) return blockedText(status.blocked);
  return t("updates.idle");
}

function blockedText(reason: DisabledReason | null): string {
  switch (reason) {
    case "no-webcrypto":
      return t("updates.noCrypto");
    case "embedded":
      return t("updates.embedded");
    case "auto-check-off":
      return t("updates.autoOff");
    default:
      return t("updates.noEndpoint");
  }
}

function GithubIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="shrink-0">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
