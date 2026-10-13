/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Handler-only seam: real pinned Next root-param partitioning, without adding
// a learner-facing root-params compiler API to Tuto. The frozen mode mirrors
// the existing SecureExec use-cache clock translation while keeping native ALS.
const { AsyncLocalStorage } = require("node:async_hooks");
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
if (process.env.TUTO_PARTITION_PROBE_CLOCK === "frozen") {
  const fs = require("node:fs");
  const Module = require("node:module");
  const wrapper = require.resolve("next/dist/server/use-cache/use-cache-wrapper");
  const original = Module._extensions[".js"];
  Module._extensions[".js"] = (module, filename) => {
    if (filename !== wrapper) return original(module, filename);
    const source = fs.readFileSync(filename, "utf8");
    const clock = "performance.timeOrigin + performance.now()";
    if (!source.includes(clock)) throw new Error("Pinned Next cache clock changed.");
    module._compile(source.replaceAll(clock, "Date.now()"), filename);
  };
  const frozenTime = Date.now();
  Date.now = () => frozenTime;
}
const { handleCacheResponse, nextCache, runWithNextCache, useCache, withCacheMetrics } = require("../../../lib/serverless-next/cache-runtime.cjs");
const { getRootParam } = require("next/dist/server/request/root-params");
const counts = new Map();
const artifact = {
  generation: "partition-probe", workspaceKey: "partition-probe-" + process.env.TUTO_PARTITION_PROBE_CLOCK, actionManifest: {},
  clientModules: {}, clientReferenceManifest: {}, router: { routes: [{ pattern: "/[tenant]" }], handlers: [] },
};
async function partition() {
  nextCache.cacheLife({ stale: 10, revalidate: 2, expire: 4 });
  const tenant = await getRootParam("tenant");
  nextCache.cacheTag("partition-" + tenant);
  await new Promise(resolve => setTimeout(resolve, 60));
  const value = (counts.get(tenant) ?? 0) + 1;
  counts.set(tenant, value);
  return { id: tenant, value };
}
let queue = Promise.resolve();
process.on("message", message => {
  if (handleCacheResponse(message) || message?.type !== "partition-probe") return;
  const run = async () => {
    try {
      const result = await withCacheMetrics(() => runWithNextCache(artifact,
        new URL("http://next.local/" + message.tenant), "/[tenant]", "render",
        async requestStore => {
          requestStore.rootParams = { tenant: message.tenant };
          return useCache("default", "partition-probe-id", 0, partition, []);
        }));
      process.send({ type: "partition-result", id: message.id, result });
    } catch (error) {
      process.send({ type: "partition-result", id: message.id, error: error.stack ?? String(error) });
    }
  };
  queue = queue.then(run, run);
});
