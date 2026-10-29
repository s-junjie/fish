/**
 * The one way this app fetches something it did not ship.
 *
 * Two rules, both learned from the same class of failure:
 *
 * 1. **Every request gives up.** A half-open connection to an image host leaves
 *    the row that started it permanently "loading" — the caller's promise never
 *    settles, so the id it registered is never released and the status bar never
 *    stops saying so. There is no timeout anywhere in `fetch`.
 * 2. **A public proxy is not a transparent fallback.** `wsrv.nl` is a third
 *    party, and forwarding a URL to it hands over the intranet host, the signed
 *    query string and every path segment in it. That is a data leak dressed up
 *    as a CORS workaround, so it is allowed only for a URL that carries nothing
 *    private to begin with.
 */

export const EXTERNAL_FETCH_TIMEOUT_MS = 15_000;

export interface ExternalFetchInit {
  headers?: HeadersInit;
  /** The caller's own cancellation; merged with the timeout, never replaced by it. */
  signal?: AbortSignal;
  /** Override for callers whose payload is large and whose server is slow. */
  timeoutMs?: number;
}

/**
 * `fetch` with a deadline.
 *
 * Built on an `AbortController` rather than `AbortSignal.timeout` so the timer
 * can be cleared when the request settles: a signal nobody awaited keeps a
 * host process alive for the rest of its timeout, which in a test run is the
 * difference between a 40 s suite and a 55 s one.
 */
export async function externalFetch(url: string, init: ExternalFetchInit = {}): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? EXTERNAL_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The request timed out", "TimeoutError")),
    timeoutMs
  );
  const relay = () => controller.abort(init.signal?.reason);
  if (init.signal) {
    if (init.signal.aborted) relay();
    else init.signal.addEventListener("abort", relay, { once: true });
  }
  try {
    return await fetch(url, { headers: init.headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", relay);
  }
}

/**
 * A deadline, for callers that bring their own `fetch`.
 *
 * There is no `finally` here to clear the timer, so it is unref'd where the host
 * allows it: a signal nothing awaits must not hold a Node process open for the
 * rest of its timeout. In a browser `unref` does not exist and the timer is the
 * whole point.
 */
export function timeoutSignal(ms = EXTERNAL_FETCH_TIMEOUT_MS): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The request timed out", "TimeoutError")),
    ms
  );
  (timer as unknown as { unref?: () => void }).unref?.();
  return controller.signal;
}

/**
 * Whether a failure was a cancellation rather than a refusal.
 *
 * The distinction decides whether the proxy is even worth trying: a request that
 * ran out of time, or one the caller withdrew, will not be faster through a
 * third party, and retrying it there doubles the wait to thirty seconds.
 */
export function isAbortFailure(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/** Query keys whose presence means the URL is a credential, not an address. */
const SIGNED_QUERY_KEY =
  /^(x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|sig|signature|sas|token|access_token|id_token|auth|key|api_key|apikey|password|secret|policy|expires)$/i;

/** Hosts that name a machine on the user's own network rather than the internet. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".intranet", ".corp", ".home.arpa"];

const LOCAL_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

/** `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `100.64/10`, `0/8`, multicast. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return a >= 224;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOCAL_HOSTNAMES.has(host)) return true;
  if (host.includes(":")) {
    // `::1` loopback, `fc00::/7` unique-local, `fe80::/10` link-local.
    return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  if (isPrivateIpv4(host)) return true;
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // A single label is a hostname the local resolver owns (`nas`, `buildbox`); no
  // public name is spelled without a dot.
  return !host.includes(".");
}

/**
 * The third-party URL to retry through, or `null` when the address is not one
 * this app is entitled to hand to somebody else.
 *
 * `null` is the answer for anything the user did not publish: a loopback or
 * RFC 1918 host, a `.local` name, a URL carrying credentials or a signature,
 * and any plain-`http` URL (the proxy would receive what the origin chose not to
 * encrypt). Retrying is then simply refused, and the caller reports the original
 * failure — a browser refusing a cross-origin read is a fact about that server,
 * not a problem a proxy exists to hide.
 */
export function publicProxyUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (isPrivateHostname(parsed.hostname)) return null;
  for (const key of parsed.searchParams.keys()) {
    if (SIGNED_QUERY_KEY.test(key)) return null;
  }
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}`;
}
