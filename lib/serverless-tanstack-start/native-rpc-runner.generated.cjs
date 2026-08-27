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
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = __toESM(require("node:path"));
var import_node_url = require("node:url");
var import_kernel_manifest_generated = __toESM(require("./kernel-manifest.generated.json"));
const handlerKey = "__TUTO_TANSTACK_START_NATIVE_HANDLER__";
let handler;
let maxResponseBytes = 3e6;
let runtimeDirectory;
let revision;
let executionQueue = Promise.resolve();
let shuttingDown = false;
function send(message) {
  process.send?.(message);
}
function errorMessage(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error"
  };
}
async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  delete globalThis[handlerKey];
  delete globalThis[import_kernel_manifest_generated.default.server.globalKey];
  delete globalThis[import_kernel_manifest_generated.default.server.resolverKey];
  delete globalThis[import_kernel_manifest_generated.default.server.startInstanceKey];
  if (runtimeDirectory) {
    await (0, import_promises.rm)(runtimeDirectory, { force: true, recursive: true });
  }
}
async function initialize(command) {
  if (handler || runtimeDirectory) {
    throw new Error("The native RPC worker is already initialized.");
  }
  if (command.artifact.kernelId !== import_kernel_manifest_generated.default.id) {
    throw new Error(
      `Unknown TanStack Start server kernel: ${command.artifact.kernelId}`
    );
  }
  if (!/^[a-f0-9]{64}$/.test(command.artifact.revision)) {
    throw new Error("Invalid TanStack Start artifact revision.");
  }
  maxResponseBytes = command.maxResponseBytes;
  revision = command.artifact.revision;
  runtimeDirectory = await (0, import_promises.mkdtemp)(
    import_node_path.default.join((0, import_node_os.tmpdir)(), "tuto-start-rpc-worker-")
  );
  const runtimePath = import_node_path.default.join(runtimeDirectory, "artifact.mjs");
  const kernelPath = import_node_path.default.resolve(
    process.cwd(),
    "lib",
    "serverless-tanstack-start",
    import_kernel_manifest_generated.default.server.file
  );
  await (0, import_promises.writeFile)(runtimePath, command.artifact.serverBundle, "utf8");
  await import((0, import_node_url.pathToFileURL)(kernelPath).href);
  await import((0, import_node_url.pathToFileURL)(runtimePath).href);
  handler = globalThis[handlerKey];
  if (typeof handler !== "function") {
    throw new Error(
      "The compiled artifact did not register a Start request handler."
    );
  }
  send({ pid: process.pid, revision, type: "ready" });
}
function toRequest(payload) {
  const method = payload.method.toUpperCase();
  const url = new URL(payload.url);
  url.pathname = `${import_kernel_manifest_generated.default.server.serverFnBase}${encodeURIComponent(
    payload.serverFnId
  )}`;
  url.searchParams.delete("id");
  url.searchParams.delete("revision");
  url.searchParams.delete("token");
  const body = payload.bodyBase64 ? Buffer.from(payload.bodyBase64, "base64") : void 0;
  return new Request(url, {
    method,
    headers: payload.headers,
    body: method === "GET" || method === "HEAD" ? void 0 : body
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
  const response = await handler(toRequest(command.request), { context: {} });
  const responseBuffer = Buffer.from(await response.arrayBuffer());
  if (responseBuffer.byteLength > maxResponseBytes) {
    throw new Error("TanStack server function response is too large.");
  }
  const result = {
    bodyBase64: responseBuffer.toString("base64"),
    headers: responseHeaderEntries(response.headers),
    status: response.status,
    statusText: response.statusText
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
  if (command.type === "execute") {
    try {
      await execute(command);
    } catch (error) {
      send({ error: errorMessage(error), id: command.id, type: "error" });
    }
  }
}
process.on("message", (message) => {
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
