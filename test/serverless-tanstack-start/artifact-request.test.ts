import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "vitest";
import {
  clearTanstackStartArtifactCache,
  putTanstackStartArtifact,
  type TanstackStartArtifact,
} from "../../lib/serverless-tanstack-start/artifact-cache";
import {
  resolveArtifactAssetRequest,
  resolveArtifactDocumentRequest,
  resolveArtifactServerRequest,
} from "../../lib/serverless-tanstack-start/artifact-request";
import {
  getTanstackStartArtifactMetadata,
  setTanstackStartArtifactStoreForTests,
} from "../../lib/serverless-tanstack-start/artifact-store";
import { resolveIncrementalStaticRegeneration } from "../../lib/serverless-tanstack-start/isr-runtime";
import kernelManifest from "../../lib/serverless-tanstack-start/kernel-manifest.generated.json";

const revision = "6".repeat(64);
const token = "t".repeat(43);
const artifact: TanstackStartArtifact = {
  buildMetrics: {
    clientFrameworkInputs: 0,
    clientRevisionBytes: 1,
    serverFrameworkInputs: 0,
    serverRevisionBytes: 1,
    sharedClientKernelBytes: kernelManifest.client.bytes,
    sharedServerKernelBytes: kernelManifest.server.bytes,
  },
  diagnostics: [],
  durationMs: 1,
  html: "",
  kernelId: kernelManifest.id,
  prerendered: {
    documents: {
      "/_shell.html": "<!doctype html><p>shell document</p>",
      "/about/index.html": "<!doctype html><p>about document</p>",
    },
    isr: {
      "/about/index.html": {
        cacheControl: "public, s-maxage=60, stale-while-revalidate=300",
        generatedAt: 1_000,
        maxRedirects: 5,
        requestHeaders: {},
        revalidateSeconds: 60,
        routePath: "/about",
        staticServerFunctionPaths: [],
        staleWhileRevalidateSeconds: 300,
      },
    },
    routes: { "/about": "/about/index.html" },
    shell: "/_shell.html",
  },
  revision,
  routeManifest: {},
  rpcToken: token,
  serverBundle: "",
  serverChunks: {},
  serverFnIds: [],
  staticServerFunctions: {
    [`/__tsr/staticServerFnCache/${"a".repeat(40)}.json`]:
      '{"static":"result"}',
  },
  ssrClientBundle: "client source",
  ssrClientChunks: {},
  ssrCss: "",
  ssrCssChunks: {},
  success: true,
};

afterEach(() => {
  clearTanstackStartArtifactCache();
  setTanstackStartArtifactStoreForTests(undefined);
});

test("rejects an invalid capability before reading an artifact source blob", async () => {
  let assetReads = 0;
  let metadataReads = 0;
  setTanstackStartArtifactStoreForTests({
    async get() {
      throw new Error("full artifact should not be read");
    },
    async getAsset() {
      assetReads += 1;
      return {
        artifact: getTanstackStartArtifactMetadata(artifact),
        body: artifact.ssrClientBundle,
      };
    },
    async getMetadata() {
      metadataReads += 1;
      return getTanstackStartArtifactMetadata(artifact);
    },
    async put() {},
  });

  const denied = await resolveArtifactAssetRequest(
    new Request(
      `http://tuto.local/asset?revision=${revision}&token=${"x".repeat(43)}`,
    ),
    { kind: "client" },
  );
  assert.deepEqual(denied, {
    message: "Invalid preview RPC capability.",
    ok: false,
    status: 403,
  });
  assert.equal(metadataReads, 1);
  assert.equal(assetReads, 0);

  const allowed = await resolveArtifactAssetRequest(
    new Request(`http://tuto.local/asset?revision=${revision}&token=${token}`),
    { kind: "client" },
  );
  assert.equal(allowed.ok && allowed.body, artifact.ssrClientBundle);
  assert.equal(metadataReads, 2);
  assert.equal(assetReads, 1);
});

test("fails closed when the artifact identity changes after authorization", async () => {
  setTanstackStartArtifactStoreForTests({
    async get() {
      throw new Error("full artifact should not be read");
    },
    async getAsset() {
      return {
        artifact: {
          ...getTanstackStartArtifactMetadata(artifact),
          rpcToken: "z".repeat(43),
        },
        body: artifact.ssrClientBundle,
      };
    },
    async getMetadata() {
      return getTanstackStartArtifactMetadata(artifact);
    },
    async put() {},
  });

  assert.deepEqual(
    await resolveArtifactAssetRequest(
      new Request(`http://tuto.local/asset?revision=${revision}&token=${token}`),
      { kind: "client" },
    ),
    {
      message:
        "Shared artifact storage is unavailable: Stored TanStack artifact changed during request authorization.",
      ok: false,
      status: 503,
    },
  );
});

test("rejects an invalid capability before reading a static server-function blob", async () => {
  let assetReads = 0;
  const cachePath = `/__tsr/staticServerFnCache/${"a".repeat(40)}.json`;
  setTanstackStartArtifactStoreForTests({
    async get() {
      throw new Error("full artifact should not be read");
    },
    async getAsset() {
      assetReads += 1;
      return {
        artifact: getTanstackStartArtifactMetadata(artifact),
        body: artifact.staticServerFunctions?.[cachePath] ?? null,
      };
    },
    async getMetadata() {
      return getTanstackStartArtifactMetadata(artifact);
    },
    async put() {},
  });

  const denied = await resolveArtifactAssetRequest(
    new Request(
      `http://tuto.local/asset?revision=${revision}&token=${"x".repeat(43)}`,
    ),
    { kind: "static-server-function", name: cachePath },
  );
  assert.equal(denied.ok, false);
  assert.equal(assetReads, 0);

  const allowed = await resolveArtifactAssetRequest(
    new Request(`http://tuto.local/asset?revision=${revision}&token=${token}`),
    { kind: "static-server-function", name: cachePath },
  );
  assert.equal(allowed.ok && allowed.body, '{"static":"result"}');
  assert.equal(assetReads, 1);
});

test("resolves a deferred server runtime without invoking its source loaders", async () => {
  let sourceLoads = 0;
  const metadata = getTanstackStartArtifactMetadata(artifact);
  setTanstackStartArtifactStoreForTests({
    async get() {
      throw new Error("full artifact should not be read");
    },
    async getMetadata() {
      return metadata;
    },
    async getServerRuntime() {
      return {
        ...metadata,
        runtime: {
          kernelId: artifact.kernelId,
          revision: artifact.revision,
          serverBundle: "",
          serverChunks: {},
          serverSources: {
            chunks: {},
            entry: {
              bytes: Buffer.byteLength(artifact.serverBundle),
              hash: createHash("sha256")
                .update(artifact.serverBundle)
                .digest("hex"),
              async load() {
                sourceLoads += 1;
                return artifact.serverBundle;
              },
            },
          },
        },
      };
    },
    async put() {},
  });

  const resolution = await resolveArtifactServerRequest(
    new Request(`http://tuto.local/rpc?revision=${revision}&token=${token}`),
  );
  assert.equal(resolution.ok, true);
  assert.equal(sourceLoads, 0);
  assert.ok(resolution.ok && resolution.runtime.serverSources);
});

test("serves exact prerendered routes before the SPA shell from a hot revision", async () => {
  putTanstackStartArtifact(artifact);

  const exact = await resolveArtifactDocumentRequest(
    new Request(`http://tuto.local/render?revision=${revision}&token=${token}`),
    "/about",
  );
  assert.deepEqual(exact, {
    artifact: getTanstackStartArtifactMetadata(artifact),
    artifactCache: "hot",
    body: artifact.prerendered?.documents["/about/index.html"],
    kind: "route",
    ok: true,
    outputPath: "/about/index.html",
  });

  const fallback = await resolveArtifactDocumentRequest(
    new Request(`http://tuto.local/render?revision=${revision}&token=${token}`),
    "/unmatched?tab=one",
  );
  assert.deepEqual(fallback, {
    artifact: getTanstackStartArtifactMetadata(artifact),
    artifactCache: "hot",
    body: artifact.prerendered?.documents["/_shell.html"],
    kind: "shell",
    ok: true,
    outputPath: "/_shell.html",
  });
});

test("serves an ISR document stale while scheduling one background regeneration", async () => {
  putTanstackStartArtifact(artifact);
  const request = new Request(
    `http://tuto.local/render?revision=${revision}&token=${token}`,
  );
  const selected = await resolveArtifactDocumentRequest(request, "/about");
  assert.equal(selected.ok, true);
  if (
    !selected.ok ||
    selected.body === null ||
    selected.kind !== "route" ||
    selected.outputPath === null
  ) {
    throw new Error("Expected an exact prerendered route.");
  }
  let scheduled = 0;
  const resolved = await resolveIncrementalStaticRegeneration(
    request,
    {
      ...selected,
      body: selected.body,
      kind: "route",
      outputPath: selected.outputPath,
    },
    {
      now: 62_000,
      schedule() {
        scheduled += 1;
      },
    },
  );
  assert.deepEqual(resolved, {
    body: "<!doctype html><p>about document</p>",
    cacheControl: "private, no-store",
    generatedAt: 1_000,
    status: "stale",
  });
  assert.equal(scheduled, 1);
});

test("authorizes before selectively reading a durable prerendered document", async () => {
  let documentReads = 0;
  setTanstackStartArtifactStoreForTests({
    async get() {
      throw new Error("full artifact should not be read");
    },
    async getMetadata() {
      return getTanstackStartArtifactMetadata(artifact);
    },
    async getPrerenderedDocument(_revision, outputPath) {
      documentReads += 1;
      return {
        artifact: getTanstackStartArtifactMetadata(artifact),
        body: artifact.prerendered?.documents[outputPath] ?? null,
      };
    },
    async put() {},
  });

  const denied = await resolveArtifactDocumentRequest(
    new Request(
      `http://tuto.local/render?revision=${revision}&token=${"x".repeat(43)}`,
    ),
    "/about",
  );
  assert.equal(denied.ok, false);
  assert.equal(documentReads, 0);

  const allowed = await resolveArtifactDocumentRequest(
    new Request(`http://tuto.local/render?revision=${revision}&token=${token}`),
    "/about",
  );
  assert.equal(allowed.ok && allowed.body, "<!doctype html><p>about document</p>");
  assert.equal(documentReads, 1);
});
