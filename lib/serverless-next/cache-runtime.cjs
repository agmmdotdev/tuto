/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const { AsyncLocalStorage } = require("./secure-node-compat.cjs");
const { createHash, randomUUID } = require("node:crypto");
process.env.__NEXT_USE_CACHE ??= "true";
process.env.__NEXT_CACHE_COMPONENTS ??= "true";
const nextCache = require("next/cache");
const {
  workAsyncStorage,
} = require("next/dist/server/app-render/work-async-storage.external");
const {
  workUnitAsyncStorage,
} = require("next/dist/server/app-render/work-unit-async-storage.external");
const {
  setManifestsSingleton,
} = require("next/dist/server/app-render/manifests-singleton");
const {
  createWorkStore,
} = require("next/dist/server/async-storage/work-store");
const {
  createRequestStoreForAPI,
} = require("next/dist/server/async-storage/request-store");
const { NextRequest } = require("next/dist/server/web/spec-extension/request");
const { getImplicitTags } = require("next/dist/server/lib/implicit-tags");
const { patchFetch } = require("next/dist/server/lib/patch-fetch");
const { executeRevalidates } = require("next/dist/server/revalidation-utils");
const { defaultConfig } = require("next/dist/server/config-shared");
const {
  initializeCacheHandlers,
  setCacheHandler,
} = require("next/dist/server/use-cache/handlers");
const {
  cache: useCache,
} = require("next/dist/server/use-cache/use-cache-wrapper");

const cacheRequests = new Map();
const cacheMetricsStorage = new AsyncLocalStorage();
const secureCacheEndpoint =
  typeof globalThis.__TUTO_NEXT_CACHE_ENDPOINT__ === "string"
    ? globalThis.__TUTO_NEXT_CACHE_ENDPOINT__
    : null;
delete globalThis.__TUTO_NEXT_CACHE_ENDPOINT__;
const cacheLifeProfiles = {
  ...defaultConfig.cacheLife,
  default: {
    ...defaultConfig.cacheLife.default,
    stale: defaultConfig.experimental.staleTimes.static,
  },
};

function cacheOperation(operation, input) {
  if (secureCacheEndpoint) {
    return fetch(secureCacheEndpoint, {
      body: JSON.stringify({ input, operation }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? "Next cache adapter failed.");
      }
      return payload.value;
    });
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    if (!process.connected || typeof process.send !== "function") {
      reject(new Error("The Next cache runtime has no host cache bridge."));
      return;
    }
    cacheRequests.set(requestId, { reject, resolve });
    process.send(
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

async function fetchBodyCacheKey(init) {
  const method = init?.method?.toUpperCase() ?? "GET";
  if (method === "GET" || method === "HEAD" || !init?.body) return "";
  if (init instanceof Request) {
    return Buffer.from(await init.clone().arrayBuffer()).toString("base64");
  }
  const body = init.body;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("base64");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString(
      "base64",
    );
  }
  if (body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer()).toString("base64");
  }
  if (body instanceof FormData) {
    const parts = [];
    for (const [name, value] of body.entries()) {
      parts.push([
        name,
        typeof value === "string"
          ? value
          : {
              bytes: Buffer.from(await value.arrayBuffer()).toString("base64"),
              name: value.name,
              type: value.type,
            },
      ]);
    }
    return JSON.stringify(parts);
  }
  throw new Error("This request body cannot produce a stable fetch cache key.");
}

class TutoIncrementalCache {
  constructor(workspaceKey) {
    this.isOnDemandRevalidate = false;
    this.locks = new Map();
    this.workspaceKey = workspaceKey;
  }

  async generateCacheKey(invocationKey, init) {
    const headers = init?.headers
      ? [...new Headers(init.headers).entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        )
      : [];
    const body = await fetchBodyCacheKey(init);
    return createHash("sha256")
      .update(
        `tuto-next-cache-v2\0${invocationKey}\0${JSON.stringify([
          init?.method?.toUpperCase() ?? "GET",
          headers,
          body,
        ])}`,
      )
      .digest("hex");
  }

  async lock(key) {
    const context = {
      lock: null,
      pendingWrite: false,
      released: false,
      written: false,
    };
    this.locks.set(key, context);
    return async () => {
      try {
        context.released = true;
        if (context.lock) await cacheOperation("releaseLock", context.lock);
      } finally {
        if (!context.pendingWrite || context.written) this.locks.delete(key);
      }
    };
  }

  async get(key, context) {
    const input = {
      key,
      revalidate: context.revalidate,
      softTags: context.softTags,
      tags: context.tags,
      workspaceKey: this.workspaceKey,
    };
    let result = await cacheOperation("get", input);
    const lockContext = this.locks.get(key);
    if (
      lockContext &&
      (!result.entry || result.status === "stale") &&
      !lockContext.lock
    ) {
      lockContext.lock = await cacheOperation("acquireLock", {
        key,
        workspaceKey: this.workspaceKey,
      });
      result = await cacheOperation("get", input);
      lockContext.pendingWrite = !result.entry || result.status === "stale";
    }
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
    const lockContext = this.locks.get(key);
    try {
      await cacheOperation("set", {
        fence: lockContext?.lock?.fence,
        key,
        tags: context.tags,
        value,
        workspaceKey: this.workspaceKey,
      });
      metric("writes");
    } finally {
      if (lockContext) {
        lockContext.written = true;
        if (lockContext.released) this.locks.delete(key);
      }
    }
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

async function readableStreamBase64(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("base64");
}

function base64ReadableStream(value) {
  const bytes = Buffer.from(value, "base64");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function currentWorkspaceKey() {
  const workStore = workAsyncStorage.getStore();
  const workspaceKey = workStore?.incrementalCache?.workspaceKey;
  if (!workspaceKey) {
    throw new Error('The Tuto "use cache" handler requires a workspace.');
  }
  return workspaceKey;
}

const pendingUseCacheSets = new Map();
const pendingUseCacheLocks = new Map();
const useCacheKey = (key) => `tuto-use-cache-v1:${key}`;
const useCacheOperationKey = (workspaceKey, key) => `${workspaceKey}\0${key}`;
async function releaseUseCacheLock(operationKey) {
  const lock = pendingUseCacheLocks.get(operationKey);
  if (!lock) return;
  pendingUseCacheLocks.delete(operationKey);
  await cacheOperation("releaseLock", lock);
}
const tutoUseCacheHandler = {
  async get(key, softTags) {
    const workspaceKey = currentWorkspaceKey();
    const operationKey = useCacheOperationKey(workspaceKey, key);
    const pending = pendingUseCacheSets.get(operationKey);
    if (pending) await pending;
    try {
      const input = {
        key: useCacheKey(key),
        revalidate: false,
        softTags,
        workspaceKey,
      };
      let result = await cacheOperation("get", input);
      if (!result.entry || result.status === "stale") {
        const lock = await cacheOperation("acquireLock", {
          key: input.key,
          workspaceKey,
        });
        pendingUseCacheLocks.set(operationKey, lock);
        result = await cacheOperation("get", input);
      }
      const stored = result.entry?.value;
      if (!stored || stored.kind !== "TUTO_USE_CACHE") {
        metric("misses");
        return undefined;
      }
      if (result.status === "stale") {
        metric("staleHits");
      } else {
        metric("hits");
      }
      if (result.status !== "stale") await releaseUseCacheLock(operationKey);
      return {
        ...stored.entry,
        revalidate: result.status === "stale" ? -1 : stored.entry.revalidate,
        value: base64ReadableStream(stored.entry.valueBase64),
      };
    } catch (error) {
      await releaseUseCacheLock(operationKey);
      throw error;
    }
  },
  async set(key, pendingEntry) {
    const workspaceKey = currentWorkspaceKey();
    const operationKey = useCacheOperationKey(workspaceKey, key);
    const operation = (async () => {
      const entry = await pendingEntry;
      await cacheOperation("set", {
        fence: pendingUseCacheLocks.get(operationKey)?.fence,
        key: useCacheKey(key),
        tags: entry.tags,
        value: {
          entry: {
            expire: entry.expire,
            revalidate: entry.revalidate,
            stale: entry.stale,
            tags: entry.tags,
            timestamp: entry.timestamp,
            valueBase64: await readableStreamBase64(entry.value),
          },
          kind: "TUTO_USE_CACHE",
        },
        workspaceKey,
      });
      metric("writes");
    })();
    pendingUseCacheSets.set(operationKey, operation);
    try {
      await operation;
    } finally {
      pendingUseCacheSets.delete(operationKey);
      await releaseUseCacheLock(operationKey);
    }
  },
  async refreshTags() {},
  async getExpiration() {
    // Soft tags are checked by get() through the host adapter.
    return Infinity;
  },
  async updateTags() {
    // executeRevalidates also updates TutoIncrementalCache. Both cache kinds
    // share the same host tag state, so a second write would be redundant.
  },
};

initializeCacheHandlers(0);
setCacheHandler("default", tutoUseCacheHandler);
patchFetch({ workAsyncStorage, workUnitAsyncStorage });
const patchedFetch = globalThis.__TUTO_NEXT_PATCHED_FETCH__ ?? globalThis.fetch;
delete globalThis.__TUTO_NEXT_PATCHED_FETCH__;
delete globalThis.__TUTO_NEXT_ORIGIN_FETCH__;

function routePage(routePattern, routeKind = "page") {
  if (!routePattern) return `/_not-found/${routeKind}`;
  return routePattern === "/"
    ? `/${routeKind}`
    : `${routePattern}/${routeKind}`;
}

function registerManifests(artifact, page) {
  const rscModuleMapping = Object.fromEntries(
    Object.values(artifact.clientModules).map((module) => [
      module.id,
      {
        "*": {
          async: false,
          chunks: [],
          id: module.path,
          name: "*",
        },
      },
    ]),
  );
  const workerPages = Object.fromEntries(
    [
      ...artifact.router.routes.map(
        (route) => `app${routePage(route.pattern)}`,
      ),
      ...artifact.router.handlers.map(
        (route) => `app${routePage(route.pattern, "route")}`,
      ),
    ].map((workerPage) => [workerPage, true]),
  );
  const node = Object.fromEntries(
    Object.entries(artifact.actionManifest).map(([id, reference]) => [
      id,
      {
        workers: Object.fromEntries(
          Object.keys(workerPages).map((workerPage) => [
            workerPage,
            {
              async: false,
              moduleId: reference.modulePath,
            },
          ]),
        ),
      },
    ]),
  );
  setManifestsSingleton({
    page,
    clientReferenceManifest: {
      clientModules: artifact.clientReferenceManifest,
      edgeRscModuleMapping: rscModuleMapping,
      edgeSSRModuleMapping: rscModuleMapping,
      entryCSSFiles: {},
      entryJSFiles: {},
      moduleLoading: null,
      rscModuleMapping,
      ssrModuleMapping: rscModuleMapping,
    },
    serverActionsManifest: {
      edge: {},
      encryptionKey: "tuto-request-runtime",
      node,
    },
  });
}

async function createContext(
  artifact,
  requestUrl,
  routePattern,
  phase,
  request,
  routeKind,
) {
  const page = routePage(routePattern, routeKind);
  registerManifests(artifact, page);
  const implicitTags = await getImplicitTags(
    page,
    requestUrl.pathname,
    undefined,
  );
  const incrementalCache = new TutoIncrementalCache(artifact.workspaceKey);
  const workStore = createWorkStore({
    buildId: artifact.generation,
    deploymentId: artifact.generation,
    isPrefetchRequest: false,
    page,
    previouslyRevalidatedTags: [],
    renderOpts: {
      cacheComponents: true,
      cacheLifeProfiles,
      experimental: {
        authInterrupts: false,
        isRoutePPREnabled: false,
      },
      incrementalCache,
      isBuildTimePrerendering: false,
      isDebugDynamicAccesses: false,
      isDraftMode: false,
      isOnDemandRevalidate: false,
      onAfterTaskError() {},
      onClose() {},
      shouldWaitOnAllReady: false,
      supportsDynamicResponse: true,
      waitUntil() {},
    },
  });
  workStore.nextFetchId = 1;
  workStore.pendingRevalidatedTags = [];
  workStore.pendingRevalidates = {};
  workStore.pendingRevalidateWrites = [];
  workStore.route = routePattern ?? requestUrl.pathname;
  const nextRequest = request ?? new NextRequest(requestUrl);
  const requestStore = createRequestStoreForAPI(
    nextRequest,
    requestUrl,
    implicitTags,
    undefined,
    undefined,
  );
  requestStore.phase = phase;
  return { requestStore, workStore };
}

async function runWithNextCache(
  artifact,
  requestUrl,
  routePattern,
  phase,
  callback,
  request,
  routeKind = "page",
) {
  const { requestStore, workStore } = await createContext(
    artifact,
    requestUrl,
    routePattern,
    phase,
    request,
    routeKind,
  );
  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(requestStore, async () => {
      try {
        return await callback(requestStore);
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
    value: await cacheMetricsStorage.run(metrics, () => callback(metrics)),
  };
}

module.exports = {
  handleCacheResponse,
  nextCache,
  patchedFetch,
  runWithNextCache,
  useCache,
  withCacheMetrics,
};
