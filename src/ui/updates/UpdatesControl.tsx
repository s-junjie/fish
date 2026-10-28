import { useRef } from "preact/hooks";
import { CloudDownload, RefreshCw } from "lucide-react";
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

interface UpdatesControlProps {
  status: UpdateStatus;
}

/**
 * The title bar's app-level surface: version, check, and the update itself.
 *
 * It is here, and not in the document hub, because everything in that popover
 * acts on the file in this tab — its own comment says so — and a release is not
 * that. An update replaces the *shell* every `.fish.html` carries; the document
 * is carried across untouched, which is why this panel can act while the hub's
 * rows cannot.
 *
 * Nothing in here writes on its own. A check produces a badge and a row; the
 * write happens when the row is pressed.
 */
export function UpdatesControl({ status }: UpdatesControlProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useDismiss(status.panelOpen, status.closePanel, panelRef, containerRef);

  const release = status.check?.status === "update" ? status.check.release : null;
  const pending = release !== null && status.applied === null;
  const appliedOk = status.applied?.ok === true ? status.applied : null;

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <Button
        variant="ghost"
        size="icon"
        data-update-button="true"
        className="relative"
        aria-expanded={status.panelOpen}
        aria-label={pending ? t("updates.titleAvailable") : t("updates.title")}
        title={pending ? t("updates.available", { v: release.version }) : t("updates.title")}
        onClick={() => (status.panelOpen ? status.closePanel() : status.openPanel())}
      >
        <CloudDownload size={14} />
        {/* The dot sits at the button's own corner rather than floating outside
            it, and wears the shared dark ring — a 6px amber dot on a `panel`
            plate has no edge of its own to read against. */}
        {pending && (
          <span
            data-update-badge="true"
            className={`absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-brand ${DARK_RING_CLASS}`}
          />
        )}
      </Button>

      {status.panelOpen && (
        <div
          ref={panelRef}
          data-update-popover="true"
          className={`absolute left-0 top-full mt-1.5 w-72 origin-top-left ${POPOVER_SURFACE_CLASS} font-sans px-3 py-3.5 text-ui text-ink flex flex-col gap-3 animate-pop-in`}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-displaySm font-semibold text-ink leading-tight">
              {t("updates.title")}
            </span>
            <span className="text-row text-ink-dim tabular-nums">v{status.version}</span>
          </div>

          <p data-update-status="true" className="text-row text-ink-dim leading-normal">
            {statusText(status, release?.version)}
          </p>

          {appliedOk?.method === "in-place" && (
            <Button variant="primary" size="field" block onClick={status.reload}>
              <span className="text-brand-ink font-medium">{t("updates.reload")}</span>
            </Button>
          )}

          {pending && (
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
          )}

          <div className="border-t border-rule pt-2 -mx-1">
            <button
              onClick={() => {
                status.closePanel();
                status.checkNow();
              }}
              data-update-check="true"
              disabled={status.checking || !status.checkable}
              className={`${MENU_ITEM_CLASS} justify-between`}
            >
              <div className={ROW_CLASS}>
                <RefreshCw size={13} />
                <span>{status.checking ? t("updates.checking") : t("updates.check")}</span>
              </div>
            </button>
          </div>

          <div className="border-t border-rule pt-2">
            <CheckRow
              testId="update-auto-check"
              checked={status.autoCheck}
              disabled={!status.configured}
              onChange={status.setAutoCheck}
              label={t("updates.autoCheck")}
              title={status.configured ? undefined : blockedText(status.blocked)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One sentence, and it always names the state it is in. A panel that goes quiet
 * when it cannot tell the user anything reads as "nothing to do here", which for
 * a build with no release endpoint would be a lie.
 */
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

/**
 * Why there is nothing to check against, said plainly. "Updates unavailable"
 * would leave the reader to guess whether the file is stale, the network is
 * down, or the build was never pointed at a release — and each of those has a
 * different next action.
 */
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