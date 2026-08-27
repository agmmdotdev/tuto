import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { POST as handleNativeRpc } from "../../app/api/serverless/tanstack-start/core-rpc/route";
import { GET as getClientKernel } from "../../app/api/serverless/tanstack-start/kernel/client/route";
import {
  clearTanstackStartArtifactCache,
  createWorkspaceRevision,
} from "../../lib/serverless-tanstack-start/artifact-cache";
import {
  createFilesystemTanstackStartArtifactStore,
  setTanstackStartArtifactStoreForTests,
} from "../../lib/serverless-tanstack-start/artifact-store";
import kernelManifest from "../../lib/serverless-tanstack-start/kernel-manifest.generated.json";
import { clearNativeRpcWorkerPoolForTests } from "../../lib/serverless-tanstack-start/native-rpc-worker-pool";

type WorkspaceFileInput = {
  content: string;
  language: "html" | "ts";
  path: string;
};

type PreviewCompileResult = {
  buildMetrics: {
    clientFrameworkInputs: number;
    clientRevisionBytes: number;
    serverFrameworkInputs: number;
    serverRevisionBytes: number;
    sharedClientKernelBytes: number;
    sharedServerKernelBytes: number;
  };
  html: string;
  kernelId: string;
  revision: string;
  serverBundle: string;
  serverFnIds: string[];
  success: boolean;
};

declare global {
  var __tutoPreviewPromise: Promise<unknown> | undefined;
  var __tutoPreviewResult: unknown;
}

function workspaceRevision(files: WorkspaceFileInput[]) {
  return createWorkspaceRevision(files);
}

function compilePreview(files: WorkspaceFileInput[]): PreviewCompileResult {
  const revision = workspaceRevision(files);
  const child = spawnSync(
    process.execPath,
    ["lib/serverless-tanstack-start/core-preview-runner.generated.cjs"],
    {
      cwd: process.cwd(),
      input: JSON.stringify({ files, revision }),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 20_000_000,
    },
  );
  const match = child.stdout.match(
    /__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_START__\n([\s\S]*?)\n__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_END__/,
  );
  if (!match)
    throw new Error(child.stderr || child.stdout || "Missing preview result.");
  return JSON.parse(match[1]) as PreviewCompileResult;
}

test("real Start client and server runtimes round-trip without sending workspace files", async () => {
  const files: WorkspaceFileInput[] = [
    {
      path: "index.html",
      language: "html",
      content: '<script type="module" src="./src/main.ts"></script>',
    },
    {
      path: "src/actions.ts",
      language: "ts",
      content: `import { createMiddleware, createServerFn } from '@tanstack/react-start';
const context = createMiddleware({ type: 'function' }).server(({ next }) =>
  next({ context: { source: 'native-start' } }),
);
export const greet = createServerFn({ method: 'POST' })
  .middleware([context])
  .inputValidator((data) => ({ name: String(data.name).trim() }))
  .handler(async ({ context, data }) => ({ message: 'hi ' + data.name, source: context.source }));`,
    },
    {
      path: "src/main.ts",
      language: "ts",
      content: `import { greet } from './actions';
globalThis.__tutoPreviewPromise = greet({ data: { name: ' Ada ' } })
  .then(async (first) => {
    const second = await greet({ data: { name: ' Grace ' } });
    globalThis.__tutoPreviewResult = { first, second };
  });`,
    },
  ];
  const preview = compilePreview(files);
  const source = preview.html.match(
    /<script type="module">([\s\S]*?)<\/script>/,
  )?.[1];
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  let observedRequest: Request | undefined;
  const observedArtifactCaches: Array<string | null> = [];
  const observedWorkerIds: Array<string | null> = [];
  const observedWorkerRequests: Array<string | null> = [];
  const observedWorkerReuse: Array<string | null> = [];
  const durableRoot = await mkdtemp(
    path.join(tmpdir(), "tuto-rpc-durable-test-"),
  );
  const durableStore = createFilesystemTanstackStartArtifactStore({
    root: durableRoot,
    signingKey: "rpc-test-key",
  });

  assert.equal(preview.success, true);
  assert.equal(preview.revision, workspaceRevision(files));
  assert.equal(preview.kernelId, kernelManifest.id);
  assert.equal(preview.serverFnIds.length, 1);
  assert.ok(preview.buildMetrics.clientRevisionBytes < 20_000);
  assert.ok(preview.buildMetrics.serverRevisionBytes < 20_000);
  assert.equal(preview.buildMetrics.clientFrameworkInputs, 0);
  assert.equal(preview.buildMetrics.serverFrameworkInputs, 0);
  assert.match(
    preview.html,
    new RegExp(`kernel/client\\?v=${preview.kernelId}`),
  );
  assert.ok(source);
  const artifact = {
    buildMetrics: preview.buildMetrics,
    diagnostics: [],
    durationMs: 1,
    html: preview.html,
    kernelId: preview.kernelId,
    revision: preview.revision,
    serverBundle: preview.serverBundle,
    serverFnIds: preview.serverFnIds,
    success: true,
  };
  await durableStore.put(artifact);
  setTanstackStartArtifactStoreForTests(durableStore);
  clearTanstackStartArtifactCache();

  globalThis.window =
    globalThis.window ?? (globalThis as unknown as Window & typeof globalThis);
  globalThis.fetch = async (input, init) => {
    const request = new Request(
      new URL(String(input), "http://tuto.local"),
      init,
    );
    observedRequest = request.clone();
    const response = await handleNativeRpc(request);
    observedArtifactCaches.push(response.headers.get("x-tuto-artifact-cache"));
    observedWorkerIds.push(response.headers.get("x-tuto-worker-id"));
    observedWorkerRequests.push(response.headers.get("x-tuto-worker-request"));
    observedWorkerReuse.push(response.headers.get("x-tuto-worker-reused"));
    return response;
  };

  try {
    const kernelResponse = await getClientKernel(
      new Request(
        `http://tuto.local/api/serverless/tanstack-start/kernel/client?v=${preview.kernelId}`,
      ),
    );
    assert.equal(kernelResponse.status, 200);
    await import(
      `data:text/javascript;base64,${Buffer.from(
        await kernelResponse.text(),
      ).toString("base64")}`
    );
    await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    await globalThis.__tutoPreviewPromise;
    assert.deepEqual(globalThis.__tutoPreviewResult, {
      first: {
        message: "hi Ada",
        source: "native-start",
      },
      second: {
        message: "hi Grace",
        source: "native-start",
      },
    });
    assert.equal(observedRequest?.headers.get("x-tsr-serverfn"), "true");
    assert.match(
      observedRequest?.url ?? "",
      new RegExp(`revision=${preview.revision}`),
    );
    assert.match(observedRequest?.url ?? "", /&id=[a-f0-9]{64}$/);
    assert.doesNotMatch(await observedRequest!.text(), /"files"\s*:/);
    assert.deepEqual(observedArtifactCaches, ["durable", "hot"]);
    assert.equal(observedWorkerIds.length, 2);
    assert.ok(observedWorkerIds[0]);
    assert.equal(observedWorkerIds[1], observedWorkerIds[0]);
    assert.deepEqual(observedWorkerRequests, ["1", "2"]);
    assert.deepEqual(observedWorkerReuse, ["false", "true"]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
    globalThis.__tutoPreviewPromise = undefined;
    globalThis.__tutoPreviewResult = undefined;
    delete (globalThis as typeof globalThis & Record<string, unknown>)[
      kernelManifest.client.globalKey
    ];
    clearTanstackStartArtifactCache();
    clearNativeRpcWorkerPoolForTests();
    setTanstackStartArtifactStoreForTests(undefined);
    await rm(durableRoot, { force: true, recursive: true });
  }
});

test("native RPC reports an evicted or cross-instance revision explicitly", async () => {
  clearTanstackStartArtifactCache();
  const response = await handleNativeRpc(
    new Request(
      `http://tuto.local/api/serverless/tanstack-start/core-rpc?revision=${"a".repeat(
        64,
      )}&id=${"b".repeat(64)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tsr-serverfn": "true",
        },
        body: "{}",
      },
    ),
  );

  assert.equal(response.status, 410);
  assert.match(await response.text(), /rebuild the preview/i);
});

test("native RPC distinguishes durable-store outages from eviction", async () => {
  clearTanstackStartArtifactCache();
  setTanstackStartArtifactStoreForTests({
    async get() {
      throw new Error("object store offline");
    },
    async put() {},
  });

  try {
    const response = await handleNativeRpc(
      new Request(
        `http://tuto.local/api/serverless/tanstack-start/core-rpc?revision=${"c".repeat(
          64,
        )}&id=${"d".repeat(64)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tsr-serverfn": "true",
          },
          body: "{}",
        },
      ),
    );

    assert.equal(response.status, 503);
    assert.match(await response.text(), /object store offline/i);
  } finally {
    setTanstackStartArtifactStoreForTests(undefined);
  }
});
