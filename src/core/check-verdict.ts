import type { NormalizationRepair } from "./dsl/normalize/shared";

/**
 * The verdict `fish check` reaches from the diagnostics it collected.
 *
 * It lives apart from the command so it can be tested without a file on disk or
 * a `process.exitCode`: the one thing that has to be true — and that a document
 * omitting `canvas` proved was not — is that a repair which only RECORDS a
 * default the engine supplied does not fail the check. Only a "lossy" repair
 * (a dropped, ignored or reinterpreted declaration) does.
 */
export interface CheckVerdict {
  ok: boolean;
  /** How many repairs actually discarded or reinterpreted authored input. */
  lossy: number;
  /** The suffix for the `FAIL` line, e.g. `" (repairs)"`; empty when errors explain it. */
  failReason: string;
}

export function checkVerdict(
  repairs: NormalizationRepair[],
  errors: number,
  warnings: number,
  strict: boolean
): CheckVerdict {
  const lossy = repairs.filter((r) => r.severity !== "info").length;
  const ok = errors === 0 && lossy === 0 && !(strict && warnings > 0);
  const failReason =
    errors > 0 ? "" : lossy > 0 ? " (repairs)" : strict && warnings > 0 ? " (--strict)" : "";
  return { ok, lossy, failReason };
}
