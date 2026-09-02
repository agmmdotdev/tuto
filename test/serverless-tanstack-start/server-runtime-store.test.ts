import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
  ServerRuntimeSourceError,
  ServerRuntimeStore,
  type ServerRuntimeArtifact,
} from "../../lib/serverless-tanstack-start/server-runtime-store";

const temporaryRoots: string[] = [];
const kernelId = "f".repeat(20);

function artifact(revisionCharacter: string): ServerRuntimeArtifact {
  return {
    kernelId,
    revision: revisionCharacter.repeat(64),
    serverBundle: `import { routeValue } from "./chunks/chunk-ROUTE.js";\nglobalThis.routeValue = routeValue;\n`,
    serverChunks: {
      "chunks/chunk-ROUTE.js": `export const routeValue = "shared route";\n`,
    },
  };
}

function deferredArtifact(
  revisionCharacter: string,
  onLoad: () => void,
): ServerRuntimeArtifact {
  const inline = artifact(revisionCharacter);
  const source = (contents: string) => ({
    bytes: Buffer.byteLength(contents),
    hash: createHash("sha256").update(contents).digest("hex"),
    async load() {
      onLoad();
      return contents;
    },
  });
  return {
    kernelId: inline.kernelId,
    revision: inline.revision,
    serverBundle: "",
    serverChunks: {},
    serverSources: {
      chunks: Object.fromEntries(
        Object.entries(inline.serverChunks).map(([name, contents]) => [
          name,
          source(contents),
        ]),
      ),
      entry: source(inline.serverBundle),
    },
  };
}

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "tuto-runtime-store-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

test("deduplicates immutable blobs and shares revision files across leases", async () => {
  const root = await temporaryRoot();
  const store = new ServerRuntimeStore({ root });
  const first = await store.acquire(artifact("a"));
  const reused = await store.acquire(artifact("a"));
  const secondRevision = await store.acquire(artifact("b"));
  const entryBlobPath = path.join(root, "blobs", `${first.entryHash}.js`);
  const [entryStat, blobStat] = await Promise.all([
    stat(first.entryPath),
    stat(entryBlobPath),
  ]);

  assert.equal(first.entryPath, reused.entryPath);
  assert.notEqual(first.entryPath, secondRevision.entryPath);
  assert.equal(entryStat.ino, blobStat.ino);
  assert.ok(entryStat.nlink >= 3);
  assert.deepEqual(await store.inspect(), {
    blobs: 2,
    bytes:
      Buffer.byteLength(artifact("a").serverBundle) +
      Buffer.byteLength(artifact("a").serverChunks["chunks/chunk-ROUTE.js"]),
    pinnedRevisions: 2,
    revisions: 2,
  });

  await Promise.all([
    first.release(),
    reused.release(),
    secondRevision.release(),
  ]);
});

test("atomically reuses one revision across independent host stores", async () => {
  const root = await temporaryRoot();
  const firstStore = new ServerRuntimeStore({ root });
  const secondStore = new ServerRuntimeStore({ root });
  const [first, second] = await Promise.all([
    firstStore.acquire(artifact("e")),
    secondStore.acquire(artifact("e")),
  ]);

  assert.equal(first.entryPath, second.entryPath);
  assert.deepEqual(await firstStore.inspect(), {
    blobs: 2,
    bytes:
      Buffer.byteLength(artifact("e").serverBundle) +
      Buffer.byteLength(artifact("e").serverChunks["chunks/chunk-ROUTE.js"]),
    pinnedRevisions: 1,
    revisions: 1,
  });
  await Promise.all([first.release(), second.release()]);
});

test("reuses a materialized runtime without invoking deferred source loaders", async () => {
  const root = await temporaryRoot();
  let initialLoads = 0;
  const firstStore = new ServerRuntimeStore({ root });
  const first = await firstStore.acquire(
    deferredArtifact("9", () => {
      initialLoads += 1;
    }),
  );
  assert.equal(initialLoads, 2);
  await first.release();

  let repeatedLoads = 0;
  const secondStore = new ServerRuntimeStore({ root });
  const second = await secondStore.acquire(
    deferredArtifact("9", () => {
      repeatedLoads += 1;
    }),
  );
  assert.equal(second.entryPath, first.entryPath);
  assert.equal(repeatedLoads, 0);
  await second.release();
});

test("rejects a deferred source that does not match its descriptor", async () => {
  const root = await temporaryRoot();
  const sourceArtifact = deferredArtifact("7", () => undefined);
  sourceArtifact.serverSources!.entry.load = async () =>
    artifact("7").serverBundle.replace("routeValue", "routeVaLue");

  await assert.rejects(
    new ServerRuntimeStore({ root }).acquire(sourceArtifact),
    /runtime source .* failed integrity validation/i,
  );
});

test("removes partial runtime files when a source stream fails", async () => {
  const root = await temporaryRoot();
  const sourceArtifact = deferredArtifact("8", () => undefined);
  sourceArtifact.serverSources!.entry.stream = async () =>
    (async function* () {
      yield Buffer.from("partial source");
      throw new Error("stream interrupted");
    })();

  await assert.rejects(
    new ServerRuntimeStore({ root }).acquire(sourceArtifact),
    (error) =>
      error instanceof ServerRuntimeSourceError &&
      /could not be read/i.test(error.message),
  );
  assert.deepEqual(await readdir(path.join(root, "tmp")), []);
});

test("separates runtime output changes for the same workspace revision", async () => {
  const root = await temporaryRoot();
  const store = new ServerRuntimeStore({ root });
  const original = artifact("f");
  const rebuilt = {
    ...original,
    serverBundle: `${original.serverBundle}globalThis.runtimeVersion = 2;\n`,
  };
  const [first, second] = await Promise.all([
    store.acquire(original),
    store.acquire(rebuilt),
  ]);

  assert.notEqual(first.entryPath, second.entryPath);
  assert.equal(first.revision, second.revision);
  assert.deepEqual(await store.inspect(), {
    blobs: 3,
    bytes:
      Buffer.byteLength(original.serverBundle) +
      Buffer.byteLength(rebuilt.serverBundle) +
      Buffer.byteLength(original.serverChunks["chunks/chunk-ROUTE.js"]),
    pinnedRevisions: 2,
    revisions: 2,
  });
  await Promise.all([first.release(), second.release()]);
});

test("does not prune pinned revisions and removes the oldest released revision", async () => {
  const root = await temporaryRoot();
  const store = new ServerRuntimeStore({
    cleanupGraceMs: 0,
    maxRevisions: 1,
    root,
  });
  const first = await store.acquire(artifact("a"));
  const second = await store.acquire(artifact("b"));

  assert.equal((await store.inspect()).revisions, 2);
  await first.release();
  const third = await store.acquire(artifact("c"));

  assert.equal(await stat(first.entryPath).catch(() => null), null);
  assert.equal((await store.inspect()).revisions, 2);
  await Promise.all([second.release(), third.release()]);
  await store.prune();
  assert.equal((await store.inspect()).revisions, 1);
});

test("rejects a corrupted content-addressed runtime on a new host process", async () => {
  const root = await temporaryRoot();
  const sourceArtifact = artifact("d");
  const writer = new ServerRuntimeStore({ root });
  const lease = await writer.acquire(sourceArtifact);
  await lease.release();

  const blobPath = path.join(root, "blobs", `${lease.entryHash}.js`);
  const corrupted = sourceArtifact.serverBundle.replace(
    "routeValue",
    "routeVaLue",
  );
  assert.equal(
    Buffer.byteLength(corrupted),
    Buffer.byteLength(sourceArtifact.serverBundle),
  );
  await chmod(blobPath, 0o600);
  await writeFile(blobPath, corrupted, "utf8");
  assert.notEqual(
    createHash("sha256").update(corrupted).digest("hex"),
    lease.entryHash,
  );

  const reader = new ServerRuntimeStore({ root });
  await assert.rejects(
    reader.acquire(sourceArtifact),
    /failed integrity validation/i,
  );
});
