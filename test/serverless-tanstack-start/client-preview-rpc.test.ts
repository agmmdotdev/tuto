import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  GET as handleNativeRouteGet,
  POST as handleNativeRoutePost,
} from "../../app/api/serverless/tanstack-start/core-route/route";
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
  diagnostics: Array<{ message: string }>;
  html: string;
  kernelId: string;
  revision: string;
  routeManifest: Record<string, { css?: string[]; preloads: string[] }>;
  rpcToken: string;
  ssrClientBundle: string;
  ssrClientChunks: Record<string, string>;
  ssrCss: string;
  ssrCssChunks: Record<string, string>;
  serverBundle: string;
  serverChunks: Record<string, string>;
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

function basicClientWorkspace(
  source: string,
  extraFiles: WorkspaceFileInput[] = [],
): WorkspaceFileInput[] {
  return [
    {
      path: "index.html",
      language: "html",
      content: '<script type="module" src="./src/main.ts"></script>',
    },
    { path: "src/main.ts", language: "ts", content: source },
    ...extraFiles,
  ];
}

test("loads Vite-style public environment variables without leaking server secrets", () => {
  const files = basicClientWorkspace(
    `import { readSecret } from './actions';
globalThis.__publicEnvironment = import.meta.env.VITE_APP_NAME;
globalThis.__privateEnvironment = import.meta.env.SERVER_SECRET;
globalThis.__readSecret = readSecret;`,
    [
      {
        path: ".env",
        language: "md",
        content:
          "VITE_APP_NAME=Tuto environment fixture\nSERVER_SECRET=server-environment-secret",
      },
      {
        path: ".env.production.local",
        language: "md",
        content: "VITE_APP_NAME=Tuto production override",
      },
      {
        path: "src/actions.ts",
        language: "ts",
        content: `import { createServerFn } from '@tanstack/react-start';
export const readSecret = createServerFn().handler(() => process.env.SERVER_SECRET);`,
      },
    ],
  );
  const preview = compilePreview(files);
  const clientSource = `${preview.html}\n${preview.ssrClientBundle}\n${Object.values(preview.ssrClientChunks).join("\n")}`;
  const serverSource = `${preview.serverBundle}\n${Object.values(preview.serverChunks).join("\n")}`;

  assert.equal(preview.success, true, preview.html);
  assert.match(clientSource, /Tuto production override/);
  assert.doesNotMatch(clientSource, /Tuto environment fixture/);
  assert.doesNotMatch(clientSource, /server-environment-secret/);
  assert.match(serverSource, /server-environment-secret/);
});

test("enforces default Start import protection across client and server graphs", () => {
  const clientViolations: Array<{
    files?: WorkspaceFileInput[];
    source: string;
  }> = [
    {
      source: "import { secret } from './secret.server'; console.log(secret);",
      files: [
        {
          path: "src/secret.server.ts",
          language: "ts",
          content: "export const secret = 'suffix-secret';",
        },
      ],
    },
    {
      source: "import { secret } from './secret'; console.log(secret);",
      files: [
        {
          path: "src/secret.ts",
          language: "ts",
          content: `import '@tanstack/react-start/server-only';
export const secret = 'marker-secret';`,
        },
      ],
    },
    {
      source:
        "import { getRequest } from '@tanstack/react-start/server'; console.log(getRequest);",
    },
  ];

  for (const violation of clientViolations) {
    const preview = compilePreview(
      basicClientWorkspace(violation.source, violation.files ?? []),
    );
    assert.equal(preview.success, false);
    assert.match(
      preview.diagnostics.map(({ message }) => message).join("\n"),
      /\[import-protection\] Import denied in client environment/,
    );
  }

  const serverViolation = compilePreview(
    basicClientWorkspace("import { readBrowserValue } from './actions';", [
      {
        path: "src/browser.client.ts",
        language: "ts",
        content: "export const browserValue = 'client-only-value';",
      },
      {
        path: "src/actions.ts",
        language: "ts",
        content: `import { createServerFn } from '@tanstack/react-start';
import { browserValue } from './browser.client';
export const readBrowserValue = createServerFn().handler(() => browserValue);`,
      },
    ]),
  );
  assert.equal(serverViolation.success, false);
  assert.match(
    serverViolation.diagnostics.map(({ message }) => message).join("\n"),
    /\[import-protection\] Import denied in server environment/,
  );

  const serverMarkerViolation = compilePreview(
    basicClientWorkspace("import { readBrowserValue } from './actions';", [
      {
        path: "src/browser.ts",
        language: "ts",
        content: `import '@tanstack/react-start/client-only';
export const browserValue = 'client-marker-value';`,
      },
      {
        path: "src/actions.ts",
        language: "ts",
        content: `import { createServerFn } from '@tanstack/react-start';
import { browserValue } from './browser';
export const readBrowserValue = createServerFn().handler(() => browserValue);`,
      },
    ]),
  );
  assert.equal(serverMarkerViolation.success, false);
  assert.match(
    serverMarkerViolation.diagnostics
      .map(({ message }) => message)
      .join("\n"),
    /Denied by client-only marker/,
  );

  const typeOnlyImport = compilePreview(
    basicClientWorkspace(
      `import type { SecretShape } from './secret.server';
const value: SecretShape = { safe: true };
console.log(value.safe);`,
      [
        {
          path: "src/secret.server.ts",
          language: "ts",
          content: "export type SecretShape = { safe: boolean };",
        },
      ],
    ),
  );
  assert.equal(typeOnlyImport.success, true, typeOnlyImport.html);
});

function importProtectionConfig(
  importProtection: Record<string, unknown>,
  mode: "build" | "development" = "build",
): WorkspaceFileInput {
  return {
    path: "tanstack-start.config.json",
    language: "json",
    content: JSON.stringify({ mode, importProtection }),
  };
}

test("applies configurable import-protection deny and scope rules", () => {
  const customSpecifier = compilePreview(
    basicClientWorkspace(
      "import { secret } from 'private-sdk'; console.log(secret);",
      [
        importProtectionConfig({
          client: { specifiers: ["private-*"] },
        }),
      ],
    ),
  );
  assert.equal(customSpecifier.success, false);
  assert.match(
    customSpecifier.diagnostics.map(({ message }) => message).join("\n"),
    /Denied by specifier pattern: private-\*/,
  );

  const customFile = compilePreview(
    basicClientWorkspace("import { secret } from './private/secret'; console.log(secret);", [
      importProtectionConfig({
        client: { files: ["**/private/**"] },
      }),
      {
        path: "src/private/secret.ts",
        language: "ts",
        content: "export const secret = 'private';",
      },
    ]),
  );
  assert.equal(customFile.success, false);
  assert.match(
    customFile.diagnostics.map(({ message }) => message).join("\n"),
    /Denied by file pattern: \*\*\/private\/\*\*/,
  );

  const includedImporter = compilePreview(
    basicClientWorkspace("import './checked/bridge';", [
      importProtectionConfig({ include: ["src/checked/**"] }),
      {
        path: "src/checked/bridge.ts",
        language: "ts",
        content: "import { secret } from '../secret.server'; console.log(secret);",
      },
      {
        path: "src/secret.server.ts",
        language: "ts",
        content: "export const secret = 'included-scope';",
      },
    ]),
  );
  assert.equal(includedImporter.success, false);
  assert.match(
    includedImporter.diagnostics.map(({ message }) => message).join("\n"),
    /Importer: src\/checked\/bridge\.ts/,
  );

  const excludedImporter = compilePreview(
    basicClientWorkspace("import { safe } from './generated/bridge'; console.log(safe);", [
      importProtectionConfig({ exclude: ["src/generated/**"] }),
      {
        path: "src/generated/bridge.ts",
        language: "ts",
        content: "export { secret as safe } from '../secret.server';",
      },
      {
        path: "src/secret.server.ts",
        language: "ts",
        content: "export const secret = 'scope-excluded';",
      },
    ]),
  );
  assert.equal(excludedImporter.success, true, excludedImporter.html);

  const excludedTarget = compilePreview(
    basicClientWorkspace("import { secret } from './secret.server'; console.log(secret);", [
      importProtectionConfig({
        client: { excludeFiles: ["src/secret.server.ts"] },
      }),
      {
        path: "src/secret.server.ts",
        language: "ts",
        content: "export const secret = 'target-excluded';",
      },
    ]),
  );
  assert.equal(excludedTarget.success, true, excludedTarget.html);

  const disabled = compilePreview(
    basicClientWorkspace("import { secret } from './secret.server'; console.log(secret);", [
      importProtectionConfig({ enabled: false }),
      {
        path: "src/secret.server.ts",
        language: "ts",
        content: "export const secret = 'disabled-protection';",
      },
    ]),
  );
  assert.equal(disabled.success, true, disabled.html);

  const ignoredImporter = compilePreview(
    basicClientWorkspace("import './fixtures/bridge';", [
      importProtectionConfig({ ignoreImporters: ["**/fixtures/**"] }),
      {
        path: "src/fixtures/bridge.ts",
        language: "ts",
        content: "import { secret } from '../secret.server'; console.log(secret);",
      },
      {
        path: "src/secret.server.ts",
        language: "ts",
        content: "export const secret = 'ignored-importer';",
      },
    ]),
  );
  assert.equal(ignoredImporter.success, true, ignoredImporter.html);

  const serverSpecifier = compilePreview(
    basicClientWorkspace("import { readValue } from './actions'; console.log(readValue);", [
      importProtectionConfig({
        server: { specifiers: ["browser-runtime"] },
      }),
      {
        path: "src/actions.ts",
        language: "ts",
        content: `import { createServerFn } from '@tanstack/react-start';
import { browserValue } from 'browser-runtime';
export const readValue = createServerFn().handler(() => browserValue);`,
      },
    ]),
  );
  assert.equal(serverSpecifier.success, false);
  assert.match(
    serverSpecifier.diagnostics.map(({ message }) => message).join("\n"),
    /Import denied in server environment[\s\S]*Denied by specifier pattern: browser-runtime/,
  );
});

test("mocks development import violations and emits configurable runtime diagnostics", () => {
  const preview = compilePreview(
    basicClientWorkspace(
      "import { secret } from './secret.server'; globalThis.__mockedSecret = secret.value;",
      [
        importProtectionConfig(
          {
            behavior: { dev: "mock", build: "error" },
            log: "once",
            mockAccess: "warn",
          },
          "development",
        ),
        {
          path: "src/secret.server.ts",
          language: "ts",
          content: "export const secret = { value: 'must-not-leak' };",
        },
      ],
    ),
  );
  const clientSource = `${preview.html}\n${preview.ssrClientBundle}\n${Object.values(preview.ssrClientChunks).join("\n")}`;
  const warnings = preview.diagnostics.filter(({ message }) =>
    message.includes("[import-protection] Import denied"),
  );

  assert.equal(preview.success, true, preview.html);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]?.message ?? "", /client environment/);
  assert.match(clientSource, /console\.warn/);
  assert.doesNotMatch(clientSource, /must-not-leak/);

  const specifierMock = compilePreview(
    basicClientWorkspace(
      "import defaultMock, { namedMock } from 'private-sdk'; globalThis.__specifierMock = [defaultMock.value, namedMock()];",
      [
        importProtectionConfig(
          {
            client: { specifiers: ["private-*"] },
            behavior: "mock",
            mockAccess: "off",
          },
          "development",
        ),
      ],
    ),
  );
  assert.equal(specifierMock.success, true, specifierMock.html);
  assert.equal(
    specifierMock.diagnostics.filter(({ message }) =>
      message.includes("[import-protection] Import denied"),
    ).length,
    1,
  );
  assert.doesNotMatch(specifierMock.html, /private-sdk/);
});

test("validates declarative import-protection configuration", () => {
  const preview = compilePreview(
    basicClientWorkspace("console.log('config');", [
      importProtectionConfig({ client: { files: "**/private/**" } }),
    ]),
  );

  assert.equal(preview.success, false);
  assert.match(
    preview.diagnostics.map(({ message }) => message).join("\n"),
    /client\.files must be an array of glob strings/,
  );
});

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
  assert.ok(Object.keys(preview.serverChunks).length > 0);
  assert.doesNotMatch(preview.serverBundle, /hi /);
  assert.ok(
    Object.entries(preview.serverChunks).some(
      ([name, chunk]) =>
        name.startsWith("chunks/rsc-") && chunk.includes("hi "),
    ),
  );
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
    routeManifest: preview.routeManifest,
    rpcToken: preview.rpcToken,
    ssrClientBundle: preview.ssrClientBundle,
    ssrClientChunks: preview.ssrClientChunks,
    ssrCss: preview.ssrCss,
    ssrCssChunks: preview.ssrCssChunks,
    serverBundle: preview.serverBundle,
    serverChunks: preview.serverChunks,
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
    const clientKernel = (
      globalThis as typeof globalThis &
        Record<
          string,
          { modules?: Record<string, Record<string, unknown>> } | undefined
        >
    )[kernelManifest.client.globalKey];
    const frameworkRscClientReferences = Object.values(
      kernelManifest.rsc.clientReferences,
    );
    assert.ok(frameworkRscClientReferences.length > 0);
    for (const moduleKey of frameworkRscClientReferences) {
      assert.ok(clientKernel?.modules?.[moduleKey]);
    }
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
    assert.deepEqual(observedArtifactCaches, ["durable", "durable"]);
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

test('keeps "use server" implementations in RSC revision chunks', () => {
  const files: WorkspaceFileInput[] = [
    {
      path: "index.html",
      language: "html",
      content: '<script type="module" src="./src/main.ts"></script>',
    },
    {
      path: "src/rsc-action.ts",
      language: "ts",
      content: `'use server';
export async function rscAction(value) {
  return 'rsc-action-implementation-only:' + value;
}`,
    },
    {
      path: "src/main.ts",
      language: "ts",
      content: `import { rscAction } from './rsc-action';
globalThis.__tutoRscAction = rscAction;`,
    },
  ];
  const preview = compilePreview(files);

  assert.equal(preview.success, true);
  assert.doesNotMatch(preview.html, /rsc-action-implementation-only/);
  assert.doesNotMatch(preview.serverBundle, /rsc-action-implementation-only/);
  assert.ok(
    Object.entries(preview.serverChunks).some(
      ([name, chunk]) =>
        name.startsWith("chunks/rsc-") &&
        chunk.includes("rsc-action-implementation-only"),
    ),
  );
  assert.match(preview.html, /tuto-rsc-action-[a-f0-9]{20}/);
});

test("emits CSS imported only by an RSC server module as a Flight resource", () => {
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
      path: "src/rsc-only.css",
      language: "css",
      content: ".rsc-only-resource { color: rgb(71, 82, 93); }",
    },
    {
      path: "src/manual-only.css",
      language: "css",
      content: ".manual-rsc-resource { color: rgb(19, 29, 39); }",
    },
    {
      path: "src/manual-css-anchor.ts",
      language: "ts",
      content: `import './manual-only.css';
export const anchor = true;`,
    },
    {
      path: "src/rsc.tsx",
      language: "tsx",
      content: `import './rsc-only.css';
export default function RscRoot() {
  return <>
    {import.meta.viteRsc.loadCss('./manual-css-anchor')}
    <article className="rsc-only-resource">Pure RSC CSS</article>
  </>;
}`,
    },
  ];
  const preview = compilePreview(files);

  assert.equal(preview.success, true, preview.html);
  assert.doesNotMatch(preview.ssrCss, /rsc-only-resource/);
  assert.equal(
    Object.values(preview.ssrCssChunks).filter(
      (css) =>
        css.includes("rsc-only-resource") ||
        css.includes("manual-rsc-resource"),
    ).length,
    2,
  );
  const rscOutput = Object.values(preview.serverChunks).join("\n");
  assert.match(rscOutput, /data-rsc-css-href/);
  assert.match(rscOutput, /vite-rsc\/importer-resources/);
  assert.match(rscOutput, /kind=style/);
  assert.doesNotMatch(rscOutput, /import\.meta\.viteRsc\.loadCss/);
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
    routeManifest: preview.routeManifest,
    rpcToken: preview.rpcToken,
    ssrClientBundle: preview.ssrClientBundle,
    ssrClientChunks: preview.ssrClientChunks,
    ssrCss: preview.ssrCss,
    ssrCssChunks: preview.ssrCssChunks,
    serverBundle: preview.serverBundle,
    serverChunks: preview.serverChunks,
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
      path: "src/routes/api.hello.ts",
      language: "ts",
      content: `import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute('/api/hello')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('external') === '1') {
          return Response.redirect('https://example.com/outside', 302);
        }
        if (url.searchParams.get('landed') === '1') {
          return Response.json({ landed: true, path: url.pathname });
        }
        return Response.redirect(new URL('/api/hello?landed=1', url), 307);
      },
      POST: async ({ request }) => Response.json({
        body: await request.json(),
        method: request.method,
        source: 'server-route-secret-marker',
      }, {
        status: 201,
        headers: { 'x-server-route': 'native-start' },
      }),
    },
  },
});`,
    },
    {
      path: "src/routes/hello.css",
      language: "css",
      content: `.hello-route { color: rgb(12, 34, 56); }`,
    },
    {
      path: "src/routes/hello.tsx",
      language: "tsx",
      content: `import './hello.css';
import React from 'react';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/hello')({
  loader: async () => ({ message: 'loader rendered on the server' }),
  component: HelloRoute,
});

function HelloRoute() {
  const data = Route.useLoaderData();
  return <h1 className="hello-route" data-ssr="true">{data.message}</h1>;
}`,
    },
    {
      path: "src/router.tsx",
      language: "tsx",
      content: `import React from 'react';
import {
  Outlet,
  Scripts,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { Route as apiRouteImport } from './routes/api.hello';
import { Route as helloRouteImport } from './routes/hello';

const rootRoute = createRootRoute({
  component: () => (
    <html lang="en">
      <head><title>Native Start SSR</title></head>
      <body><main><Outlet /></main><Scripts /></body>
    </html>
  ),
});

const helloRoute = helloRouteImport.update({
  getParentRoute: () => rootRoute,
  id: '/hello',
  path: '/hello',
});

const apiRoute = apiRouteImport.update({
  id: '/api/hello',
  path: '/api/hello',
  getParentRoute: () => rootRoute,
});

const routeTree = rootRoute.addChildren([helloRoute, apiRoute]);

export function getRouter() {
  return createRouter({ routeTree });
}`,
    },
  ];
  const preview = compilePreview(files);

  assert.equal(preview.success, true, preview.html);
  assert.deepEqual(preview.serverFnIds, []);
  assert.ok(preview.serverBundle.length > 0);
  assert.ok(Object.keys(preview.serverChunks).length > 0);
  assert.doesNotMatch(preview.serverBundle, /data-ssr/);
  assert.ok(
    Object.values(preview.serverChunks).some((chunk) =>
      chunk.includes("data-ssr"),
    ),
  );
  assert.ok(preview.ssrClientBundle.length > 0);
  assert.ok(Object.keys(preview.ssrClientChunks).length > 0);
  assert.ok(
    preview.routeManifest["/hello"]?.preloads.length,
    JSON.stringify({
      chunks: Object.keys(preview.ssrClientChunks),
      manifest: preview.routeManifest,
    }),
  );
  assert.ok(preview.routeManifest["/hello"].preloads.length > 1);
  assert.ok(preview.routeManifest["/hello"].css?.length);
  assert.doesNotMatch(preview.ssrCss, /hello-route/);
  assert.ok(
    Object.values(preview.ssrCssChunks).some((chunk) =>
      chunk.includes("hello-route"),
    ),
  );
  putTanstackStartArtifact({
    buildMetrics: preview.buildMetrics,
    diagnostics: [],
    durationMs: 1,
    html: preview.html,
    kernelId: preview.kernelId,
    revision: preview.revision,
    routeManifest: preview.routeManifest,
    rpcToken: preview.rpcToken,
    ssrClientBundle: preview.ssrClientBundle,
    ssrClientChunks: preview.ssrClientChunks,
    ssrCss: preview.ssrCss,
    ssrCssChunks: preview.ssrCssChunks,
    serverBundle: preview.serverBundle,
    serverChunks: preview.serverChunks,
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
    assert.match(html, /kind=chunk/);
    assert.match(html, /kind=style/);
    assert.match(html, /tuto-serverless-preview-log/);

    const routeResponse = await handleNativeRoutePost(
      new Request(
        `http://tuto.local/api/serverless/tanstack-start/core-route?revision=${preview.revision}&token=${preview.rpcToken}&path=%2Fapi%2Fhello`,
        {
          body: JSON.stringify({ name: "Ada" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
    );
    assert.equal(routeResponse.status, 201);
    assert.equal(routeResponse.headers.get("x-server-route"), "native-start");
    assert.equal(routeResponse.headers.get("x-tuto-worker-reused"), "true");
    assert.deepEqual(await routeResponse.json(), {
      body: { name: "Ada" },
      method: "POST",
      source: "server-route-secret-marker",
    });

    const redirectResponse = await handleNativeRouteGet(
      new Request(
        `http://tuto.local/api/serverless/tanstack-start/core-route?revision=${preview.revision}&token=${preview.rpcToken}&path=%2Fapi%2Fhello`,
        { redirect: "manual" },
      ),
    );
    assert.equal(redirectResponse.status, 307);
    const redirectLocation = redirectResponse.headers.get("location");
    assert.ok(redirectLocation);
    const redirectGatewayUrl = new URL(redirectLocation, "http://tuto.local");
    assert.equal(
      redirectGatewayUrl.pathname,
      "/api/serverless/tanstack-start/core-route",
    );
    assert.equal(
      redirectGatewayUrl.searchParams.get("revision"),
      preview.revision,
    );
    assert.equal(
      redirectGatewayUrl.searchParams.get("token"),
      preview.rpcToken,
    );
    assert.equal(
      redirectGatewayUrl.searchParams.get("path"),
      "/api/hello?landed=1",
    );
    const redirectedRouteResponse = await handleNativeRouteGet(
      new Request(redirectGatewayUrl, { redirect: "manual" }),
    );
    assert.equal(redirectedRouteResponse.status, 200);
    assert.deepEqual(await redirectedRouteResponse.json(), {
      landed: true,
      path: "/api/hello",
    });

    const externalRedirectResponse = await handleNativeRouteGet(
      new Request(
        `http://tuto.local/api/serverless/tanstack-start/core-route?revision=${preview.revision}&token=${preview.rpcToken}&path=${encodeURIComponent("/api/hello?external=1")}`,
        { redirect: "manual" },
      ),
    );
    assert.equal(externalRedirectResponse.status, 302);
    assert.equal(
      externalRedirectResponse.headers.get("location"),
      "https://example.com/outside",
    );

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
    assert.match(preview.ssrClientBundle, /tanstack-start\/core-route/);
    assert.match(preview.ssrClientBundle, /input instanceof Request/);
    assert.match(preview.ssrClientBundle, /new Request\(input, init\)/);
    assert.match(preview.ssrClientBundle, /credentials: "include"/);
    assert.doesNotMatch(preview.ssrClientBundle, /data-ssr/);
    assert.doesNotMatch(preview.ssrClientBundle, /server-route-secret-marker/);

    const routePreload = preview.routeManifest["/hello"]?.preloads[0];
    assert.ok(routePreload);
    const routeChunk = await getNativeAsset(
      new Request(new URL(routePreload, "http://tuto.local")),
    );
    assert.equal(routeChunk.status, 200);
    const routeChunkSource = await routeChunk.text();
    assert.match(routeChunkSource, /data-ssr/);
    assert.match(routeChunkSource, /kind=chunk/);
    for (const dependencyPreload of preview.routeManifest[
      "/hello"
    ].preloads.slice(1)) {
      const dependencyChunk = await getNativeAsset(
        new Request(new URL(dependencyPreload, "http://tuto.local")),
      );
      assert.equal(dependencyChunk.status, 200);
    }
    const routeStylesheet = preview.routeManifest["/hello"].css?.[0];
    assert.ok(routeStylesheet);
    const routeStyle = await getNativeAsset(
      new Request(new URL(routeStylesheet, "http://tuto.local")),
    );
    assert.equal(routeStyle.status, 200);
    assert.match(routeStyle.headers.get("content-type") ?? "", /text\/css/);
    assert.match(await routeStyle.text(), /hello-route/);
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
    routeManifest: preview.routeManifest,
    rpcToken: preview.rpcToken,
    ssrClientBundle: preview.ssrClientBundle,
    ssrClientChunks: preview.ssrClientChunks,
    ssrCss: preview.ssrCss,
    ssrCssChunks: preview.ssrCssChunks,
    serverBundle: preview.serverBundle,
    serverChunks: preview.serverChunks,
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
    routeManifest: {},
    rpcToken,
    ssrClientBundle: "",
    ssrClientChunks: {},
    ssrCss: "",
    ssrCssChunks: {},
    serverBundle: "",
    serverChunks: {},
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

test("native RPC reports a lazy durable source failure as unavailable", async () => {
  const revision = "1".repeat(64);
  const serverFnId = "2".repeat(64);
  const rpcToken = "s".repeat(43);
  const serverSource = "export const unreachable = true;";
  const metadata = {
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
    kernelId: kernelManifest.id,
    revision,
    routeManifest: {},
    rpcToken,
    serverFnIds: [serverFnId],
    success: true,
  };
  clearTanstackStartArtifactCache();
  clearNativeRpcWorkerPoolForTests();
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
          kernelId: metadata.kernelId,
          revision,
          serverBundle: "",
          serverChunks: {},
          serverSources: {
            chunks: {},
            entry: {
              bytes: Buffer.byteLength(serverSource),
              hash: createHash("sha256").update(serverSource).digest("hex"),
              async stream() {
                throw new Error("object stream offline");
              },
            },
          },
        },
      };
    },
    async put() {},
  });

  try {
    const response = await handleNativeRpc(
      new Request(
        `http://tuto.local/api/serverless/tanstack-start/core-rpc?revision=${revision}&token=${rpcToken}&id=${serverFnId}`,
        { method: "POST" },
      ),
    );
    assert.equal(response.status, 503);
    assert.match(await response.text(), /shared artifact storage is unavailable/i);
  } finally {
    clearNativeRpcWorkerPoolForTests();
    setTanstackStartArtifactStoreForTests(undefined);
  }
});
