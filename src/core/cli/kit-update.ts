import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isNewer } from "../update/manifest";
import { APP_VERSION, KIT_INSTALL_URL, KIT_MANIFEST_URL } from "../version";

/**
 * Is this copy of the kit behind the release?
 *
 * The only question in the kit that needs the network, and the only one that is
 * allowed to go unanswered: a design tool has to work on a plane, so a failure
 * here is silence, not an error, and the answer is cached for a day so the cost
 * is one request per machine rather than one per command.
 *
 * A warning is all it can be. Installing is a write into the directory an agent
 * reads its instructions from, in a runtime this process does not own — and the
 * copy already loaded into a session does not refresh, so an install made here
 * would only be in place for the next one. Detection, one line, one command to
 * copy: the same boundary as `--version` itself, which reports and does not act.
 */
export type KitUpdate =
  | { status: "off"; reason: "no-origin" | "dev-build" | "opted-out" }
  | { status: "unknown" }
  | { status: "current"; latest: string }
  /** `fromCache` is what keeps a warning from repeating on every command: the
   *  answer is reused for a day, and so is the decision to stay quiet about it. */
  | { status: "behind"; latest: string; message: string; fromCache: boolean };

type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const DAY = 24 * 60 * 60 * 1000;

export interface KitUpdateOptions {
  manifestUrl?: string;
  installUrl?: string;
  current?: string;
  cacheFile?: string;
  ttlMs?: number;
  timeoutMs?: number;
  /** Ignore the cache — the user asked out loud. */
  force?: boolean;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fetchImpl?: FetchLike;
}

/** One line the agent can act on without opening anything else. */
export function reinstallCommand(installUrl: string): string {
  return installUrl
    ? `npx skills add "${installUrl}" --skill fish-design -y`
    : `re-run the install command in SKILL.md § "Get the kit"`;
}

/**
 * The manifest is a signed envelope and this reader does not verify it — it has
 * no key, and a key in a downloadable kit proves nothing. It is only ever used to
 * decide whether to *mention* a newer release; the bytes that get installed are
 * pinned by a digest on the HTTPS page. Reading a version out of it must
 * therefore never be mistaken for trusting it.
 */
function versionOf(text: string): string | null {
  try {
    const envelope = JSON.parse(text) as { payload?: unknown };
    if (typeof envelope.payload !== "string") return null;
    const payload = JSON.parse(envelope.payload) as { version?: unknown };
    return typeof payload.version === "string" && payload.version ? payload.version : null;
  } catch {
    return null;
  }
}

function verdict(latest: string | null, current: string, installUrl: string, fromCache = false): KitUpdate {
  if (!latest) return { status: "unknown" };
  if (!isNewer(latest, current)) return { status: "current", latest };
  return {
    status: "behind",
    latest,
    fromCache,
    message:
      `a newer FISH is published: this kit is ${current}, the release is ${latest}.\n` +
      `  Re-install to pick up the ops and fixes that shipped since:\n` +
      `    ${reinstallCommand(installUrl)}`
  };
}

type Cached = { at: number; latest: string | null };

function readCache(file: string): Cached | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Cached>;
    if (typeof parsed?.at !== "number") return null;
    const latest = typeof parsed.latest === "string" ? parsed.latest : null;
    return { at: parsed.at, latest };
  } catch {
    return null;
  }
}

/**
 * A negative result is cached too: a machine with no network would otherwise pay
 * the timeout on every command instead of once a day.
 */
function writeCache(file: string, at: number, latest: string | null): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at, latest }));
  } catch {
    // A read-only tmp is not a reason for a document command to fail.
  }
}

export async function checkKitUpdate(opts: KitUpdateOptions = {}): Promise<KitUpdate> {
  const manifestUrl = opts.manifestUrl ?? KIT_MANIFEST_URL;
  const installUrl = opts.installUrl ?? KIT_INSTALL_URL;
  const current = opts.current ?? APP_VERSION;
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? DAY;
  const cacheFile = opts.cacheFile ?? path.join(os.tmpdir(), "fish-kit-update.json");

  if (env.FISH_NO_UPDATE_CHECK && env.FISH_NO_UPDATE_CHECK !== "0") return { status: "off", reason: "opted-out" };
  if (!manifestUrl) return { status: "off", reason: "no-origin" };
  if (current === "dev") return { status: "off", reason: "dev-build" };

  if (!opts.force) {
    const cached = readCache(cacheFile);
    if (cached && now() - cached.at < ttlMs) return verdict(cached.latest, current, installUrl, true);
  }

  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  let latest: string | null = null;
  if (typeof doFetch === "function") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1500);
    try {
      const response = await doFetch(manifestUrl, { signal: controller.signal });
      if (response.ok) latest = versionOf(await response.text());
    } catch {
      latest = null;
    } finally {
      clearTimeout(timer);
    }
  }

  writeCache(cacheFile, now(), latest);
  return verdict(latest, current, installUrl);
}
