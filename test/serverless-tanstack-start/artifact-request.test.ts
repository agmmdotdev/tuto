import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  clearTanstackStartArtifactCache,
  type TanstackStartArtifact,
} from "../../lib/serverless-tanstack-start/artifact-cache";
import { resolveArtifactAssetRequest } from "../../lib/serverless-tanstack-start/artifact-request";
import {
  getTanstackStartArtifactMetadata,
  setTanstackStartArtifactStoreForTests,
} from "../../lib/serverless-tanstack-start/artifact-store";
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
  revision,
  routeManifest: {},
  rpcToken: token,
  serverBundle: "",
  serverChunks: {},
  serverFnIds: [],
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
