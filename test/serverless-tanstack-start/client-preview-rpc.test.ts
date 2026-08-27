import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { materializeTanstackRouteTree } from "../../lib/ide/tanstack-route-tree";
import { getServerlessTanstackStartTemplate } from "../../lib/ide/templates";
import type { WorkspaceLanguage } from "../../lib/ide/types";
import {
  OPTIONS as handleNativeRpcOptions,
  POST as handleNativeRpc,
} from "../../app/api/serverless/tanstack-start/core-rpc/route";
import { GET as getNativeAsset } from "../../app/api/serverless/tanstack-start/core-asset/route";
import { GET as handleNativeRender } from "../../app/api/serverless/tanstack-start/core-render/route";
import { GET as getClientKernel } from "../../app/api/serverless/tanstack-start/kernel/client/route";
import {
  clearTanstackStartArtifactCache,
  createWorkspaceRevision,
  putTanstackStartArtifact,
} from "../../lib/serverless-tanstack-start/artifact-cache";
import {
  createFilesystemTanstackStartArtifactStore,
  setTanstackStartArtifactStoreForTests,
} from "../../lib/serverless-tanstack-start/artifact-store";
import kernelManifest from "../../lib/serverless-tanstack-start/kernel-manifest.generated.json";
import { clearNativeRpcWorkerPoolForTests } from "../../lib/serverless-tanstack-start/native-rpc-worker-pool";

type WorkspaceFileInput = {
  content: string;
  language: WorkspaceLanguage;
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
  rpcToken: string;
  ssrClientBundle: string;
  ssrCss: string;
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
    rpcToken: preview.rpcToken,
    ssrClientBundle: preview.ssrClientBundle,
    ssrCss: preview.ssrCss,
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
    assert.equal(observedRequest?.credentials, "include");
    assert.match(
      observedRequest?.url ?? "",
      new RegExp(`revision=${preview.revision}`),
    );
    assert.match(
      observedRequest?.url ?? "",
      new RegExp(`&token=${preview.rpcToken}&id=[a-f0-9]{64}$`),
    );
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

test("the native Start host runs request middleware, cookies, and sessions", async () => {
  const files: WorkspaceFileInput[] = [
    {
      path: "index.html",
      language: "html",
      content: '<script type="module" src="./src/main.ts"></script>',
    },
    {
      path: "src/start.ts",
      language: "ts",
      content: `import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start';
import {
  getCookie,
  getRequestHeader,
  getRequestUrl,
  setCookie,
  setResponseHeader,
  useSession,
} from '@tanstack/react-start/server';

const requestContext = createMiddleware().server(async ({ handlerType, next, request }) => {
  const priorVisitor = getCookie('tuto-visitor') ?? null;
  const session = await useSession({
    name: 'tuto-test-session',
    password: 'tuto-test-session-password-is-at-least-32-characters',
    sessionHeader: false,
    cookie: { httpOnly: true, path: '/', sameSite: 'lax', secure: false },
  });
  const visits = Number(session.data.visits ?? 0) + 1;
  await session.update({ visits });
  setCookie('tuto-visitor', 'returning', {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secure: false,
  });
  setResponseHeader('x-request-middleware', 'ran');
  return next({
    context: {
      handlerType,
      priorVisitor,
      requestHeader: getRequestHeader('x-preview-test'),
      requestMethod: request.method,
      requestPath: getRequestUrl().pathname,
      visits,
    },
  });
});

const globalFunctionContext = createMiddleware({ type: 'function' }).server(
  ({ next }) => next({ context: { globalFunctionMiddleware: true } }),
);

const csrfMiddleware = createCsrfMiddleware({
  filter: ({ handlerType }) => handlerType === 'serverFn',
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, requestContext],
  functionMiddleware: [globalFunctionContext],
}));`,
    },
    {
      path: "src/actions.ts",
      language: "ts",
      content: `import { createServerFn } from '@tanstack/react-start';
export const inspectRequest = createServerFn({ method: 'POST' })
  .handler(async ({ context }) => context);`,
    },
    {
      path: "src/main.ts",
      language: "ts",
      content: `import { inspectRequest } from './actions';
globalThis.__tutoPreviewPromise = inspectRequest()
  .then(async (first) => {
    const second = await inspectRequest();
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
  const cookieJar = new Map<string, string>();
  const responseMiddlewareHeaders: Array<string | null> = [];
  const responseSetCookies: string[][] = [];

  assert.equal(preview.success, true);
  assert.ok(source);
  putTanstackStartArtifact({
    buildMetrics: preview.buildMetrics,
    diagnostics: [],
    durationMs: 1,
    html: preview.html,
    kernelId: preview.kernelId,
    revision: preview.revision,
    rpcToken: preview.rpcToken,
    ssrClientBundle: preview.ssrClientBundle,
    ssrCss: preview.ssrCss,
    serverBundle: preview.serverBundle,
    serverFnIds: preview.serverFnIds,
    success: true,
  });

  globalThis.window =
    globalThis.window ?? (globalThis as unknown as Window & typeof globalThis);
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", "null");
    headers.set("x-preview-test", "request-header");
    if (cookieJar.size) {
      headers.set(
        "cookie",
        [...cookieJar].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    const response = await handleNativeRpc(
      new Request(new URL(String(input), "http://tuto.local"), {
        ...init,
        headers,
      }),
    );
    const setCookies =
      (
        response.headers as Headers & { getSetCookie?: () => string[] }
      ).getSetCookie?.() ??
      (response.headers.get("set-cookie")
        ? [response.headers.get("set-cookie")!]
        : []);

    for (const cookie of setCookies) {
      const [pair] = cookie.split(";", 1);
      const separator = pair.indexOf("=");
      cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    responseMiddlewareHeaders.push(
      response.headers.get("x-request-middleware"),
    );
    responseSetCookies.push(setCookies);
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
      ).toString("base64")}#${preview.revision}`
    );
    await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${preview.revision}`
    );
    await globalThis.__tutoPreviewPromise;

    assert.deepEqual(
      JSON.parse(JSON.stringify(globalThis.__tutoPreviewResult)),
      {
        first: {
          globalFunctionMiddleware: true,
          handlerType: "serverFn",
          priorVisitor: null,
          requestHeader: "request-header",
          requestMethod: "POST",
          requestPath: `/__tuto_server_fn/${preview.serverFnIds[0]}`,
          visits: 1,
        },
        second: {
          globalFunctionMiddleware: true,
          handlerType: "serverFn",
          priorVisitor: "returning",
          requestHeader: "request-header",
          requestMethod: "POST",
          requestPath: `/__tuto_server_fn/${preview.serverFnIds[0]}`,
          visits: 2,
        },
      },
    );
    assert.deepEqual(responseMiddlewareHeaders, ["ran", "ran"]);
    assert.ok(responseSetCookies.every((cookies) => cookies.length >= 2));
    assert.ok(cookieJar.has("tuto-test-session"));
    assert.equal(cookieJar.get("tuto-visitor"), "returning");
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
  }
});

test("the native Start host renders a workspace router with loaders", async () => {
  const files: WorkspaceFileInput[] = [
    {
      path: "index.html",
      language: "html",
      content: '<script type="module" src="./src/main.ts"></script>',
    },
    {
      path: "src/main.ts",
      language: "ts",
      content: "export {};",
    },
    {
      path: "src/router.tsx",
      language: "tsx",
      content: `import React from 'react';
import {
  Outlet,
  Scripts,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

const rootRoute = createRootRoute({
  component: () => (
    <html lang="en">
      <head><title>Native Start SSR</title></head>
      <body><main><Outlet /></main><Scripts /></body>
    </html>
  ),
});

const helloRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hello',
  loader: async () => ({ message: 'loader rendered on the server' }),
  component: HelloRoute,
});

function HelloRoute() {
  const data = helloRoute.useLoaderData();
  return <h1 data-ssr="true">{data.message}</h1>;
}

const routeTree = rootRoute.addChildren([helloRoute]);

export function getRouter() {
  return createRouter({ routeTree });
}`,
    },
  ];
  const preview = compilePreview(files);

  assert.equal(preview.success, true, preview.html);
  assert.deepEqual(preview.serverFnIds, []);
  assert.ok(preview.serverBundle.length > 0);
  assert.ok(preview.ssrClientBundle.length > 0);
  putTanstackStartArtifact({
    buildMetrics: preview.buildMetrics,
    diagnostics: [],
    durationMs: 1,
    html: preview.html,
    kernelId: preview.kernelId,
    revision: preview.revision,
    rpcToken: preview.rpcToken,
    ssrClientBundle: preview.ssrClientBundle,
    ssrCss: preview.ssrCss,
    serverBundle: preview.serverBundle,
    serverFnIds: preview.serverFnIds,
    success: true,
  });

  try {
    const response = await handleNativeRender(
      new Request(
        `http://tuto.local/api/serverless/tanstack-start/core-render?revision=${preview.revision}&token=${preview.rpcToken}&path=%2Fhello`,
      ),
    );
    const html = await response.text();

    assert.equal(response.status, 200, html);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(response.headers.get("x-tuto-artifact-cache"), "hot");
    assert.match(html, /Native Start SSR/);
    assert.match(html, /data-ssr="true"/);
    assert.match(html, /loader rendered on the server/);
    assert.match(html, /tanstack-start\/kernel\/client/);
    assert.match(html, /tanstack-start\/core-asset/);

    const clientAsset = await getNativeAsset(
      new Request(
        `http://tuto.local/api/serverless/tanstack-start/core-asset?revision=${preview.revision}&token=${preview.rpcToken}&kind=client`,
      ),
    );
    assert.equal(clientAsset.status, 200);
    assert.match(
      clientAsset.headers.get("content-type") ?? "",
      /text\/javascript/,
    );
    assert.ok((await clientAsset.text()).length > 100);
  } finally {
    clearTanstackStartArtifactCache();
    clearNativeRpcWorkerPoolForTests();
  }
});

test("the complete Start starter template compiles and renders through SSR", async () => {
  const template = getServerlessTanstackStartTemplate();
  assert.ok(template);
  const files = materializeTanstackRouteTree(template.files).map(
    ({ content, language, path: filePath }) => ({
      content,
      language,
      path: filePath,
    }),
  );
  const preview = compilePreview(files);

  assert.equal(preview.success, true, preview.html);
  assert.ok(preview.serverBundle.length > 0);
  assert.ok(preview.ssrClientBundle.length > 0);
  assert.ok(preview.ssrCss.length > 0);
  putTanstackStartArtifact({
    buildMetrics: preview.buildMetrics,
    diagnostics: [],
    durationMs: 1,
    html: preview.html,
    kernelId: preview.kernelId,
    revision: preview.revision,
    rpcToken: preview.rpcToken,
    ssrClientBundle: preview.ssrClientBundle,
    ssrCss: preview.ssrCss,
    serverBundle: preview.serverBundle,
    serverFnIds: preview.serverFnIds,
    success: true,
  });

  try {
    const response = await handleNativeRender(
      new Request(
        `http://tuto.local/api/serverless/tanstack-start/core-render?revision=${preview.revision}&token=${preview.rpcToken}&path=%2F`,
      ),
    );
    const html = await response.text();

    assert.equal(response.status, 200, html);
    assert.match(html, /Real file routes, loaders, params/);
    assert.match(html, /tanstack-start\/core-asset/);
  } finally {
    clearTanstackStartArtifactCache();
    clearNativeRpcWorkerPoolForTests();
  }
});

test("native RPC rejects missing and incorrect capability tokens", async () => {
  const revision = "e".repeat(64);
  const serverFnId = "f".repeat(64);
  const rpcToken = "t".repeat(43);
  putTanstackStartArtifact({
    buildMetrics: {
      clientFrameworkInputs: 0,
      clientRevisionBytes: 0,
      serverFrameworkInputs: 0,
      serverRevisionBytes: 0,
      sharedClientKernelBytes: 0,
      sharedServerKernelBytes: 0,
    },
    diagnostics: [],
    durationMs: 1,
    html: "",
    kernelId: kernelManifest.id,
    revision,
    rpcToken,
    ssrClientBundle: "",
    ssrCss: "",
    serverBundle: "",
    serverFnIds: [serverFnId],
    success: true,
  });

  try {
    for (const token of [null, "w".repeat(43)]) {
      const url = new URL(
        "http://tuto.local/api/serverless/tanstack-start/core-rpc",
      );
      url.searchParams.set("revision", revision);
      url.searchParams.set("id", serverFnId);
      if (token) url.searchParams.set("token", token);
      const response = await handleNativeRpc(
        new Request(url, { method: "POST" }),
      );

      assert.equal(response.status, 403);
      assert.match(await response.text(), /invalid preview rpc capability/i);
    }
  } finally {
    clearTanstackStartArtifactCache();
  }
});

test("native RPC preflight supports credentialed preview requests", async () => {
  const response = handleNativeRpcOptions(
    new Request("http://tuto.local/api/serverless/tanstack-start/core-rpc", {
      method: "OPTIONS",
      headers: {
        "access-control-request-headers": "content-type,x-preview-test",
        origin: "null",
      },
    }),
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
  assert.equal(
    response.headers.get("access-control-allow-credentials"),
    "true",
  );
  assert.equal(
    response.headers.get("access-control-allow-headers"),
    "content-type,x-preview-test",
  );
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
