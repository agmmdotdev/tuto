/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { createHash, randomUUID } = require("node:crypto");
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
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
const cacheLifeProfiles = {
  ...defaultConfig.cacheLife,
  default: {
    ...defaultConfig.cacheLife.default,
    stale: defaultConfig.experimental.staleTimes.static,
  },
};

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

  async lock() {
    // The reusable RSC worker serializes requests, so there is no competing
    // fetch writer inside this checkpoint. A multi-worker host must move this
    // lock into the shared cache adapter.
    return async () => {};
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
const useCacheKey = (key) => `tuto-use-cache-v1:${key}`;
const tutoUseCacheHandler = {
  async get(key, softTags) {
    const pending = pendingUseCacheSets.get(key);
    if (pending) await pending;
    const result = await cacheOperation("get", {
      key: useCacheKey(key),
      revalidate: false,
      softTags,
      workspaceKey: currentWorkspaceKey(),
    });
    const stored = result.entry?.value;
    if (!stored || stored.kind !== "TUTO_USE_CACHE") {
      metric("misses");
      return undefined;
    }
    if (result.status === "stale") metric("staleHits");
    else metric("hits");
    return {
      ...stored.entry,
      revalidate: result.status === "stale" ? -1 : stored.entry.revalidate,
      value: base64ReadableStream(stored.entry.valueBase64),
    };
  },
  async set(key, pendingEntry) {
    const operation = (async () => {
      const entry = await pendingEntry;
      await cacheOperation("set", {
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
        workspaceKey: currentWorkspaceKey(),
      });
      metric("writes");
    })();
    pendingUseCacheSets.set(key, operation);
    try {
      await operation;
    } finally {
      pendingUseCacheSets.delete(key);
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
    value: await cacheMetricsStorage.run(metrics, callback),
  };
}

module.exports = {
  handleCacheResponse,
  nextCache,
  runWithNextCache,
  useCache,
  withCacheMetrics,
};
