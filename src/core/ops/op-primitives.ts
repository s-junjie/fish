export interface OpOutcome {
  index: number;
  op: string;
  ok: boolean;
  detail: string;
  id?: string;
}

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
export const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

let idCounter = 0;
export const mintId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${(idCounter++).toString(36)}`;
