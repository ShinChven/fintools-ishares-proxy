import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The deployed secret has no place in a test run; the suite asserts
      // against this one.
      miniflare: { bindings: { PROXY_TOKEN: "test-token" } },
    }),
  ],
});
