import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
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
const rscHandlerKey = "__TUTO_TANSTACK_START_RSC_HANDLER__";
const activeStreams = new Map<
  string,
  {
    abortController: AbortController;
    reader?: ReadableStreamDefaultReader<Uint8Array>;
  }
>();
let handler: NativeHandler | undefined;
let maxResponseBytes = 3_000_000;
let runtimeEntryPath: string | undefined;
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
    rscHandlerKey
  ];
  delete (globalThis as typeof globalThis & Record<string, unknown>)[
    kernelManifest.rsc.globalKey
  ];
  delete (globalThis as typeof globalThis & Record<string, unknown>)[
    kernelManifest.rsc.actionEncryptionKeyGlobalKey
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
  delete (globalThis as typeof globalThis & Record<string, unknown>)[
    kernelManifest.server.rscLoaderKey
  ];
}

async function initialize(
  command: Extract<NativeWorkerCommand, { type: "initialize" }>,
) {
  if (handler || runtimeEntryPath) {
    throw new Error("The native RPC worker is already initialized.");
  }
  if (command.runtime.kernelId !== kernelManifest.id) {
    throw new Error(
      `Unknown TanStack Start server kernel: ${command.runtime.kernelId}`,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(command.runtime.revision)) {
    throw new Error("Invalid TanStack Start artifact revision.");
  }
  if (!/^[a-f0-9]{64}$/.test(command.runtime.entryHash)) {
    throw new Error("Invalid TanStack Start runtime entry hash.");
  }
  if (!path.isAbsolute(command.runtime.entryPath)) {
    throw new Error("TanStack Start runtime entry path must be absolute.");
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(command.rscActionEncryptionKey)) {
    throw new Error("Invalid TanStack Start RSC action encryption key.");
  }
  const actionEncryptionKeyBytes = Buffer.from(
    command.rscActionEncryptionKey,
    "base64",
  );
  if (
    actionEncryptionKeyBytes.byteLength !== 32 ||
    actionEncryptionKeyBytes.toString("base64") !==
      command.rscActionEncryptionKey
  ) {
    throw new Error("Invalid TanStack Start RSC action encryption key.");
  }

  maxResponseBytes = command.maxResponseBytes;
  revision = command.runtime.revision;
  runtimeEntryPath = await realpath(command.runtime.entryPath);
  const runtimeStat = await stat(runtimeEntryPath);
  if (!runtimeStat.isFile() || path.basename(runtimeEntryPath) !== "entry.mjs") {
    throw new Error("Invalid TanStack Start runtime entry file.");
  }
  const entrySource = await readFile(runtimeEntryPath);
  const entryHash = createHash("sha256").update(entrySource).digest("hex");
  if (entryHash !== command.runtime.entryHash) {
    throw new Error("TanStack Start runtime entry failed integrity validation.");
  }
  const kernelPath = path.resolve(
    process.cwd(),
    "lib",
    "serverless-tanstack-start",
    kernelManifest.server.file,
  );
  const rscKernelPath = path.resolve(
    process.cwd(),
    "lib",
    "serverless-tanstack-start",
    kernelManifest.rsc.file,
  );
  (
    globalThis as typeof globalThis & Record<string, unknown>
  )[kernelManifest.rsc.actionEncryptionKeyGlobalKey] =
    command.rscActionEncryptionKey;
  await import(pathToFileURL(kernelPath).href);
  await import(pathToFileURL(rscKernelPath).href);
  await import(pathToFileURL(runtimeEntryPath).href);
  const startHandler = (
    globalThis as typeof globalThis & Record<string, unknown>
  )[
    handlerKey
  ] as NativeHandler | undefined;
  if (typeof startHandler !== "function") {
    throw new Error(
      "The compiled artifact did not register a Start request handler.",
    );
  }
  handler = (request, options) => {
    const rscHandler = (
      globalThis as typeof globalThis & Record<string, unknown>
    )[rscHandlerKey] as NativeHandler | undefined;
    const pathname = new URL(request.url).pathname;
    if (
      (pathname === kernelManifest.rsc.internalPath ||
        pathname === kernelManifest.rsc.actionInternalPath) &&
      typeof rscHandler === "function"
    ) {
      return rscHandler(request, options);
    }
    return startHandler(request, options);
  };

  send({ pid: process.pid, revision, type: "ready" });
}

function toRequest(payload: NativeRpcRequest, signal?: AbortSignal) {
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
    signal,
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
  const abortController = new AbortController();
  if (command.request.streamResponse) {
    activeStreams.set(command.id, { abortController });
  }
  let response: Response;
  try {
    response = await handler(
      toRequest(command.request, abortController.signal),
      {
        context: {},
      },
    );
  } catch (error) {
    activeStreams.delete(command.id);
    throw error;
  }
  const responseHead = {
    headers: responseHeaderEntries(response.headers),
    status: response.status,
    statusText: response.statusText,
  };

  if (command.request.streamResponse) {
    send({ id: command.id, response: responseHead, type: "stream-start" });
    if (!response.body) {
      activeStreams.delete(command.id);
      send({ id: command.id, type: "stream-end" });
      return;
    }

    const reader = response.body.getReader();
    const active = activeStreams.get(command.id);
    if (active) active.reader = reader;
    let responseBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        responseBytes += value.byteLength;
        if (responseBytes > maxResponseBytes) {
          throw new Error("TanStack streamed response is too large.");
        }
        send({
          bodyBase64: Buffer.from(value).toString("base64"),
          id: command.id,
          type: "stream-chunk",
        });
      }
      send({ id: command.id, type: "stream-end" });
    } finally {
      activeStreams.delete(command.id);
      reader.releaseLock();
    }
    return;
  }

  const responseBuffer = Buffer.from(await response.arrayBuffer());
  if (responseBuffer.byteLength > maxResponseBytes) {
    throw new Error("TanStack server function response is too large.");
  }
  const result: NativeRpcResult = {
    bodyBase64: responseBuffer.toString("base64"),
    ...responseHead,
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
  if (command.type === "cancel") {
    const active = activeStreams.get(command.id);
    active?.abortController.abort("Response stream cancelled by host.");
    await active?.reader?.cancel("Response stream cancelled by host.");
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
  if (message.type === "cancel") {
    void handleCommand(message);
    return;
  }
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
