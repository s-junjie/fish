import { ASSET_MIME, type AssetInsertPayload } from "./types";

export function dragPayload(e: DragEvent | Event, payload: AssetInsertPayload): void {
  const dt = (e as DragEvent).dataTransfer;
  if (!dt) return;
  dt.setData(ASSET_MIME, JSON.stringify(payload));
  dt.effectAllowed = "copy";
}
