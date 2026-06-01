import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "vitest";
import {
  transformStartServerFunctions,
  type StartServerFunctionsTransform,
} from "../../lib/serverless-tanstack-start/server-functions-transform";

type WorkspaceFileMap = Map<string, string>;

type WorkspaceFileInput = {
  content: string;
  language: "ts" | "tsx";
  path: string;
};

type SerializedFormData = {
  __tutoType: "FormData";
  entries: Array<
    [
      string,
      { kind: "string"; value: string } | { kind: "file"; name?: string; text?: string; type?: string },
    ]
  >;
};

type RpcPayload =
  | Record<string, unknown>
  | {
      data: SerializedFormData;
    };

type CoreRpcResult = {
  context?: unknown;
  control?: unknown;
  error?: string;
  result?: unknown;
  success: boolean;
};

function createRoot(name: string) {
  return path.join(process.cwd(), ".tmp", "server-functions-transform-tests", name);
}

function toWorkspaceFiles(files: WorkspaceFileMap): WorkspaceFileInput[] {
  return [...files.entries()].map(([filePath, content]) => ({
    path: filePath,
    language: filePath.endsWith(".tsx") ? "tsx" : "ts",
    content,
  }));
}

function runCoreRpc({
  files,
  id,
  payload,
}: {
  files: WorkspaceFileMap;
  id: string;
  payload: RpcPayload;
}): CoreRpcResult {
  const child = spawnSync(
    process.execPath,
    ["lib/serverless-tanstack-start/core-rpc-runner.generated.cjs"],
    {
      cwd: process.cwd(),
      input: JSON.stringify({
        id,
        payload,
        files: toWorkspaceFiles(files),
      }),
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  const match = child.stdout.match(
    /__TUTO_TANSTACK_START_CORE_RPC_RESULT_START__\n([\s\S]*?)\n__TUTO_TANSTACK_START_CORE_RPC_RESULT_END__/,
  );

  if (!match) {
    throw new Error(child.stderr || child.stdout || "Missing RPC result payload.");
  }

  return JSON.parse(match[1]) as CoreRpcResult;
}

async function transformFiles(files: WorkspaceFileMap, name: string) {
  return transformStartServerFunctions(files, {
    root: createRoot(name),
  });
}

function firstServerFnId(transform: StartServerFunctionsTransform) {
  const [serverFnId] = Object.keys(transform.serverFnsById);
  assert.ok(serverFnId, "expected one server function id");
  return serverFnId;
}

function getFile(map: WorkspaceFileMap, filePath: string) {
  const code = map.get(filePath);

  assert.ok(code, `expected generated code for ${filePath}`);

  return code;
}

function getSplitEntry(transform: StartServerFunctionsTransform) {
  const [entry] = [...transform.serverSplits.entries()];

  assert.ok(entry, "expected one server split entry");

  return entry;
}

test("leaves plain modules without creating server function manifest entries", async () => {
  const files: WorkspaceFileMap = new Map([
    [
      "src/routes/index.tsx",
      "export function RouteComponent() { return <main>No server function</main>; }",
    ],
  ]);

  const result = await transformFiles(files, "plain");

  assert.deepEqual(Object.keys(result.serverFnsById), []);
  assert.equal(result.serverSplits.size, 0);
  assert.match(getFile(result.clientFiles, "src/routes/index.tsx"), /No server function/);
  assert.match(result.resolverModule, /const manifest = \{\n\};/);
});

test("rewrites createServerFn handlers into client RPC stubs and server split exports", async () => {
  const files: WorkspaceFileMap = new Map([
    [
      "src/routes/index.tsx",
      `import { createServerFn } from '@tanstack/react-start';

export const greet = createServerFn({ method: 'POST' }).handler(async ({ data }) => {
  return { message: 'hi ' + data.name };
});

export async function runGreeting() {
  return greet({ data: { name: 'Ada' } });
}
`,
    ],
  ]);

  const result = await transformFiles(files, "basic-server-fn");
  const serverFnIds = Object.keys(result.serverFnsById);
  const clientCode = getFile(result.clientFiles, "src/routes/index.tsx");
  const splitEntry = getSplitEntry(result);

  assert.equal(serverFnIds.length, 1);
  assert.match(clientCode, /@tanstack\/react-start\/client-rpc/);
  assert.match(clientCode, /createClientRpc\("[a-f0-9]{64}"\)/);
  assert.doesNotMatch(clientCode, /message: 'hi '/);
  assert.equal(result.serverSplits.size, 1);
  assert.equal(splitEntry[0], "src/routes/index.tsx?tss-serverfn-split");
  assert.match(splitEntry[1], /@tanstack\/react-start\/server-rpc/);
  assert.match(splitEntry[1], /export \{ greet_createServerFn_handler \};/);
  assert.match(result.resolverModule, new RegExp(serverFnIds[0]));
  assert.match(result.resolverModule, /module: "src\/routes\/index\.tsx\?tss-serverfn-split"/);
});

test("executes inputValidator before the server function handler", async () => {
  const files: WorkspaceFileMap = new Map([
    [
      "src/routes/index.tsx",
      `import { createServerFn } from '@tanstack/react-start';

export const greet = createServerFn({ method: 'POST' })
  .inputValidator((data) => {
    if (!data || typeof data.name !== 'string') {
      throw new Error('name is required');
    }

    return { name: data.name.trim().toUpperCase() };
  })
  .handler(async ({ data }) => {
    return 'hi ' + data.name;
  });
`,
    ],
  ]);
  const transform = await transformFiles(files, "input-validator");
  const serverFnId = firstServerFnId(transform);

  const success = runCoreRpc({
    files,
    id: serverFnId,
    payload: { data: { name: " ada " } },
  });
  const failure = runCoreRpc({
    files,
    id: serverFnId,
    payload: { data: {} },
  });

  assert.equal(success.success, true);
  assert.equal(success.result, "hi ADA");
  assert.equal(failure.success, false);
  assert.match(failure.error ?? "", /name is required/);
});

test("passes method metadata into the server function handler", async () => {
  const files: WorkspaceFileMap = new Map([
    [
      "src/routes/index.tsx",
      `import { createServerFn } from '@tanstack/react-start';

export const methodName = createServerFn({ method: 'GET' }).handler(async ({ method }) => {
  return method;
});
`,
    ],
  ]);
  const transform = await transformFiles(files, "method-metadata");
  const result = runCoreRpc({
    files,
    id: firstServerFnId(transform),
    payload: {},
  });

  assert.equal(result.success, true);
  assert.equal(result.result, "GET");
});

test("keeps server function ids stable for unchanged path and export name", async () => {
  const source = `import { createServerFn } from '@tanstack/react-start';

export const greet = createServerFn({ method: 'POST' }).handler(async () => 'hi');
`;
  const first = await transformFiles(new Map([["src/routes/index.tsx", source]]), "stable-id-a");
  const second = await transformFiles(new Map([["src/routes/index.tsx", source]]), "stable-id-b");
  const renamed = await transformFiles(
    new Map([
      [
        "src/routes/index.tsx",
        source.replace("export const greet", "export const renamedGreet"),
      ],
    ]),
    "stable-id-renamed",
  );
  const moved = await transformFiles(new Map([["src/routes/other.tsx", source]]), "stable-id-moved");

  assert.equal(firstServerFnId(first), firstServerFnId(second));
  assert.notEqual(firstServerFnId(first), firstServerFnId(renamed));
  assert.notEqual(firstServerFnId(first), firstServerFnId(moved));
});

test("executes server functions declared in imported workspace modules", async () => {
  const files: WorkspaceFileMap = new Map([
    [
      "src/lib/actions.ts",
      `import { createServerFn } from '@tanstack/react-start';

export const greet = createServerFn({ method: 'POST' }).handler(async ({ data }) => {
  return 'hi ' + data.name;
});
`,
    ],
    [
      "src/routes/index.tsx",
      `import { greet } from '../lib/actions';

export async function callGreeting() {
  return greet({ data: { name: 'Ada' } });
}
`,
    ],
  ]);
  const transform = await transformFiles(files, "imported-server-fn");
  const result = runCoreRpc({
    files,
    id: firstServerFnId(transform),
    payload: { data: { name: "Ada" } },
  });

  assert.equal(result.success, true);
  assert.equal(result.result, "hi Ada");
});

test("returns thrown server function errors through the RPC error channel", async () => {
  const files: WorkspaceFileMap = new Map([
    [
      "src/routes/index.tsx",
      `import { createServerFn } from '@tanstack/react-start';

export const fail = createServerFn({ method: 'POST' }).handler(async () => {
  throw new Error('boom');
});
`,
    ],
  ]);
  const transform = await transformFiles(files, "error-channel");
  const result = runCoreRpc({
    files,
    id: firstServerFnId(transform),
    payload: {},
  });

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /boom/);
});

test("serializes thrown redirects through the RPC control channel", async () => {
  const files: WorkspaceFileMap = new Map([
    [
      "src/routes/index.tsx",
      `import { createServerFn } from '@tanstack/react-start';
import { redirect } from '@tanstack/react-router';

export const goLogin = createServerFn({ method: 'POST' }).handler(async () => {
  throw redirect({
    href: '/login',
    statusCode: 302,
    headers: { 'x-reason': 'auth' },
  });
});
`,
    ],
  ]);
  const transform = await transformFiles(files, "redirect-control");
  const result = runCoreRpc({
    files,
    id: firstServerFnId(transform),
    payload: {},
  });

  assert.equal(result.success, false);
  assert.deepEqual(result.control, {
    type: "redirect",
    href: "/login",
    options: {
      href: "/login",
      reloadDocument: false,
      statusCode: 302,
    },
    headers: {
      location: "/login",
      "x-reason": "auth",
    },
    status: 302,
  });
});

test("serializes thrown notFound values through the RPC control channel", async () => {
  const files: WorkspaceFileMap = new Map([
    [
      "src/routes/index.tsx",
      `import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';

export const missing = createServerFn({ method: 'POST' }).handler(async () => {
  throw notFound({ data: { postId: 'missing-post' } });
});
`,
    ],
  ]);
  const transform = await transformFiles(files, "not-found-control");
  const result = runCoreRpc({
    files,
    id: firstServerFnId(transform),
    payload: {},
  });

  assert.equal(result.success, false);
  assert.deepEqual(result.control, {
    type: "notFound",
    data: { postId: "missing-post" },
  });
});

test("runs server middleware before the handler and merges context", async () => {
  const files: WorkspaceFileMap = new Map([
    [
      "src/routes/index.tsx",
      `import { createMiddleware, createServerFn } from '@tanstack/react-start';

const authMiddleware = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  return next({ context: { userId: 'user-1' } });
});

export const getUserId = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return context.userId;
  });
`,
    ],
  ]);
  const transform = await transformFiles(files, "middleware-context");
  const result = runCoreRpc({
    files,
    id: firstServerFnId(transform),
    payload: {},
  });

  assert.equal(result.success, true);
  assert.equal(result.result, "user-1");
});

test("allows server middleware to return Response without running handler", async () => {
  const files: WorkspaceFileMap = new Map([
    [
      "src/routes/index.tsx",
      `import { createMiddleware, createServerFn } from '@tanstack/react-start';

const denyMiddleware = createMiddleware({ type: 'function' }).server(async () => {
  return new Response('denied', {
    status: 401,
    headers: { 'x-auth': 'required' },
  });
});

export const guarded = createServerFn({ method: 'POST' })
  .middleware([denyMiddleware])
  .handler(async () => {
    return 'unexpected';
  });
`,
    ],
  ]);
  const transform = await transformFiles(files, "middleware-response");
  const result = runCoreRpc({
    files,
    id: firstServerFnId(transform),
    payload: {},
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.result, {
    __tutoType: "Response",
    body: "denied",
    headers: { "content-type": "text/plain;charset=UTF-8", "x-auth": "required" },
    status: 401,
    statusText: "",
  });
});

test("serializes Response results across the RPC boundary", async () => {
  const files: WorkspaceFileMap = new Map([
    [
      "src/routes/index.tsx",
      `import { createServerFn } from '@tanstack/react-start';

export const responseFn = createServerFn({ method: 'POST' }).handler(async () => {
  return new Response('created', {
    status: 201,
    headers: { 'x-source': 'server-fn' },
  });
});
`,
    ],
  ]);
  const transform = await transformFiles(files, "response-result");
  const result = runCoreRpc({
    files,
    id: firstServerFnId(transform),
    payload: {},
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.result, {
    __tutoType: "Response",
    body: "created",
    headers: { "content-type": "text/plain;charset=UTF-8", "x-source": "server-fn" },
    status: 201,
    statusText: "",
  });
});

test("revives FormData payloads before calling the server function handler", async () => {
  const files: WorkspaceFileMap = new Map([
    [
      "src/routes/index.tsx",
      `import { createServerFn } from '@tanstack/react-start';

export const readForm = createServerFn({ method: 'POST' }).handler(async ({ data }) => {
  return {
    title: data.get('title'),
    count: data.getAll('tag').length,
  };
});
`,
    ],
  ]);
  const transform = await transformFiles(files, "form-data");
  const result = runCoreRpc({
    files,
    id: firstServerFnId(transform),
    payload: {
      data: {
        __tutoType: "FormData",
        entries: [
          ["title", { kind: "string", value: "Hello" }],
          ["tag", { kind: "string", value: "a" }],
          ["tag", { kind: "string", value: "b" }],
        ],
      },
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.result, { title: "Hello", count: 2 });
});
