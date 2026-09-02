/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { createHash, randomUUID } = require("node:crypto");
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
const nextCache = require("next/cache");
const {
  workAsyncStorage,
} = require("next/dist/server/app-render/work-async-storage.external");
const {
  workUnitAsyncStorage,
} = require("next/dist/server/app-render/work-unit-async-storage.external");
const { getImplicitTags } = require("next/dist/server/lib/implicit-tags");
const { executeRevalidates } = require("next/dist/server/revalidation-utils");
const { defaultConfig } = require("next/dist/server/config-shared");

const cacheRequests = new Map();
const cacheMetricsStorage = new AsyncLocalStorage();

function cacheOperation(operation, input) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    cacheRequests.set(requestId, { reject, resolve });
    process.send?.(
      { input, operation, requestId, type: "cache-request" },
      (error) => {
        if (!error) return;
        cacheRequests.delete(requestId);
        reject(error);
      },
    );
  });
}

function handleCacheResponse(message) {
  if (message?.type !== "cache-response") return false;
  const pending = cacheRequests.get(message.requestId);
  if (!pending) return true;
  cacheRequests.delete(message.requestId);
  if (message.ok) pending.resolve(message.value);
  else pending.reject(new Error(message.error ?? "Next cache adapter failed."));
  return true;
}

function metric(name, amount = 1) {
  const metrics = cacheMetricsStorage.getStore();
  if (metrics) metrics[name] += amount;
}

class TutoIncrementalCache {
  constructor(workspaceKey) {
    this.isOnDemandRevalidate = false;
    this.workspaceKey = workspaceKey;
  }

  async generateCacheKey(invocationKey) {
    return createHash("sha256")
      .update(`tuto-next-cache-v1\0${invocationKey}`)
      .digest("hex");
  }

  async get(key, context) {
    const result = await cacheOperation("get", {
      key,
      revalidate: context.revalidate,
      softTags: context.softTags,
      tags: context.tags,
      workspaceKey: this.workspaceKey,
    });
    if (!result.entry) {
      metric("misses");
      return null;
    }
    if (result.status === "stale") metric("staleHits");
    else metric("hits");
    return {
      isStale: result.status === "stale",
      value: result.entry.value,
    };
  }

  async set(key, value, context) {
    await cacheOperation("set", {
      key,
      tags: context.tags,
      value,
      workspaceKey: this.workspaceKey,
    });
    metric("writes");
  }

  async revalidateTag(tags, durations) {
    await cacheOperation("revalidateTags", {
      durations,
      tags,
      workspaceKey: this.workspaceKey,
    });
    metric("revalidations", tags.length);
  }
}

function routePage(routePattern) {
  if (!routePattern) return "/_not-found/page";
  return routePattern === "/" ? "/page" : `${routePattern}/page`;
}

async function createContext(artifact, requestUrl, routePattern, phase) {
  const page = routePage(routePattern);
  const implicitTags = await getImplicitTags(
    page,
    requestUrl.pathname,
    undefined,
  );
  const incrementalCache = new TutoIncrementalCache(artifact.workspaceKey);
  const workStore = {
    cacheComponentsEnabled: false,
    cacheLifeProfiles: defaultConfig.cacheLife,
    deploymentId: "tuto-request-runtime",
    fetchCache: undefined,
    incrementalCache,
    isDraftMode: false,
    isOnDemandRevalidate: false,
    isPrefetchRequest: false,
    isStaticGeneration: false,
    nextFetchId: 1,
    page,
    pendingRevalidatedTags: [],
    pendingRevalidates: {},
    pendingRevalidateWrites: [],
    route: routePattern ?? requestUrl.pathname,
  };
  const requestStore = {
    implicitTags,
    phase,
    type: "request",
    url: {
      pathname: requestUrl.pathname,
      search: requestUrl.search,
    },
  };
  return { requestStore, workStore };
}

async function runWithNextCache(
  artifact,
  requestUrl,
  routePattern,
  phase,
  callback,
) {
  const { requestStore, workStore } = await createContext(
    artifact,
    requestUrl,
    routePattern,
    phase,
  );
  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(requestStore, async () => {
      try {
        return await callback();
      } finally {
        await executeRevalidates(workStore);
      }
    }),
  );
}

async function withCacheMetrics(callback) {
  const metrics = {
    hits: 0,
    misses: 0,
    revalidations: 0,
    staleHits: 0,
    writes: 0,
  };
  return {
    metrics,
    value: await cacheMetricsStorage.run(metrics, callback),
  };
}

module.exports = {
  handleCacheResponse,
  nextCache,
  runWithNextCache,
  withCacheMetrics,
};
