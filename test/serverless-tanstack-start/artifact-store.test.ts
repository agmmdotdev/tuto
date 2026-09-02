import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import type { TanstackStartArtifact } from "../../lib/serverless-tanstack-start/artifact-cache";
import {
  type ArtifactBlobStore,
  createFilesystemTanstackStartArtifactStore,
  createTanstackStartArtifactStore,
  getTanstackStartArtifactMetadata,
  setTanstackStartArtifactStoreForTests,
} from "../../lib/serverless-tanstack-start/artifact-store";
import kernelManifest from "../../lib/serverless-tanstack-start/kernel-manifest.generated.json";
import { ServerRuntimeStore } from "../../lib/serverless-tanstack-start/server-runtime-store";

const temporaryRoots: string[] = [];

function artifact(revision: string): TanstackStartArtifact {
  return {
    buildMetrics: {
      clientFrameworkInputs: 0,
      clientRevisionBytes: 10,
      serverFrameworkInputs: 0,
      serverRevisionBytes: 10,
      sharedClientKernelBytes: kernelManifest.client.bytes,
      sharedServerKernelBytes: kernelManifest.server.bytes,
    },
    diagnostics: [],
    deploymentManifest: {
      assets: {
        "/_shell.html": {
          contentType: "text/html; charset=utf-8",
          kind: "document",
        },
        "/about/index.html": {
          contentType: "text/html; charset=utf-8",
          kind: "document",
        },
        [`/__tsr/staticServerFnCache/${"a".repeat(40)}.json`]: {
          contentType: "application/json; charset=utf-8",
          kind: "static-server-function",
        },
      },
      routes: { "/about": { outputPath: "/about/index.html" } },
      spaFallback: { outputPath: "/_shell.html" },
      version: 1,
    },
    durationMs: 1,
    html: "<p>durable</p>",
    kernelId: kernelManifest.id,
    prerendered: {
      documents: {
        "/_shell.html": "<!doctype html><p>shell</p>",
        "/about/index.html": "<!doctype html><p>static about</p>",
      },
      isr: {
        "/about/index.html": {
          cacheControl: "public, s-maxage=60, stale-while-revalidate=300",
          generatedAt: 1_700_000_000_000,
          maxRedirects: 5,
          requestHeaders: { "x-prerender": "true" },
          revalidateSeconds: 60,
          routePath: "/about",
          staticServerFunctionPaths: [
            `/__tsr/staticServerFnCache/${"a".repeat(40)}.json`,
          ],
          staleWhileRevalidateSeconds: 300,
        },
      },
      routes: {
        "/about": "/about/index.html",
      },
      shell: "/_shell.html",
    },
    revision,
    routeManifest: {
      "/hello": {
        css: ["/api/start/styles/hello"],
        preloads: ["/api/start/chunks/hello"],
      },
    },
    rpcToken: "t".repeat(43),
    ssrClientBundle: "",
    ssrClientChunks: {
      "chunks/hello-ABC123.js": "export const hello = true;",
    },
    ssrCss: "",
    ssrCssChunks: {
      "chunks/chunk-CSS123.css": ".hello { color: green; }",
    },
    serverBundle: "export const durable = true;",
    serverChunks: {
      "chunks/chunk-SERVER123.js": "export const route = true;",
    },
    serverFnIds: ["server-fn"],
    staticServerFunctions: {
      [`/__tsr/staticServerFnCache/${"a".repeat(40)}.json`]:
        '{"static":"result"}',
    },
    success: true,
  };
}

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "tuto-artifact-store-test-"));
  temporaryRoots.push(root);
  return root;
}

function artifactRoot(root: string) {
  return path.join(root, "tanstack-start", "artifacts", kernelManifest.id);
}

function manifestPath(root: string, revision: string) {
  return path.join(artifactRoot(root), `${revision}.json`);
}

function memoryBlobStore() {
  const objects = new Map<string, string>();
  const reads: string[] = [];
  const streamReads: string[] = [];
  const writes: string[] = [];
  const store: ArtifactBlobStore = {
    async delete(key) {
      objects.delete(key);
    },
    async get(key) {
      reads.push(key);
      return objects.get(key) ?? null;
    },
    async getStream(key) {
      streamReads.push(key);
      const source = objects.get(key);
      if (source === undefined) return null;
      return (async function* () {
        const bytes = Buffer.from(source);
        const midpoint = Math.ceil(bytes.byteLength / 2);
        yield bytes.subarray(0, midpoint);
        yield bytes.subarray(midpoint);
      })();
    },
    async put(key, value) {
      writes.push(key);
      objects.set(key, value);
    },
  };
  return { objects, reads, store, streamReads, writes };
}

afterEach(async () => {
  setTanstackStartArtifactStoreForTests(undefined);
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

test("filesystem artifacts survive store instances and validate integrity", async () => {
  const root = await temporaryRoot();
  const revision = "a".repeat(64);
  const writer = createFilesystemTanstackStartArtifactStore({
    root,
    signingKey: "correct-key",
  });
  await writer.put(artifact(revision));

  const reader = createFilesystemTanstackStartArtifactStore({
    root,
    signingKey: "correct-key",
  });
  assert.deepEqual(await reader.get(revision), artifact(revision));

  const wrongKeyReader = createFilesystemTanstackStartArtifactStore({
    root,
    signingKey: "wrong-key",
  });
  await assert.rejects(
    wrongKeyReader.get(revision),
    /failed integrity validation/i,
  );
});

test("writes signed v4 manifests and deduplicates blobs across revisions", async () => {
  const root = await temporaryRoot();
  const firstRevision = "c".repeat(64);
  const secondRevision = "d".repeat(64);
  const store = createFilesystemTanstackStartArtifactStore({
    root,
    signingKey: "manifest-key",
  });

  await store.put(artifact(firstRevision));
  await store.put(artifact(secondRevision));

  const serialized = await readFile(manifestPath(root, firstRevision), "utf8");
  const envelope = JSON.parse(serialized) as {
    artifact: { sources: { serverBundle: { hash: string } } };
    integrity: string;
    version: number;
  };
  assert.equal(envelope.version, 4);
  assert.match(envelope.integrity, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(serialized, /export const durable/);
  assert.match(envelope.artifact.sources.serverBundle.hash, /^[a-f0-9]{64}$/);
  assert.equal(
    (await readdir(path.join(artifactRoot(root), "blobs"))).length,
    9,
  );
});

test("reads existing signed v3 monolithic artifacts during migration", async () => {
  const root = await temporaryRoot();
  const revision = "e".repeat(64);
  const signingKey = "legacy-key";
  const payload = {
    artifact: artifact(revision),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    version: 3 as const,
  };
  const target = manifestPath(root, revision);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    JSON.stringify({
      ...payload,
      integrity: createHmac("sha256", signingKey)
        .update(JSON.stringify(payload))
        .digest("hex"),
    }),
    "utf8",
  );

  const store = createFilesystemTanstackStartArtifactStore({
    root,
    signingKey,
  });
  assert.deepEqual(await store.get(revision), artifact(revision));
  assert.equal(
    (
      await store.getAsset!(revision, {
        kind: "client-chunk",
        name: "chunks/hello-ABC123.js",
      })
    )?.body,
    artifact(revision).ssrClientChunks["chunks/hello-ABC123.js"],
  );
  assert.deepEqual(await store.getServer!(revision), {
    ...getTanstackStartArtifactMetadata(artifact(revision)),
    serverBundle: artifact(revision).serverBundle,
    serverChunks: artifact(revision).serverChunks,
  });
  assert.deepEqual(await store.getServerRuntime!(revision), {
    ...getTanstackStartArtifactMetadata(artifact(revision)),
    runtime: {
      kernelId: artifact(revision).kernelId,
      revision,
      serverBundle: artifact(revision).serverBundle,
      serverChunks: artifact(revision).serverChunks,
    },
  });
});

test("fetches only absent verified blobs after a cold manifest read", async () => {
  const revision = "f".repeat(64);
  const backend = memoryBlobStore();
  const writer = createTanstackStartArtifactStore({
    blobStore: backend.store,
    signingKey: "cache-key",
  });
  await writer.put(artifact(revision));
  const reader = createTanstackStartArtifactStore({
    blobStore: backend.store,
    signingKey: "cache-key",
  });

  backend.reads.length = 0;
  assert.deepEqual(await reader.get(revision), artifact(revision));
  assert.equal(backend.reads.filter((key) => key.endsWith(".blob")).length, 9);

  backend.reads.length = 0;
  assert.deepEqual(await reader.get(revision), artifact(revision));
  assert.equal(backend.reads.length, 0);
});

test("selectively reads metadata, one asset, and server runtime blobs", async () => {
  const revision = "5".repeat(64);
  const backend = memoryBlobStore();
  const writer = createTanstackStartArtifactStore({
    blobStore: backend.store,
    signingKey: "selective-key",
  });
  await writer.put(artifact(revision));
  const reader = createTanstackStartArtifactStore({
    blobStore: backend.store,
    signingKey: "selective-key",
  });

  backend.reads.length = 0;
  const metadata = await reader.getMetadata!(revision);
  assert.equal(metadata?.rpcToken, artifact(revision).rpcToken);
  assert.deepEqual(metadata?.prerendered, {
    isr: artifact(revision).prerendered?.isr,
    routes: { "/about": "/about/index.html" },
    shell: "/_shell.html",
  });
  assert.deepEqual(
    metadata?.deploymentManifest,
    artifact(revision).deploymentManifest,
  );
  assert.deepEqual(
    backend.reads.map((key) => path.posix.basename(key)),
    [`${revision}.json`],
  );

  backend.reads.length = 0;
  const selected = await reader.getAsset!(revision, {
    kind: "client-chunk",
    name: "chunks/hello-ABC123.js",
  });
  assert.equal(
    selected?.body,
    artifact(revision).ssrClientChunks["chunks/hello-ABC123.js"],
  );
  assert.equal(backend.reads.length, 1);
  assert.match(backend.reads[0]!, /\.blob$/);

  backend.reads.length = 0;
  const document = await reader.getPrerenderedDocument!(
    revision,
    "/about/index.html",
  );
  assert.equal(
    document?.body,
    artifact(revision).prerendered?.documents["/about/index.html"],
  );
  assert.equal(backend.reads.length, 1);
  assert.match(backend.reads[0]!, /\.blob$/);

  backend.reads.length = 0;
  const staticResult = await reader.getAsset!(revision, {
    kind: "static-server-function",
    name: `/__tsr/staticServerFnCache/${"a".repeat(40)}.json`,
  });
  assert.equal(staticResult?.body, '{"static":"result"}');
  assert.equal(backend.reads.length, 1);
  assert.match(backend.reads[0]!, /\.blob$/);

  backend.reads.length = 0;
  const deploymentManifest = await reader.getAsset!(revision, {
    kind: "deployment-manifest",
  });
  assert.deepEqual(
    JSON.parse(deploymentManifest?.body ?? "null"),
    artifact(revision).deploymentManifest,
  );
  assert.equal(backend.reads.length, 0);

  backend.reads.length = 0;
  await reader.getAsset!(revision, {
    kind: "client-chunk",
    name: "chunks/hello-ABC123.js",
  });
  assert.equal(backend.reads.length, 0);

  backend.reads.length = 0;
  const server = await reader.getServer!(revision);
  assert.equal(server?.serverBundle, artifact(revision).serverBundle);
  assert.deepEqual(server?.serverChunks, artifact(revision).serverChunks);
  assert.equal(backend.reads.length, 2);
  assert.ok(backend.reads.every((key) => key.endsWith(".blob")));

  backend.reads.length = 0;
  assert.equal(
    (await reader.getSummary!(revision))?.html,
    artifact(revision).html,
  );
  assert.equal(backend.reads.length, 1);
});

test("hands server descriptors to the runtime without eager blob reads", async () => {
  const revision = "8".repeat(64);
  const backend = memoryBlobStore();
  const writer = createTanstackStartArtifactStore({
    blobStore: backend.store,
    signingKey: "runtime-handoff-key",
  });
  await writer.put(artifact(revision));
  const reader = createTanstackStartArtifactStore({
    blobStore: backend.store,
    signingKey: "runtime-handoff-key",
  });

  backend.reads.length = 0;
  const selected = await reader.getServerRuntime!(revision);
  assert.ok(selected?.runtime.serverSources);
  assert.deepEqual(
    backend.reads.map((key) => path.posix.basename(key)),
    [`${revision}.json`],
  );

  backend.reads.length = 0;
  assert.equal(
    await selected.runtime.serverSources.entry.load!(),
    artifact(revision).serverBundle,
  );
  assert.equal(backend.reads.length, 1);

  const [[chunkName, chunk]] = Object.entries(
    selected.runtime.serverSources.chunks,
  );
  assert.equal(await chunk.load!(), artifact(revision).serverChunks[chunkName]);
  assert.equal(backend.reads.length, 2);
});

test("streams server blobs into the runtime CAS without string reads", async () => {
  const revision = "9".repeat(64);
  const backend = memoryBlobStore();
  const writer = createTanstackStartArtifactStore({
    blobStore: backend.store,
    signingKey: "streaming-handoff-key",
  });
  await writer.put(artifact(revision));
  const reader = createTanstackStartArtifactStore({
    blobStore: backend.store,
    signingKey: "streaming-handoff-key",
  });
  const runtimeRoot = await temporaryRoot();
  const runtimeStore = new ServerRuntimeStore({ root: runtimeRoot });
  const selected = await reader.getServerRuntime!(revision);
  assert.ok(selected);

  backend.reads.length = 0;
  backend.streamReads.length = 0;
  const first = await runtimeStore.acquire(selected.runtime);
  assert.equal(
    await readFile(first.entryPath, "utf8"),
    artifact(revision).serverBundle,
  );
  assert.equal(backend.reads.length, 0);
  assert.equal(backend.streamReads.length, 2);
  assert.ok(backend.streamReads.every((key) => key.endsWith(".blob")));
  await first.release();

  const coldReader = createTanstackStartArtifactStore({
    blobStore: backend.store,
    signingKey: "streaming-handoff-key",
  });
  const repeated = await coldReader.getServerRuntime!(revision);
  assert.ok(repeated);
  backend.reads.length = 0;
  backend.streamReads.length = 0;
  const second = await new ServerRuntimeStore({ root: runtimeRoot }).acquire(
    repeated.runtime,
  );
  assert.equal(second.entryPath, first.entryPath);
  assert.equal(backend.reads.length, 0);
  assert.equal(backend.streamReads.length, 0);
  await second.release();
});

test("publishes the manifest only after every content blob", async () => {
  const revision = "1".repeat(64);
  const backend = memoryBlobStore();
  const store = createTanstackStartArtifactStore({
    blobConcurrency: 2,
    blobStore: backend.store,
    signingKey: "ordering-key",
  });

  await store.put(artifact(revision));
  assert.ok(backend.writes.slice(0, -1).every((key) => key.endsWith(".blob")));
  assert.equal(path.posix.basename(backend.writes.at(-1)!), `${revision}.json`);
});

test("does not publish a manifest after a partial blob-write failure", async () => {
  const revision = "4".repeat(64);
  const backend = memoryBlobStore();
  let blobWrites = 0;
  const failingStore: ArtifactBlobStore = {
    ...backend.store,
    async put(key, value, contentType) {
      if (key.endsWith(".blob") && ++blobWrites === 2) {
        throw new Error("simulated blob outage");
      }
      await backend.store.put(key, value, contentType);
    },
  };
  const store = createTanstackStartArtifactStore({
    blobConcurrency: 1,
    blobStore: failingStore,
    signingKey: "partial-write-key",
  });

  await assert.rejects(store.put(artifact(revision)), /simulated blob outage/);
  assert.equal(
    [...backend.objects.keys()].some((key) => key.endsWith(`${revision}.json`)),
    false,
  );
});

test("rejects a corrupt content-addressed artifact blob", async () => {
  const root = await temporaryRoot();
  const revision = "2".repeat(64);
  const writer = createFilesystemTanstackStartArtifactStore({
    root,
    signingKey: "blob-integrity-key",
  });
  await writer.put(artifact(revision));
  const envelope = JSON.parse(
    await readFile(manifestPath(root, revision), "utf8"),
  ) as {
    artifact: { sources: { serverBundle: { hash: string } } };
  };
  await writeFile(
    path.join(
      artifactRoot(root),
      "blobs",
      `${envelope.artifact.sources.serverBundle.hash}.blob`,
    ),
    "corrupt",
    "utf8",
  );

  const reader = createFilesystemTanstackStartArtifactStore({
    root,
    signingKey: "blob-integrity-key",
  });
  await assert.rejects(reader.get(revision), /blob .* failed integrity/i);
});

test("expired durable artifacts are treated as misses", async () => {
  const root = await temporaryRoot();
  const revision = "b".repeat(64);
  const retainedRevision = "3".repeat(64);
  const store = createFilesystemTanstackStartArtifactStore({
    root,
    signingKey: "expiry-key",
    ttlMs: 1,
  });
  await store.put(artifact(revision));
  const retainedStore = createFilesystemTanstackStartArtifactStore({
    root,
    signingKey: "expiry-key",
    ttlMs: 60_000,
  });
  await retainedStore.put(artifact(retainedRevision));
  const blobsBeforeExpiry = await readdir(
    path.join(artifactRoot(root), "blobs"),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await store.get(revision), null);
  assert.equal(
    await readFile(manifestPath(root, revision), "utf8").catch(() => null),
    null,
  );
  assert.deepEqual(
    await readdir(path.join(artifactRoot(root), "blobs")),
    blobsBeforeExpiry,
  );
  assert.deepEqual(
    await retainedStore.get(retainedRevision),
    artifact(retainedRevision),
  );
});
