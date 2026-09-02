import assert from "node:assert/strict";
import { test } from "vitest";
import { createTanstackStartIsrDocument } from "../../lib/serverless-tanstack-start/isr-policy";

test("uses shared max-age and preserves stale-while-revalidate", () => {
  assert.deepEqual(
    createTanstackStartIsrDocument({
      cacheControl:
        "public, max-age=30, s-maxage=120, stale-while-revalidate=600",
      generatedAt: 123,
      maxRedirects: 4,
      requestHeaders: { "x-static": "yes" },
      routePath: "/posts/one",
      staticServerFunctionPaths: [
        `/__tsr/staticServerFnCache/${"b".repeat(40)}.json`,
      ],
    }),
    {
      cacheControl:
        "public, max-age=30, s-maxage=120, stale-while-revalidate=600",
      generatedAt: 123,
      maxRedirects: 4,
      requestHeaders: { "x-static": "yes" },
      revalidateSeconds: 120,
      routePath: "/posts/one",
      staticServerFunctionPaths: [
        `/__tsr/staticServerFnCache/${"b".repeat(40)}.json`,
      ],
      staleWhileRevalidateSeconds: 600,
    },
  );
});

test("does not enable ISR for private, no-store, or unbounded responses", () => {
  const policy = (cacheControl: string) =>
    createTanstackStartIsrDocument({
      cacheControl,
      maxRedirects: 5,
      requestHeaders: {},
      routePath: "/private",
    });
  assert.equal(policy("private, max-age=60"), null);
  assert.equal(policy("public, max-age=60, no-store"), null);
  assert.equal(policy("public, stale-while-revalidate=60"), null);
  assert.equal(policy("public, max-age=invalid"), null);
});

