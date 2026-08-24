/**
 * The Worker's bindings, declared where the runtime expects them so
 * `cloudflare:test`'s `env` and the handler agree on one type.
 *
 * `PROXY_TOKEN` is a secret (`wrangler secret put PROXY_TOKEN`); the other two
 * are plain vars set in `wrangler.jsonc`.
 */
declare namespace Cloudflare {
  interface Env {
    /** Shared secret, presented by the caller as `Authorization: Bearer <token>`. */
    PROXY_TOKEN: string;
    /** Comma-separated hostnames this proxy is willing to fetch. */
    ALLOWED_HOSTS?: string;
    /** Seconds a successful body is served from cache. `0` disables caching. */
    CACHE_TTL_SECONDS?: string;
  }
}
