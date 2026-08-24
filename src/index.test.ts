import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index.js";

const TOKEN = "test-token";
const SCREENER_URL =
  "https://www.ishares.com/us/product-screener/product-screener-v3.1.jsn?dcrPath=x";

/**
 * A target no other test has asked for. Cloudflare's cache outlives a single
 * test, so a shared URL would let one test's cached body answer the next one's
 * request and hide the upstream call it was asserting on.
 */
function uniqueTarget(): string {
  return `${SCREENER_URL}&t=${crypto.randomUUID()}`;
}

interface UpstreamCall {
  url: string;
  headers: Headers;
}

/** Records what the Worker asked upstream and answers with a canned response. */
function stubUpstream(reply: () => Response): UpstreamCall[] {
  const calls: UpstreamCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
    });
    return reply();
  });
  return calls;
}

function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  // Nothing should reach the network; a test that needs an upstream stubs one.
  vi.stubGlobal("fetch", async () => {
    throw new Error("unexpected upstream request");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One request through the Worker, with the bearer header unless told otherwise. */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${TOKEN}`);
  const request = new Request(`https://proxy.example.com${path}`, { ...init, headers });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function proxied(target: string): string {
  return `/fetch?u=${encodeURIComponent(target)}`;
}

describe("auth", () => {
  it("refuses a request with no token", async () => {
    const response = await call(proxied(SCREENER_URL), { headers: { authorization: "" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("x-proxy-error")).toBe("1");
  });

  it("refuses a wrong token", async () => {
    const response = await call(proxied(SCREENER_URL), { headers: { authorization: `Bearer ${TOKEN}x` } });
    expect(response.status).toBe(401);
  });

  it("refuses a non-GET method", async () => {
    const response = await call(proxied(SCREENER_URL), { method: "POST" });
    expect(response.status).toBe(405);
  });

  it("fails closed when no secret is configured", async () => {
    const request = new Request(`https://proxy.example.com${proxied(SCREENER_URL)}`);
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, { ...env, PROXY_TOKEN: "" }, ctx);
    expect(response.status).toBe(500);
  });
});

describe("target validation", () => {
  it("rejects a missing target", async () => {
    const response = await call("/fetch");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("`u`") });
  });

  it("rejects a host outside the allowlist", async () => {
    const response = await call(proxied("https://example.com/anything"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("host not allowed"),
    });
  });

  it("rejects a look-alike host", async () => {
    const response = await call(proxied("https://www.ishares.com.evil.example/x"));
    expect(response.status).toBe(400);
  });

  it("rejects a non-https scheme", async () => {
    const response = await call(proxied("http://www.ishares.com/us/x.jsn"));
    expect(response.status).toBe(400);
  });

  it("rejects an unknown path", async () => {
    expect((await call("/")).status).toBe(404);
  });
});

describe("relaying", () => {
  it("returns the upstream body and reports the edge", async () => {
    const target = uniqueTarget();
    const calls = stubUpstream(() => json('{"products":[]}'));

    const response = await call(proxied(target));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"products":[]}');
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-proxy-colo")).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(target);
  });

  it("sends a browser User-Agent when the caller does not", async () => {
    const calls = stubUpstream(() => json("{}"));
    await call(proxied(uniqueTarget()));
    expect(calls[0]!.headers.get("user-agent")).toContain("Mozilla/5.0");
  });

  it("forwards the caller's own User-Agent and Referer", async () => {
    const calls = stubUpstream(() => json("{}"));
    await call(proxied(uniqueTarget()), {
      headers: {
        "user-agent": "finance-mcp-server/1.0",
        referer: "https://www.ishares.com/us/products/etf-investments",
      },
    });
    expect(calls[0]!.headers.get("user-agent")).toBe("finance-mcp-server/1.0");
    expect(calls[0]!.headers.get("referer")).toBe(
      "https://www.ishares.com/us/products/etf-investments",
    );
  });

  it("never forwards the caller's cookies or credentials", async () => {
    const calls = stubUpstream(() => json("{}"));
    await call(proxied(uniqueTarget()), { headers: { cookie: "session=secret" } });
    expect(calls[0]!.headers.get("cookie")).toBeNull();
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("passes an upstream rejection through with its status, unmarked as a proxy error", async () => {
    stubUpstream(() => new Response("forbidden", { status: 403 }));

    const response = await call(proxied(uniqueTarget()));
    expect(response.status).toBe(403);
    expect(response.headers.get("x-proxy-error")).toBeNull();
    expect(response.headers.get("x-proxy-upstream-status")).toBe("403");
    expect(response.headers.get("x-proxy-cache")).toBe("skip");
  });

  it("reports a transport failure as its own 502", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection reset");
    });

    const response = await call(proxied(uniqueTarget()));
    expect(response.status).toBe(502);
    expect(response.headers.get("x-proxy-error")).toBe("1");
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("connection reset"),
    });
  });

  it("names an HTML interstitial and refuses to cache it", async () => {
    const target = uniqueTarget();
    stubUpstream(
      () =>
        new Response("<!DOCTYPE html><html><body>Access Denied</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const response = await call(proxied(target));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-proxy-blocked")).toBe("html-interstitial");
    expect(response.headers.get("x-proxy-cache")).toBe("skip");
  });
});

/**
 * The relay streams rather than buffering, which is what keeps time-to-first-byte
 * flat as payloads grow — the fund list is 1.9 MB, and reading it all before
 * sending anything cost two seconds. The risk that trade introduces is
 * truncation: the head is consumed to sniff it and has to be put back, and the
 * cache branch is a tee that nothing is waiting on. Both are checked here on a
 * body several times the sniff window.
 */
describe("streaming", () => {
  const big = "x".repeat(4096) + "END";

  it("relays a body larger than the sniff window byte for byte", async () => {
    const target = uniqueTarget();
    stubUpstream(() => json(`{"pad":"${big}"}`));

    const response = await call(proxied(target));
    const text = await response.text();
    expect(text).toBe(`{"pad":"${big}"}`);
    expect(text.endsWith('END"}')).toBe(true);
  });

  it("caches the whole of a large body, not just the sniffed head", async () => {
    const target = uniqueTarget();
    const calls = stubUpstream(() => json(`{"pad":"${big}"}`));

    const first = await call(proxied(target));
    expect(await first.text()).toBe(`{"pad":"${big}"}`);

    const second = await call(proxied(target));
    expect(second.headers.get("x-proxy-cache")).toBe("hit");
    expect(await second.text()).toBe(`{"pad":"${big}"}`);
    expect(calls).toHaveLength(1);
  });

  it("still recognizes an interstitial that arrives ahead of a long body", async () => {
    const target = uniqueTarget();
    stubUpstream(
      () =>
        new Response(`<!DOCTYPE html><html><body>Access Denied${big}</body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const response = await call(proxied(target));
    expect(response.headers.get("x-proxy-blocked")).toBe("html-interstitial");
    expect(response.headers.get("x-proxy-cache")).toBe("skip");
    expect((await response.text()).length).toBeGreaterThan(4096);
  });
});

describe("caching", () => {
  it("serves a repeat request without a second upstream call", async () => {
    const target = uniqueTarget();
    const calls = stubUpstream(() => json('{"cached":true}'));

    const first = await call(proxied(target));
    expect(first.headers.get("x-proxy-cache")).toBe("miss");
    expect(await first.text()).toBe('{"cached":true}');

    const second = await call(proxied(target));
    expect(second.headers.get("x-proxy-cache")).toBe("hit");
    expect(await second.text()).toBe('{"cached":true}');
    expect(calls).toHaveLength(1);
  });
});

describe("health", () => {
  it("reports the colo it was scheduled in", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      allowedHosts: ["www.ishares.com"],
      cacheTtlSeconds: 3600,
    });
  });
});
