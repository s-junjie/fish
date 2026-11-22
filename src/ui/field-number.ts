
export const MAX_FIELD_DECIMALS = 2;

const SCALE = 10 ** MAX_FIELD_DECIMALS;

export const roundFieldNumber = (n: number): number => Math.round(n * SCALE) / SCALE;

export const formatFieldNumber = (n?: number): string =>
  n == null ? "" : String(roundFieldNumber(n));
