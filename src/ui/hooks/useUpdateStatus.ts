import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { APP_VERSION } from "../../core/version";
import {
  applyUpdate,
  autoCheckEnabled,
  checkAtLaunch,
  checkForUpdate,
  consumeJustUpdated,
  disabledReason,
  isConfigured,
  setAutoCheckEnabled,
  type ApplyOutcome,
  type DisabledReason,
  type UpdateCheck
} from "../../core/update";
import type { DesignDocument } from "../../core/dsl/types";

/**
 * Not at mount: the shell's own first paint is the thing the user opened the
 * file for, and a check that competes with it is a check that wins the argument
 * only when the network is fast. The badge it produces is not urgent — a version
 * does not expire.
 */
const LAUNCH_CHECK_DELAY_MS = 1500;

export interface UpdateStatus {
  /** False in a build with no release endpoint: the panel says so rather than failing. */
  configured: boolean;
  /** False when a check cannot run at all here (no key, no WebCrypto, embedded). */
  checkable: boolean;
  /** Why it cannot, for the panel to name rather than hint at. */
  blocked: DisabledReason | null;
  version: string;
  check: UpdateCheck | null;
  checking: boolean;
  applying: boolean;
  /** Set once an update has been written, so the panel can offer the reload. */
  applied: ApplyOutcome | null;
  /** The version a launch check found, for the shell to announce once. */
  announced: string | null;
  clearAnnouncement: () => void;
  autoCheck: boolean;
  setAutoCheck: (on: boolean) => void;
  /** The panel is owned here, not in the control, so a notice can open it. */
  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  checkNow: () => void;
  update: () => void;
  reload: () => void;
}

/**
 * The update state machine, and the only thing that writes a new shell.
 *
 * Nothing here touches the document: an update moves the *shell*, and the design
 * is carried across untouched by `applyUpdate`. The tab that applied one keeps
 * running the old runtime until it reloads, which is why `reload` is a separate
 * act rather than a side effect of the write — reloading under the user
 * mid-edit would discard whatever they had done since the last save.
 */
export function useUpdateStatus(doc: DesignDocument): UpdateStatus {
  const configured = isConfigured();
  const blocked = disabledReason();
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<ApplyOutcome | null>(null);
  const [announced, setAnnounced] = useState<string | null>(null);
  const [autoCheck, setAutoCheckState] = useState(autoCheckEnabled);
  const [panelOpen, setPanelOpen] = useState(false);
  const liveRef = useRef(true);

  useEffect(() => {
    liveRef.current = true;

    if (typeof window !== "undefined") {
      const mock = (available = true, version = "0.2.0") => {
        if (available) {
          setCheck({
            status: "update",
            release: {
              app: "fish",
              version,
              url: `https://dl.fish.themindstudio.cc/shell/${version}/index.html`,
              sha256: "0".repeat(64)
            }
          });
          setAnnounced(version);
        } else {
          setCheck(null);
          setAnnounced(null);
          setApplied(null);
        }
      };
      (window as any).__mockUpdate = mock;

      if (window.location.search.includes("mockUpdate") || window.location.hash.includes("mockUpdate")) {
        const timer = setTimeout(() => {
          if (liveRef.current) mock(true, "0.2.0");
        }, 300);
        return () => {
          liveRef.current = false;
          clearTimeout(timer);
        };
      }
    }

    return () => {
      liveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!configured) return;
    // A file this tab just rewrote is already the new version. Asking the server
    // again would find nothing, and finding nothing is what the panel would then
    // report — so the version is read from the write instead.
    const justInstalled = consumeJustUpdated();
    if (justInstalled) {
      setApplied({ ok: true, method: "in-place", version: justInstalled });
      return;
    }
    const timer = setTimeout(() => {
      void checkAtLaunch().then((result) => {
        if (!liveRef.current || !result) return;
        setCheck(result);
        // Only a find is announced. A refusal at startup is the panel's to
        // report when it is opened, not a toast nobody asked for.
        if (result.status === "update") setAnnounced(result.release.version);
      });
    }, LAUNCH_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [configured]);

  const checkNow = useCallback(() => {
    if (checking) return;
    setChecking(true);
    void checkForUpdate({ manual: true }).then((result) => {
      if (!liveRef.current) return;
      setCheck(result);
      setChecking(false);
    });
  }, [checking]);

  const setAutoCheck = useCallback((on: boolean) => {
    setAutoCheckEnabled(on);
    setAutoCheckState(on);
  }, []);

  const update = useCallback(() => {
    if (applying || check?.status !== "update") return;
    setApplying(true);
    void applyUpdate(doc, check.release).then((outcome) => {
      if (!liveRef.current) return;
      setApplying(false);
      setApplied(outcome);
    });
  }, [applying, check, doc]);

  const reload = useCallback(() => {
    location.reload();
  }, []);

  return {
    configured,
    checkable: blocked === null,
    blocked,
    version: APP_VERSION,
    check,
    checking,
    applying,
    applied,
    announced,
    clearAnnouncement: () => setAnnounced(null),
    autoCheck,
    setAutoCheck,
    panelOpen,
    openPanel: () => setPanelOpen(true),
    closePanel: () => setPanelOpen(false),
    checkNow,
    update,
    reload
  };
}