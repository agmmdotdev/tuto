import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import type { TanstackStartArtifact } from "../../lib/serverless-tanstack-start/artifact-cache";
import {
  createFilesystemTanstackStartArtifactStore,
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
    rpcToken: "t".repeat(43),
    ssrClientBundle: "",
    ssrCss: "",
    serverBundle: "export const durable = true;",
    serverFnIds: ["server-fn"],
    success: true,
  };
}

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "tuto-artifact-store-test-"));
  temporaryRoots.push(root);
  return root;
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

test("expired durable artifacts are treated as misses", async () => {
  const root = await temporaryRoot();
  const revision = "b".repeat(64);
  const store = createFilesystemTanstackStartArtifactStore({
    root,
    signingKey: "expiry-key",
    ttlMs: 1,
  });
  await store.put(artifact(revision));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await store.get(revision), null);
});
