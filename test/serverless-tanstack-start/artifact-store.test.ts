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
  setTanstackStartArtifactStoreForTests,
} from "../../lib/serverless-tanstack-start/artifact-store";
import kernelManifest from "../../lib/serverless-tanstack-start/kernel-manifest.generated.json";

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
    durationMs: 1,
    html: "<p>durable</p>",
    kernelId: kernelManifest.id,
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
    success: true,
  };
}

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "tuto-artifact-store-test-"));
  temporaryRoots.push(root);
  return root;
}

function artifactRoot(root: string) {
  return path.join(
    root,
    "tanstack-start",
    "artifacts",
    kernelManifest.id,
  );
}

function manifestPath(root: string, revision: string) {
  return path.join(artifactRoot(root), `${revision}.json`);
}

function memoryBlobStore() {
  const objects = new Map<string, string>();
  const reads: string[] = [];
  const writes: string[] = [];
  const store: ArtifactBlobStore = {
    async delete(key) {
      objects.delete(key);
    },
    async get(key) {
      reads.push(key);
      return objects.get(key) ?? null;
    },
    async put(key, value) {
      writes.push(key);
      objects.set(key, value);
    },
  };
  return { objects, reads, store, writes };
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
    6,
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

  const store = createFilesystemTanstackStartArtifactStore({ root, signingKey });
  assert.deepEqual(await store.get(revision), artifact(revision));
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
  assert.equal(backend.reads.filter((key) => key.endsWith(".blob")).length, 6);

  backend.reads.length = 0;
  assert.deepEqual(await reader.get(revision), artifact(revision));
  assert.deepEqual(
    backend.reads.map((key) => path.posix.basename(key)),
    [`${revision}.json`],
  );
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
  const envelope = JSON.parse(await readFile(manifestPath(root, revision), "utf8")) as {
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
  const blobsBeforeExpiry = await readdir(path.join(artifactRoot(root), "blobs"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await store.get(revision), null);
  assert.equal(await readFile(manifestPath(root, revision), "utf8").catch(() => null), null);
  assert.deepEqual(
    await readdir(path.join(artifactRoot(root), "blobs")),
    blobsBeforeExpiry,
  );
  assert.deepEqual(
    await retainedStore.get(retainedRevision),
    artifact(retainedRevision),
  );
});
