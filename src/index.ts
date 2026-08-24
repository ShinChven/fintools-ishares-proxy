/**
 * A single-purpose fetch relay for iShares' public JSON planes.
 *
 * The ingest job in finance-mcp-server talks to two keyless iShares endpoints
 * (the product screener and the product page's `get-product-data`). They are
 * fronted by Akamai Bot Manager, which answers a request it dislikes with an
 * HTML interstitial rather than an error — so a blocked run reads as a source
 * with nothing in it. This Worker exists to move that request to a Cloudflare
 * edge node and to say plainly, in its own headers, where it egressed from.
 *
 * What it can and cannot fix is worth stating up front, because it decides
 * whether deploying it was worth the trouble:
 *
 *   - Egress geography: it changes, but is NOT chosen. A Worker runs in the
 *     colo nearest the *caller*, so an ingest host in Hong Kong gets a Hong
 *     Kong colo and the same block. `/health` reports the colo and country
 *     precisely so this is measurable rather than assumed.
 *   - IP reputation: barely. AS13335 is a datacenter range like any other.
 *   - TLS/HTTP2 fingerprint (JA3/JA4): not at all. Subrequests use Cloudflare's
 *     stack; no header we set makes it look like Chrome.
 *
 * So this is worth deploying if the block is geographic, and worth abandoning
 * quickly if it is not — which is why the diagnostics are as much of the design
 * as the proxying.
 */

/** The bindings this Worker reads; declared in `src/env.d.ts`. */
export type Env = Cloudflare.Env;

const DEFAULT_ALLOWED_HOSTS = "www.ishares.com";
const DEFAULT_CACHE_TTL_SECONDS = 3600;

const UPSTREAM_TIMEOUT_MS = 25_000;

/**
 * Bodies are buffered so they can be sniffed before caching, which caps how
 * large a response this will relay. The whole US screener is a few megabytes
 * and the largest holdings payload is smaller; 32 MB is slack, not a target.
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * The headers that actually matter to iShares, forwarded from the caller so the
 * client keeps ownership of them — the User-Agent especially, which is the one
 * thing the endpoints demand. Anything else the caller sends (cookies above
 * all) is dropped: this relay carries no identity of its own or anyone else's.
 */
const FORWARDED_HEADERS = ["user-agent", "referer", "accept", "accept-language"] as const;

const DEFAULT_UPSTREAM_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
};

/**
 * Compares two secrets without leaking where they diverge. Length is compared
 * first and does leak — that is the accepted trade in every implementation of
 * this, and a token's length is not the secret.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/** Proxy-generated responses carry `x-proxy-error`, so the caller can tell a refusal here from one upstream. */
function proxyError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-proxy-error": "1",
      "cache-control": "no-store",
    },
  });
}

function allowedHosts(env: Env): Set<string> {
  return new Set(
    (env.ALLOWED_HOSTS ?? DEFAULT_ALLOWED_HOSTS)
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

function cacheTtlSeconds(env: Env): number {
  const raw = env.CACHE_TTL_SECONDS;
  if (raw === undefined) return DEFAULT_CACHE_TTL_SECONDS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_CACHE_TTL_SECONDS;
}

/**
 * Validates the requested target. Only absolute `https:` URLs on an allow-listed
 * host pass — the allowlist, not the token, is what keeps a leaked credential
 * from yielding a general-purpose open proxy for someone else's traffic.
 */
function resolveTarget(raw: string | null, env: Env): { url: string } | { error: string } {
  if (!raw) return { error: "missing `u` query parameter" };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: "`u` is not an absolute URL" };
  }
  if (parsed.protocol !== "https:") return { error: "`u` must be an https URL" };
  if (!allowedHosts(env).has(parsed.hostname.toLowerCase())) {
    return { error: `host not allowed: ${parsed.hostname}` };
  }
  return { url: parsed.toString() };
}

function upstreamHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(DEFAULT_UPSTREAM_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

/**
 * The same sniff the client does, for a different reason: there it turns a
 * challenge page into an error instead of an empty portfolio, here it keeps one
 * out of the cache. Caching a block page would freeze the failure for an hour
 * and make every retry in that window a lie.
 */
function looksLikeHtml(bytes: ArrayBuffer): boolean {
  const head = new TextDecoder()
    .decode(bytes.slice(0, 512))
    .trimStart()
    .toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head");
}

/** Where this request egressed from — the whole point of the diagnostics. */
function edgeHeaders(request: Request): Record<string, string> {
  const cf = request.cf as { colo?: string; country?: string } | undefined;
  return {
    "x-proxy-colo": cf?.colo ?? "unknown",
    "x-proxy-country": cf?.country ?? "unknown",
  };
}

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const target = resolveTarget(new URL(request.url).searchParams.get("u"), env);
  if ("error" in target) return proxyError(400, target.error);

  const ttl = cacheTtlSeconds(env);
  const cache = caches.default;
  // Keyed on the target URL alone: the token is an access check on this Worker,
  // not part of what identifies an iShares document.
  const cacheKey = new Request(target.url, { method: "GET" });

  if (ttl > 0) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("x-proxy-cache", "hit");
      for (const [name, value] of Object.entries(edgeHeaders(request))) headers.set(name, value);
      return new Response(hit.body, { status: hit.status, headers });
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.url, {
      method: "GET",
      headers: upstreamHeaders(request),
      redirect: "follow",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout or a transport failure is this proxy's problem, not an answer
    // from iShares, and 502 plus `x-proxy-error` says so.
    return proxyError(502, `upstream fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return proxyError(502, `upstream body too large (${body.byteLength} bytes)`);
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const isHtml = looksLikeHtml(body);
  // Only a genuine document is cached. A non-200 or an interstitial is relayed
  // verbatim — the caller's own HTML check is what turns it into an error, and
  // it needs to see it every time it asks, not once an hour.
  const cacheable = ttl > 0 && upstream.status === 200 && !isHtml;

  const headers = new Headers({
    "content-type": contentType,
    "x-proxy-cache": cacheable ? "miss" : "skip",
    "x-proxy-upstream-status": String(upstream.status),
    ...edgeHeaders(request),
  });
  if (isHtml) {
    // Named here as well as sniffed by the caller, because from the edge this
    // is the single most useful fact about the run: the block is reproducing
    // through Cloudflare, and the colo header says from where.
    headers.set("x-proxy-blocked", "html-interstitial");
  }

  if (cacheable) {
    const stored = new Response(body, {
      status: 200,
      headers: { "content-type": contentType, "cache-control": `public, max-age=${ttl}` },
    });
    ctx.waitUntil(cache.put(cacheKey, stored));
  } else {
    headers.set("cache-control", "no-store");
  }

  return new Response(body, { status: upstream.status, headers });
}

/**
 * Reports the colo this Worker was scheduled in. Run it from the ingest host
 * before trusting the proxy: if it answers `HKG`/`HK`, egress geography has not
 * changed and a geographic block will reproduce exactly as before.
 */
function handleHealth(request: Request, env: Env): Response {
  return new Response(
    JSON.stringify(
      {
        ok: true,
        ...edgeHeaders(request),
        allowedHosts: [...allowedHosts(env)],
        cacheTtlSeconds: cacheTtlSeconds(env),
        now: new Date().toISOString(),
      },
      null,
      2,
    ),
    { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") return proxyError(405, "only GET is supported");

    // A misconfigured deploy must not answer as an open proxy, so a missing
    // secret fails closed rather than skipping the check.
    if (!env.PROXY_TOKEN) return proxyError(500, "PROXY_TOKEN is not configured");

    const token = bearerToken(request);
    if (!token || !timingSafeEqual(token, env.PROXY_TOKEN)) {
      return proxyError(401, "missing or invalid bearer token");
    }

    const { pathname } = new URL(request.url);
    if (pathname === "/health") return handleHealth(request, env);
    if (pathname === "/fetch") return handleFetch(request, env, ctx);
    return proxyError(404, `unknown path: ${pathname}`);
  },
} satisfies ExportedHandler<Env>;
