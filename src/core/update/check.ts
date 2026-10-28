import { APP_VERSION } from "../version";
import { autoCheckEnabled, canVerify, isEmbedded, manifestUrl, releasePublicKey } from "./config";
import { isNewer, UpdateError, verifyEnvelope, type ReleasePayload } from "./manifest";

/**
 * Where a check looks. Resolved from the build by default; passed in by a caller
 * that is asking about a specific channel, and by the tests, which is the only
 * reason this is an argument rather than three module reads.
 */
export interface UpdateSources {
  url: string | null;
  key: JsonWebKey | null;
}

export function configuredSources(): UpdateSources {
  return { url: manifestUrl(), key: releasePublicKey() };
}

export type UpdateCheck =
  | { status: "disabled"; reason: DisabledReason }
  | { status: "current"; version: string }
  | { status: "update"; release: ReleasePayload }
  | { status: "error"; message: string };

export type DisabledReason =
  | "not-configured"
  | "no-webcrypto"
  | "embedded"
  | "auto-check-off";

export type FetchLike = (
  input: string,
  init?: { cache?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Why the check did not run, if it did not. Asked before any fetch, so a build
 * with no release endpoint opens with no network traffic at all.
 */
export function disabledReason(sources: UpdateSources = configuredSources()): DisabledReason | null {
  if (!sources.url || !sources.key) return "not-configured";
  if (!canVerify()) return "no-webcrypto";
  if (isEmbedded()) return "embedded";
  return null;
}

/**
 * A transport failure and a manifest refusal are worded differently on purpose.
 * A `TypeError` out of `fetch` is nearly always the response being unreadable —
 * CORS, or a shell opened from `file://` with an origin of `null` — and "the
 * release server answered 0" would send the reader looking in the wrong place.
 */
async function fetchText(url: string, fetchImpl?: FetchLike): Promise<string> {
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof doFetch !== "function") {
    throw new UpdateError("this browser cannot make network requests");
  }
  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await doFetch(url, { cache: "no-store" });
  } catch {
    throw new UpdateError(
      "the release server could not be reached from this file — it may not allow direct reads"
    );
  }
  if (!response.ok) throw new UpdateError(`the release server answered ${response.status}`);
  return response.text();
}

/**
 * One check: is there a newer shell, and can it be proved.
 *
 * Never downloads anything and never writes anything — a badge and a panel row
 * are all it feeds. `manual` is the user asking out loud, so it runs even when
 * the launch check is switched off.
 */
export async function checkForUpdate(
  opts: { manual?: boolean; fetchImpl?: FetchLike; sources?: UpdateSources } = {}
): Promise<UpdateCheck> {
  const sources = opts.sources ?? configuredSources();
  const blocked = disabledReason(sources);
  if (blocked) return { status: "disabled", reason: blocked };
  if (!opts.manual && !autoCheckEnabled()) return { status: "disabled", reason: "auto-check-off" };
  try {
    const release = await verifyEnvelope(
      await fetchText(sources.url!, opts.fetchImpl),
      sources.key!
    );
    // A manifest at or below this build is not an update. Offering one would be
    // a downgrade, so it reads as "current" and the panel stays quiet.
    if (!isNewer(release.version, APP_VERSION)) return { status: "current", version: APP_VERSION };
    return { status: "update", release };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The launch pass. Returns whatever the check found, refusals included, and
 * null only when there was nothing to run.
 *
 * An error is a result, not a silence: a panel that cannot distinguish "I
 * checked and you are current" from "I could not reach the server" answers both
 * with "you are on the latest version", which is a claim it has no basis for.
 * What is *announced* is a separate decision, and lives with the announcement.
 */
export async function checkAtLaunch(
  opts: { fetchImpl?: FetchLike; sources?: UpdateSources } = {}
): Promise<UpdateCheck | null> {
  const blocked = disabledReason(opts.sources ?? configuredSources());
  if (blocked) return null;
  return checkForUpdate(opts);
}