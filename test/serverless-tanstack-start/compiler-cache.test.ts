import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  clearTanstackStartArtifactCache,
  getTanstackStartArtifact,
  type TanstackStartArtifact,
} from "../../lib/serverless-tanstack-start/artifact-cache";
import {
  getTanstackStartArtifactMetadata,
  setTanstackStartArtifactStoreForTests,
} from "../../lib/serverless-tanstack-start/artifact-store";
import { compileServerlessTanstackStartWorkspace } from "../../lib/serverless-tanstack-start/compiler";
import { clearNativeRpcWorkerPoolForTests } from "../../lib/serverless-tanstack-start/native-rpc-worker-pool";
import { GET as handleNativeRender } from "../../app/api/serverless/tanstack-start/core-render/route";
import { GET as handleNativeAsset } from "../../app/api/serverless/tanstack-start/core-asset/route";

afterEach(async () => {
  clearTanstackStartArtifactCache();
  await clearNativeRpcWorkerPoolForTests();
  setTanstackStartArtifactStoreForTests(undefined);
});

function workspaceFiles() {
  return [
    {
      path: "index.html",
      content: '<script type="module" src="./src/main.ts"></script>',
      language: "html" as const,
    },
    {
      path: "src/actions.ts",
      content: `import { createServerFn } from '@tanstack/react-start';
export const greet = createServerFn({ method: 'POST' }).handler(async () => 'hello');`,
      language: "ts" as const,
    },
    {
      path: "src/main.ts",
      content: "import { greet } from './actions'; globalThis.greet = greet;",
      language: "ts" as const,
    },
  ];
}

test("a Start workspace compiles once per content revision", async () => {
  const files = workspaceFiles();

  const [first, shared] = await Promise.all([
    compileServerlessTanstackStartWorkspace(files),
    compileServerlessTanstackStartWorkspace(files),
  ]);
  const second = await compileServerlessTanstackStartWorkspace(
    [...files].reverse(),
  );

  assert.equal(first.success, true, JSON.stringify(first.diagnostics, null, 2));
  assert.equal(first.cacheStatus, "miss");
  assert.equal(shared.cacheStatus, "shared");
  assert.equal(shared.revision, first.revision);
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.match(first.html ?? "", new RegExp(`revision=${first.revision}`));
  assert.ok(
    first.buildMetrics.clientRevisionBytes <
      first.buildMetrics.sharedClientKernelBytes,
  );
  assert.ok(
    first.buildMetrics.serverRevisionBytes <
      first.buildMetrics.sharedServerKernelBytes,
  );
  assert.equal(first.buildMetrics.clientFrameworkInputs, 0);
  assert.equal(first.buildMetrics.serverFrameworkInputs, 0);
  assert.doesNotMatch(
    first.html ?? "",
    /body:JSON\.stringify\(\{id,payload,files:/,
  );
  assert.equal(second.success, true);
  assert.equal(second.cacheStatus, "hit");
  assert.equal(second.durationMs, 0);
  assert.equal(second.revision, first.revision);
  assert.equal(second.html, first.html);
});

test("a durable artifact prevents recompilation after a hot-cache miss", async () => {
  const durable = new Map<string, TanstackStartArtifact>();
  let fullReads = 0;
  let summaryReads = 0;
  setTanstackStartArtifactStoreForTests({
    async get(revision) {
      fullReads += 1;
      return durable.get(revision) ?? null;
    },
    async getSummary(revision) {
      summaryReads += 1;
      const artifact = durable.get(revision);
      return artifact
        ? {
            ...getTanstackStartArtifactMetadata(artifact),
            html: artifact.html,
          }
        : null;
    },
    async put(artifact) {
      durable.set(artifact.revision, artifact);
    },
  });

  const first = await compileServerlessTanstackStartWorkspace(workspaceFiles());
  assert.equal(first.cacheStatus, "miss");
  assert.equal(durable.has(first.revision), true);

  clearTanstackStartArtifactCache();
  const restored =
    await compileServerlessTanstackStartWorkspace(workspaceFiles());
  assert.equal(restored.cacheStatus, "durable");
  assert.equal(restored.durationMs, 0);
  assert.equal(restored.revision, first.revision);
  assert.equal(restored.html, first.html);
  assert.equal(summaryReads, 2);
  assert.equal(fullReads, 0);
});

test("emits revision-pinned static documents and serves exact routes before the SPA shell", async () => {
  const files = [
    {
      path: "tanstack-start.config.json",
      content: JSON.stringify({
        pages: [{ path: "/static", prerender: { crawlLinks: false } }],
        prerender: { autoStaticPathsDiscovery: false, enabled: true },
        spa: { enabled: true, maskPath: "/static" },
      }),
      language: "json" as const,
    },
    {
      path: "index.html",
      content: '<script type="module" src="./src/main.ts"></script>',
      language: "html" as const,
    },
    {
      path: "src/main.ts",
      content: "export {};",
      language: "ts" as const,
    },
    {
      path: "src/routes/static.tsx",
      content: `import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { staticFunctionMiddleware } from '@tanstack/start-static-server-functions';

const readStaticMessage = createServerFn({ method: 'GET' })
  .middleware([staticFunctionMiddleware])
  .inputValidator((data) => ({ scope: String(data.scope) }))
  .handler(({ data }) => ({ message: 'static-function-build-result:' + data.scope }));

export const Route = createFileRoute('/static')({
  loader: async () => ({
    source: typeof window === 'undefined' ? 'static-server' : 'client',
    staticMessage: (await readStaticMessage({ data: { scope: 'fixture' } })).message,
  }),
  component: StaticRoute,
});
function StaticRoute() {
  const data = Route.useLoaderData();
  return <main data-testid="static-child">
    Static route rendered by {data.source}: {data.staticMessage}
  </main>;
}`,
      language: "tsx" as const,
    },
    {
      path: "src/router.tsx",
      content: `import {
  Outlet,
  Scripts,
  createMemoryHistory,
  createRootRoute,
  createRouter,
  useRouter,
} from '@tanstack/react-router';
import { Route as staticRouteImport } from './routes/static';

const rootRoute = createRootRoute({
  component: () => <html><head><title>Static output fixture</title></head><body>
    <p data-spa-shell={String(useRouter().isShell())}>root shell</p>
    <Outlet />
    <Scripts />
  </body></html>,
});
const staticRoute = staticRouteImport.update({
  getParentRoute: () => rootRoute,
  id: '/static',
  path: '/static',
});
const routeTree = rootRoute.addChildren([staticRoute]);
export function getRouter() {
  return createRouter({
    defaultPendingComponent: () => <p data-spa-pending="true">Loading SPA route</p>,
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree,
  });
}`,
      language: "tsx" as const,
    },
  ];

  const result = await compileServerlessTanstackStartWorkspace(files);
  assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));
  const artifact = getTanstackStartArtifact(result.revision);
  assert.ok(artifact?.prerendered);
  assert.deepEqual(artifact.prerendered.routes, {
    "/static": "/static/index.html",
  });
  assert.equal(artifact.prerendered.shell, "/_shell.html");
  assert.match(
    artifact.prerendered.documents["/static/index.html"] ?? "",
    /Static route rendered by.*static-server.*static-function-build-result:.*fixture/,
  );
  assert.match(
    artifact.prerendered.documents["/_shell.html"] ?? "",
    /data-spa-shell="true"/,
  );

  const renderUrl = new URL(
    "http://tuto.local/api/serverless/tanstack-start/core-render",
  );
  renderUrl.searchParams.set("revision", result.revision);
  renderUrl.searchParams.set("token", artifact.rpcToken);
  renderUrl.searchParams.set("path", "/static");
  const exact = await handleNativeRender(new Request(renderUrl));
  assert.equal(exact.status, 200);
  assert.equal(exact.headers.get("x-tuto-prerender-kind"), "route");
  assert.equal(
    exact.headers.get("x-tuto-prerender-output"),
    "/static/index.html",
  );
  assert.equal(
    exact.headers.get("cache-control"),
    "private, max-age=31536000, immutable",
  );
  assert.equal(exact.headers.get("x-tuto-worker-id"), null);

  renderUrl.searchParams.set("path", "/unmatched");
  const shell = await handleNativeRender(new Request(renderUrl));
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get("x-tuto-prerender-kind"), "shell");
  assert.equal(shell.headers.get("x-tuto-prerender-output"), "/_shell.html");
  assert.equal(shell.headers.get("x-tuto-worker-id"), null);

  const staticEntries = Object.entries(artifact.staticServerFunctions ?? {});
  assert.equal(staticEntries.length, 1);
  const [[cachePath, cacheBody]] = staticEntries;
  assert.match(
    cachePath,
    /^\/__tsr\/staticServerFnCache\/[a-f0-9]{40}\.json$/,
  );
  assert.match(cacheBody, /static-function-build-result:fixture/);

  const assetUrl = new URL(
    "http://tuto.local/api/serverless/tanstack-start/core-asset",
  );
  assetUrl.searchParams.set("revision", result.revision);
  assetUrl.searchParams.set("token", artifact.rpcToken);
  assetUrl.searchParams.set("kind", "static-server-function");
  assetUrl.searchParams.set("name", cachePath);
  const cachedResult = await handleNativeAsset(new Request(assetUrl));
  assert.equal(cachedResult.status, 200);
  assert.equal(await cachedResult.text(), cacheBody);
  assert.equal(
    cachedResult.headers.get("cache-control"),
    "private, max-age=31536000, immutable",
  );
  assert.equal(cachedResult.headers.get("x-tuto-worker-id"), null);
});
