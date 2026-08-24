# fintools-ishares-proxy

A single-purpose Cloudflare Worker that relays GET requests to iShares' two
public JSON planes for [finance-mcp-server](../finance-mcp-server)'s fund
ingest, and reports which Cloudflare colo the request egressed from.

It exists because BlackRock fronts those endpoints with Akamai Bot Manager,
which answers a request it dislikes with an HTML interstitial rather than an
error — so a blocked ingest run reads as a source with nothing in it.

## What this can and cannot fix

Read this before deploying, because it decides whether the Worker is worth
keeping:

| Block dimension | Does the Worker help? |
|---|---|
| Egress geography | It **changes**, but you do not **choose** it — a Worker runs in the colo nearest the caller. An ingest host in Hong Kong gets a Hong Kong colo. |
| IP reputation / datacenter ASN | Barely. AS13335 is a datacenter range like any other. |
| TLS/HTTP2 fingerprint (JA3/JA4) | Not at all. Subrequests use Cloudflare's TLS stack; no header makes it look like Chrome. |

`GET /health` reports the colo and country so this is measured rather than
assumed. If it answers with the same country the ingest host already sits in,
a geographic block will reproduce and the Worker is not the fix — a US VPS
running `curl-impersonate`, or scheduled ingest on a US GitHub Actions runner,
are the next options.

**Measured 2026-08-24, from this machine (NZ):** both endpoints answer `200`
with real JSON — the 1.9 MB screener and a 204 KB holdings payload for IVV.
Whatever blocked the earlier attempt was specific to that environment's egress,
not to iShares refusing this network.

## Setup

```bash
npm install
echo 'PROXY_TOKEN=some-long-random-string' > .dev.vars   # local dev only
npm run dev
```

Deploy:

```bash
npx wrangler deploy
npx wrangler secret put PROXY_TOKEN
```

The token is a static shared secret — generate one with
`openssl rand -hex 32` and hand the same value to the client.

## API

Every request needs `Authorization: Bearer <PROXY_TOKEN>`. Only `GET` is served.

### `GET /fetch?u=<url-encoded target>`

Fetches the target and relays it verbatim — status, body, content type.

```bash
curl -H "Authorization: Bearer $PROXY_TOKEN" \
  --get --data-urlencode "u=https://www.ishares.com/us/product-screener/product-screener-v3.1.jsn?dcrPath=..." \
  https://fintools-ishares-proxy.<subdomain>.workers.dev/fetch
```

The target must be `https:` on an allow-listed host (`ALLOWED_HOSTS`,
default `www.ishares.com`). That allowlist, not the token, is what keeps a
leaked credential from yielding a general-purpose open proxy.

Response headers:

| Header | Meaning |
|---|---|
| `x-proxy-colo`, `x-proxy-country` | Where the subrequest egressed from |
| `x-proxy-upstream-status` | What iShares answered |
| `x-proxy-cache` | `hit`, `miss`, or `skip` (not cacheable) |
| `x-proxy-blocked` | Present when the body is an HTML interstitial |
| `x-proxy-error` | Present only when **this proxy** refused (401/400/404/405/502) — never on a relayed upstream answer |

The last two matter: `x-proxy-error` lets the client tell "the proxy said no"
from "iShares said no", and the caller's own 403 stays a 403 with its real body.

### `GET /health`

```json
{ "ok": true, "x-proxy-colo": "AKL", "x-proxy-country": "NZ",
  "allowedHosts": ["www.ishares.com"], "cacheTtlSeconds": 3600 }
```

## Caching

Successful non-HTML `200`s are cached at the edge for `CACHE_TTL_SECONDS`
(default 3600), keyed on the target URL. An interstitial or an error is never
cached — freezing a block page for an hour would make every retry in that
window a lie. Bodies are buffered (32 MB cap) so they can be sniffed before
they are stored.

Set `CACHE_TTL_SECONDS` to `0` in `wrangler.jsonc` to disable caching.

## Headers sent upstream

`user-agent`, `referer`, `accept` and `accept-language` are forwarded from the
caller so the client keeps ownership of them — the User-Agent especially, which
is the one thing these endpoints demand. Everything else, cookies and the
caller's own `Authorization` above all, is dropped: this relay carries no
identity of its own or anyone else's.

## Wiring it into finance-mcp-server

`IsharesClient` already takes an injectable `fetchImpl` and `endpoints`, so the
client side is an env-var read in `src/server/funds/providers/ishares/client.ts`
— rewrite the URL in `get()` and add the bearer header when
`ISHARES_PROXY_BASE` / `ISHARES_PROXY_TOKEN` are set, direct otherwise, with
`--probe` printing which route it took. That change lives entirely in the
provider directory; the pipeline never learns the proxy exists.

## Tests

```bash
npm run typecheck && npm test
```

18 tests over auth, the host allowlist, header forwarding, upstream pass-through,
interstitial detection and caching, running in workerd via
`@cloudflare/vitest-pool-workers`.
