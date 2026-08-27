import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import kernelManifest from "./kernel-manifest.generated.json";
import type {
  NativeRpcRequest,
  NativeRpcResult,
  NativeWorkerCommand,
  NativeWorkerMessage,
} from "./native-rpc-protocol";

type NativeHandler = (
  request: Request,
  options?: { context?: unknown },
) => Promise<Response>;

const handlerKey = "__TUTO_TANSTACK_START_NATIVE_HANDLER__";
let handler: NativeHandler | undefined;
let maxResponseBytes = 3_000_000;
let runtimeDirectory: string | undefined;
let revision: string | undefined;
let executionQueue = Promise.resolve();
let shuttingDown = false;

function send(message: NativeWorkerMessage) {
  process.send?.(message);
}

function errorMessage(error: unknown) {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
    stack: error instanceof Error ? error.stack : undefined,
  };
}

async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  delete (globalThis as typeof globalThis & Record<string, unknown>)[
    handlerKey
  ];
  delete (globalThis as typeof globalThis & Record<string, unknown>)[
    kernelManifest.server.globalKey
  ];
  delete (globalThis as typeof globalThis & Record<string, unknown>)[
    kernelManifest.server.resolverKey
  ];
  delete (globalThis as typeof globalThis & Record<string, unknown>)[
    kernelManifest.server.startInstanceKey
  ];
  delete (globalThis as typeof globalThis & Record<string, unknown>)[
    kernelManifest.server.routerKey
  ];
  delete (globalThis as typeof globalThis & Record<string, unknown>)[
    kernelManifest.server.manifestKey
  ];
  if (runtimeDirectory) {
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
}

async function initialize(
  command: Extract<NativeWorkerCommand, { type: "initialize" }>,
) {
  if (handler || runtimeDirectory) {
    throw new Error("The native RPC worker is already initialized.");
  }
  if (command.artifact.kernelId !== kernelManifest.id) {
    throw new Error(
      `Unknown TanStack Start server kernel: ${command.artifact.kernelId}`,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(command.artifact.revision)) {
    throw new Error("Invalid TanStack Start artifact revision.");
  }

  maxResponseBytes = command.maxResponseBytes;
  revision = command.artifact.revision;
  runtimeDirectory = await mkdtemp(
    path.join(tmpdir(), "tuto-start-rpc-worker-"),
  );
  const runtimePath = path.join(runtimeDirectory, "artifact.mjs");
  const kernelPath = path.resolve(
    process.cwd(),
    "lib",
    "serverless-tanstack-start",
    kernelManifest.server.file,
  );
  await writeFile(runtimePath, command.artifact.serverBundle, "utf8");
  await import(pathToFileURL(kernelPath).href);
  await import(pathToFileURL(runtimePath).href);
  handler = (globalThis as typeof globalThis & Record<string, unknown>)[
    handlerKey
  ] as NativeHandler | undefined;
  if (typeof handler !== "function") {
    throw new Error(
      "The compiled artifact did not register a Start request handler.",
    );
  }

  send({ pid: process.pid, revision, type: "ready" });
}

function toRequest(payload: NativeRpcRequest) {
  const method = payload.method.toUpperCase();
  const url = new URL(payload.url);
  if (payload.serverFnId) {
    url.pathname = `${kernelManifest.server.serverFnBase}${encodeURIComponent(
      payload.serverFnId,
    )}`;
    url.searchParams.delete("id");
    url.searchParams.delete("revision");
    url.searchParams.delete("token");
  }
  const body = payload.bodyBase64
    ? Buffer.from(payload.bodyBase64, "base64")
    : undefined;
  return new Request(url, {
    method,
    headers: payload.headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
}

function responseHeaderEntries(headers: Headers) {
  const entries = [...headers.entries()].filter(
    ([name]) => name.toLowerCase() !== "set-cookie",
  );
  const setCookies = (
    headers as Headers & { getSetCookie?: () => Array<string> }
  ).getSetCookie?.();
  const fallbackSetCookie = headers.get("set-cookie");

  for (const cookie of setCookies ??
    (fallbackSetCookie ? [fallbackSetCookie] : [])) {
    entries.push(["set-cookie", cookie]);
  }

  return entries;
}

async function execute(
  command: Extract<NativeWorkerCommand, { type: "execute" }>,
) {
  if (!handler) throw new Error("The native RPC worker is not initialized.");
  const response = await handler(toRequest(command.request), { context: {} });
  const responseBuffer = Buffer.from(await response.arrayBuffer());
  if (responseBuffer.byteLength > maxResponseBytes) {
    throw new Error("TanStack server function response is too large.");
  }
  const result: NativeRpcResult = {
    bodyBase64: responseBuffer.toString("base64"),
    headers: responseHeaderEntries(response.headers),
    status: response.status,
    statusText: response.statusText,
  };
  send({ id: command.id, result, type: "result" });
}

async function handleCommand(command: NativeWorkerCommand) {
  if (command.type === "initialize") {
    await initialize(command);
    return;
  }
  if (command.type === "shutdown") {
    await cleanup();
    process.disconnect();
    return;
  }
  if (command.type === "execute") {
    try {
      await execute(command);
    } catch (error) {
      send({ error: errorMessage(error), id: command.id, type: "error" });
    }
  }
}

process.on("message", (message: NativeWorkerCommand) => {
  executionQueue = executionQueue
    .then(() => handleCommand(message))
    .catch(async (error) => {
      send({ error: errorMessage(error), fatal: true, type: "error" });
      await cleanup();
      process.exitCode = 1;
      process.disconnect();
    });
});

process.once("disconnect", () => {
  void cleanup().finally(() => process.exit());
});

process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit());
});

process.once("SIGINT", () => {
  void cleanup().finally(() => process.exit());
});

if (!process.send) {
  process.stderr.write(
    "TanStack native RPC worker requires a Node IPC channel.\n",
  );
  process.exitCode = 1;
}
