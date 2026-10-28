/** Seconds → `mm:ss`, the one clock every video surface in the workbench shows. */
export function formatDuration(seconds: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}