import { useEffect, useState } from "preact/hooks";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import type { SaveStatusKind, SaveStatusState } from "../hooks/useFileWriteback";

interface SaveStatusProps {
  /** Null when there is nothing to report; the line fades out on the way there. */
  status: SaveStatusState | null;
}

/**
 * One colour per outcome, on the text and its glyph alike.
 *
 * `brand` is NOT one of them: the title bar's single hot cell is the zoom
 * readout, and a second amber thing in the same bar is two elements competing
 * for the same glance. A save landing is a confirmation, not an armed tool.
 */
const TONE_CLASS: Record<SaveStatusKind, string> = {
  busy: "text-ink-dim",
  ok: "text-ink-dim",
  error: "text-measure-coral"
};

/**
 * The transient save result, laid over the title bar's centre slot — the one the
 * auto-save status owns.
 *
 * Reusing that spot rather than taking a new one is the whole design: two things
 * reporting on the same file from two places in the same bar read as two
 * different subjects, and one slot means there is one thing to look at. The bar
 * cannot reflow either way — the badge's own box keeps the slot's width, and
 * this rides over it. Its `panel` fill is what makes that true rather than
 * approximate: a translucent overlay COMPOSITES, and adding its own wash to the
 * badge behind it would leave the two legible through each other.
 *
 * It stays MOUNTED with no message rather than appearing and disappearing: a
 * transition needs the element to exist on both sides of the change, so a node
 * created by the message would arrive at full opacity with no fade. The last
 * message is held after `status` clears so the fade-out has something to fade,
 * and dropped on `transitionend`. The caller crossfades the badge on the other
 * side of the same switch.
 */
export function SaveStatus({ status }: SaveStatusProps) {
  const [last, setLast] = useState<SaveStatusState | null>(null);
  useEffect(() => {
    if (status) setLast(status);
  }, [status]);

  const shown = status ?? last;
  const visible = status !== null;

  return (
    <span
      data-save-status={visible && shown ? shown.kind : undefined}
      /* A screen reader has no other way to learn that the write landed, and
         the node is always here, so the live region is real rather than one
         that mounts with its own message and announces nothing. */
      aria-live="polite"
      className={`pointer-events-none absolute left-1/2 top-1/2 flex items-center gap-1.5 whitespace-nowrap rounded-full bg-panel px-2.5 py-1 text-row transition-[opacity,transform] duration-base ease-snap ${
        visible
          ? "-translate-x-1/2 -translate-y-1/2 scale-100 opacity-100"
          : "-translate-x-1/2 -translate-y-1/2 scale-95 opacity-0"
      } ${shown ? TONE_CLASS[shown.kind] : ""}`}
      onTransitionEnd={() => {
        if (!visible) setLast(null);
      }}
    >
      {shown && (
        <>
          {shown.kind === "busy" && <Loader2 size={11} className="animate-spin flex-none" />}
          {shown.kind === "ok" && <Check size={11} className="flex-none" />}
          {shown.kind === "error" && <AlertTriangle size={11} className="flex-none" />}
          <span>{shown.text}</span>
        </>
      )}
    </span>
  );
}
