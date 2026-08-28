"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var import_node_url = require("node:url");
var import_kernel_manifest_generated = __toESM(require("./kernel-manifest.generated.json"));
const handlerKey = "__TUTO_TANSTACK_START_NATIVE_HANDLER__";
const rscHandlerKey = "__TUTO_TANSTACK_START_RSC_HANDLER__";
const activeStreams = /* @__PURE__ */ new Map();
let handler;
let maxResponseBytes = 3e6;
let runtimeEntryPath;
let revision;
let executionQueue = Promise.resolve();
let shuttingDown = false;
function send(message) {
  process.send?.(message);
}
function errorMessage(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
    stack: error instanceof Error ? error.stack : void 0
  };
}
async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  delete globalThis[handlerKey];
  delete globalThis[rscHandlerKey];
  delete globalThis[import_kernel_manifest_generated.default.rsc.globalKey];
  delete globalThis[import_kernel_manifest_generated.default.server.globalKey];
  delete globalThis[import_kernel_manifest_generated.default.server.resolverKey];
  delete globalThis[import_kernel_manifest_generated.default.server.startInstanceKey];
  delete globalThis[import_kernel_manifest_generated.default.server.routerKey];
  delete globalThis[import_kernel_manifest_generated.default.server.manifestKey];
  delete globalThis[import_kernel_manifest_generated.default.server.rscLoaderKey];
}
async function initialize(command) {
  if (handler || runtimeEntryPath) {
    throw new Error("The native RPC worker is already initialized.");
  }
  if (command.runtime.kernelId !== import_kernel_manifest_generated.default.id) {
    throw new Error(
      `Unknown TanStack Start server kernel: ${command.runtime.kernelId}`
    );
  }
  if (!/^[a-f0-9]{64}$/.test(command.runtime.revision)) {
    throw new Error("Invalid TanStack Start artifact revision.");
  }
  if (!/^[a-f0-9]{64}$/.test(command.runtime.entryHash)) {
    throw new Error("Invalid TanStack Start runtime entry hash.");
  }
  if (!import_node_path.default.isAbsolute(command.runtime.entryPath)) {
    throw new Error("TanStack Start runtime entry path must be absolute.");
  }
  maxResponseBytes = command.maxResponseBytes;
  revision = command.runtime.revision;
  runtimeEntryPath = await (0, import_promises.realpath)(command.runtime.entryPath);
  const runtimeStat = await (0, import_promises.stat)(runtimeEntryPath);
  if (!runtimeStat.isFile() || import_node_path.default.basename(runtimeEntryPath) !== "entry.mjs") {
    throw new Error("Invalid TanStack Start runtime entry file.");
  }
  const entrySource = await (0, import_promises.readFile)(runtimeEntryPath);
  const entryHash = (0, import_node_crypto.createHash)("sha256").update(entrySource).digest("hex");
  if (entryHash !== command.runtime.entryHash) {
    throw new Error("TanStack Start runtime entry failed integrity validation.");
  }
  const kernelPath = import_node_path.default.resolve(
    process.cwd(),
    "lib",
    "serverless-tanstack-start",
    import_kernel_manifest_generated.default.server.file
  );
  const rscKernelPath = import_node_path.default.resolve(
    process.cwd(),
    "lib",
    "serverless-tanstack-start",
    import_kernel_manifest_generated.default.rsc.file
  );
  await import((0, import_node_url.pathToFileURL)(kernelPath).href);
  await import((0, import_node_url.pathToFileURL)(rscKernelPath).href);
  await import((0, import_node_url.pathToFileURL)(runtimeEntryPath).href);
  const startHandler = globalThis[handlerKey];
  if (typeof startHandler !== "function") {
    throw new Error(
      "The compiled artifact did not register a Start request handler."
    );
  }
  handler = (request, options) => {
    const rscHandler = globalThis[rscHandlerKey];
    if (new URL(request.url).pathname === import_kernel_manifest_generated.default.rsc.internalPath && typeof rscHandler === "function") {
      return rscHandler(request, options);
    }
    return startHandler(request, options);
  };
  send({ pid: process.pid, revision, type: "ready" });
}
function toRequest(payload, signal) {
  const method = payload.method.toUpperCase();
  const url = new URL(payload.url);
  if (payload.serverFnId) {
    url.pathname = `${import_kernel_manifest_generated.default.server.serverFnBase}${encodeURIComponent(
      payload.serverFnId
    )}`;
    url.searchParams.delete("id");
    url.searchParams.delete("revision");
    url.searchParams.delete("token");
  }
  const body = payload.bodyBase64 ? Buffer.from(payload.bodyBase64, "base64") : void 0;
  return new Request(url, {
    method,
    headers: payload.headers,
    body: method === "GET" || method === "HEAD" ? void 0 : body,
    signal
  });
}
function responseHeaderEntries(headers) {
  const entries = [...headers.entries()].filter(
    ([name]) => name.toLowerCase() !== "set-cookie"
  );
  const setCookies = headers.getSetCookie?.();
  const fallbackSetCookie = headers.get("set-cookie");
  for (const cookie of setCookies ?? (fallbackSetCookie ? [fallbackSetCookie] : [])) {
    entries.push(["set-cookie", cookie]);
  }
  return entries;
}
async function execute(command) {
  if (!handler) throw new Error("The native RPC worker is not initialized.");
  const abortController = new AbortController();
  if (command.request.streamResponse) {
    activeStreams.set(command.id, { abortController });
  }
  let response;
  try {
    response = await handler(
      toRequest(command.request, abortController.signal),
      {
        context: {}
      }
    );
  } catch (error) {
    activeStreams.delete(command.id);
    throw error;
  }
  const responseHead = {
    headers: responseHeaderEntries(response.headers),
    status: response.status,
    statusText: response.statusText
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
          type: "stream-chunk"
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
  const result = {
    bodyBase64: responseBuffer.toString("base64"),
    ...responseHead
  };
  send({ id: command.id, result, type: "result" });
}
async function handleCommand(command) {
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
process.on("message", (message) => {
  if (message.type === "cancel") {
    void handleCommand(message);
    return;
  }
  executionQueue = executionQueue.then(() => handleCommand(message)).catch(async (error) => {
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
    "TanStack native RPC worker requires a Node IPC channel.\n"
  );
  process.exitCode = 1;
}
