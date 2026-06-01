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
var import_node_path = __toESM(require("node:path"));
var import_esbuild = require("esbuild");
var import_server_functions_transform = require("./server-functions-transform.generated.cjs");
const resultStartMarker = "__TUTO_TANSTACK_START_CORE_RPC_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_RPC_RESULT_END__";
const maxFileCount = 64;
const maxFileSize = 22e4;
const maxTotalSize = 125e4;
const absoluteWorkingDirectory = process.cwd();
const globalResultStore = globalThis;
function createDiagnostic(level, message) {
  return {
    id: (0, import_node_crypto.randomUUID)(),
    level,
    message,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function normalizeWorkspacePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\/+/, "");
}
function sanitizeWorkspaceFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("At least one file is required.");
  }
  if (files.length > maxFileCount) {
    throw new Error("Too many files for the TanStack Start core RPC runner.");
  }
  const map = /* @__PURE__ */ new Map();
  let totalSize = 0;
  for (const file of files) {
    const normalizedPath = normalizeWorkspacePath(file.path);
    if (!normalizedPath || normalizedPath.includes("..") || normalizedPath.startsWith(".") || import_node_path.default.posix.isAbsolute(normalizedPath)) {
      throw new Error(`Unsupported file path: ${file.path}`);
    }
    if (typeof file.content !== "string") {
      throw new Error(`Unsupported file content for ${normalizedPath}.`);
    }
    if (file.content.length > maxFileSize) {
      throw new Error(`File is too large: ${normalizedPath}`);
    }
    totalSize += file.content.length;
    if (totalSize > maxTotalSize) {
      throw new Error("Workspace snapshot is too large for the TanStack Start core RPC runner.");
    }
    map.set(normalizedPath, file.content);
  }
  return map;
}
function loaderForPath(filePath) {
  const extension = import_node_path.default.extname(filePath).toLowerCase();
  switch (extension) {
    case ".ts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
      return "js";
    case ".jsx":
      return "jsx";
    case ".json":
      return "json";
    default:
      return "text";
  }
}
function findWorkspaceFile(files, candidatePath) {
  const normalized = normalizeWorkspacePath(candidatePath);
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".json"];
  if (files.has(normalized)) return normalized;
  for (const extension of extensions) {
    const directPath = extension && normalized.endsWith(extension) ? normalized : `${normalized}${extension}`;
    if (files.has(directPath)) return directPath;
  }
  return null;
}
function resolveWorkspaceImport(files, source, importerPath) {
  if (!source.startsWith(".")) return null;
  const baseDir = importerPath ? import_node_path.default.posix.dirname(importerPath.replaceAll("\\", "/")) : "";
  return findWorkspaceFile(files, import_node_path.default.posix.normalize(import_node_path.default.posix.join(baseDir, source)));
}
function isSerializedFormData(value) {
  return typeof value === "object" && value !== null && value.__tutoType === "FormData" && Array.isArray(value.entries);
}
function reviveRpcValue(value) {
  if (!value || typeof value !== "object") return value;
  if (isSerializedFormData(value)) {
    const formData = new FormData();
    for (const [name, entry] of value.entries) {
      if (entry.kind === "file") {
        const blob = new Blob([entry.text ?? ""], {
          type: entry.type || "application/octet-stream"
        });
        formData.append(name, blob, entry.name || "file");
        continue;
      }
      formData.append(name, entry.value);
    }
    return formData;
  }
  if (Array.isArray(value)) return value.map(reviveRpcValue);
  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [key, reviveRpcValue(nestedValue)])
  );
}
async function serializeRpcValue(value) {
  if (typeof Response !== "undefined" && value instanceof Response) {
    return {
      __tutoType: "Response",
      body: await value.text(),
      headers: Object.fromEntries(value.headers.entries()),
      status: value.status,
      statusText: value.statusText
    };
  }
  return value;
}
function createReactStartRpcShim() {
  return `function flattenMiddleware(middlewares = [], seen = new Set()) {
  const flattened = [];
  for (const middleware of middlewares) {
    if (!middleware || seen.has(middleware)) continue;
    seen.add(middleware);
    if (middleware.options?.middleware) {
      flattened.push(...flattenMiddleware(middleware.options.middleware, seen));
    }
    flattened.push(middleware);
  }
  return flattened;
}
async function runServerMiddleware(middlewares, initialState) {
  const stack = flattenMiddleware(middlewares);
  async function dispatch(index, state) {
    if (index >= stack.length) {
      return { data: state.data, context: state.context };
    }
    const middleware = stack[index];
    const options = middleware.options || {};
    let data = state.data;
    if (options.inputValidator) data = await options.inputValidator(data);
    if (!options.server) {
      return dispatch(index + 1, { ...state, data });
    }
    const next = async (nextOptions = {}) => {
      const nextState = {
        ...state,
        data: Object.prototype.hasOwnProperty.call(nextOptions, "data") ? nextOptions.data : data,
        context: { ...state.context, ...(nextOptions.context || {}) },
      };
      return dispatch(index + 1, nextState);
    };
    const result = await options.server({ ...state, data, context: state.context, next });
    if (typeof result === "undefined") {
      throw new Error("User middleware returned undefined. You must call next() or return a result in your middlewares.");
    }
    return {
      data: Object.prototype.hasOwnProperty.call(result, "data") ? result.data : data,
      context: { ...state.context, ...(result.context || {}) },
    };
  }
  return dispatch(0, initialState);
}
export function createMiddleware(options = {}, __opts) {
  const resolvedOptions = __opts || options || {};
  return {
    options: resolvedOptions,
    middleware: (middleware) => createMiddleware(undefined, {
      ...resolvedOptions,
      middleware: [...(resolvedOptions.middleware || []), ...middleware],
    }),
    inputValidator: (inputValidator) => createMiddleware(undefined, { ...resolvedOptions, inputValidator }),
    validator: (inputValidator) => createMiddleware(undefined, { ...resolvedOptions, inputValidator }),
    client: (client) => createMiddleware(undefined, { ...resolvedOptions, client }),
    server: (server) => createMiddleware(undefined, { ...resolvedOptions, server }),
  };
}
export function createServerFn(options = {}, __opts) {
  const resolvedOptions = __opts || options || {};
  if (typeof resolvedOptions.method === "undefined") resolvedOptions.method = "GET";
  const builder = (nextOptions = {}) => createServerFn(undefined, { ...resolvedOptions, ...nextOptions });
  builder.middleware = (middleware) => createServerFn(undefined, { ...resolvedOptions, middleware: [...(resolvedOptions.middleware || []), ...middleware] });
  builder.inputValidator = (inputValidator) => createServerFn(undefined, { ...resolvedOptions, inputValidator });
  builder.handler = (extractedFn, serverFn) => {
    const run = async (opts = {}) => {
      try {
        let data = opts.data;
        if (resolvedOptions.inputValidator) data = await resolvedOptions.inputValidator(data);
        const middlewareResult = await runServerMiddleware(resolvedOptions.middleware, {
          ...opts,
          data,
          context: opts.context || {},
          method: resolvedOptions.method,
        });
        const result = await serverFn({
          ...opts,
          data: middlewareResult.data,
          context: middlewareResult.context,
          method: resolvedOptions.method,
        });
        return { result, context: middlewareResult.context };
      } catch (error) {
        return { error, context: {} };
      }
    };
    return Object.assign(async (opts) => (await run(opts)).result, extractedFn, {
      method: resolvedOptions.method,
      __executeServer: run,
    });
  };
  return builder;
}`;
}
function onResolveWorkspaceModule(fileMap, serverSplits, args) {
  if (serverSplits.has(args.path)) {
    return { path: args.path, namespace: "server-split" };
  }
  const workspaceMatch = args.namespace === "server-split" || args.namespace === "workspace" ? resolveWorkspaceImport(fileMap, args.path, args.importer) : null;
  if (workspaceMatch) return { path: workspaceMatch, namespace: "workspace" };
  return null;
}
async function executeServerFn({ id, payload, files }) {
  if (!id) throw new Error("Server function id is required.");
  const fileMap = sanitizeWorkspaceFiles(files);
  const root = import_node_path.default.join(absoluteWorkingDirectory, ".tmp", "tanstack-start-core");
  const { serverFnsById, serverSplits } = await (0, import_server_functions_transform.transformStartServerFunctions)(fileMap, {
    root
  });
  const serverFn = serverFnsById[id];
  if (!serverFn) {
    throw new Error(`Unknown server function id: ${id}`);
  }
  const splitModuleId = (0, import_server_functions_transform.toWorkspaceModuleId)(root, serverFn.extractedFilename);
  const splitCode = serverSplits.get(splitModuleId);
  if (!splitCode) {
    throw new Error(`Unable to load split module for server function id: ${id}`);
  }
  const resultKey = `__TUTO_RPC_RESULT_${(0, import_node_crypto.randomUUID)().replaceAll("-", "_")}`;
  const payloadKey = `__TUTO_RPC_PAYLOAD_${(0, import_node_crypto.randomUUID)().replaceAll("-", "_")}`;
  globalResultStore[payloadKey] = reviveRpcValue(payload ?? {});
  const entrySource = `
import { ${serverFn.functionName} as action } from ${JSON.stringify(splitModuleId)};

const payload = globalThis[${JSON.stringify(payloadKey)}] || {};
globalThis[${JSON.stringify(resultKey)}] = await action(payload);
`;
  const bundle = await (0, import_esbuild.build)({
    absWorkingDir: absoluteWorkingDirectory,
    bundle: true,
    charset: "utf8",
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.TSS_SERVER_FN_BASE": '"/api/serverless/tanstack-start/core-rpc?id="'
    },
    entryPoints: ["__tuto_rpc_entry__"],
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "react",
    legalComments: "none",
    logLevel: "silent",
    outfile: "/out/rpc.js",
    platform: "node",
    plugins: [
      {
        name: "tuto-tanstack-start-core-rpc-workspace",
        setup(buildApi) {
          buildApi.onResolve({ filter: /^__tuto_rpc_entry__$/ }, () => ({
            path: "__tuto_rpc_entry__",
            namespace: "rpc-entry"
          }));
          buildApi.onResolve({ filter: /^@tanstack\/react-start$/ }, () => ({
            path: "@tanstack/react-start",
            namespace: "rpc-shim"
          }));
          buildApi.onResolve({ filter: /^@tanstack\/react-start\/server-rpc$/ }, () => ({
            path: "@tanstack/react-start/server-rpc",
            namespace: "rpc-shim"
          }));
          buildApi.onLoad({ filter: /.*/, namespace: "rpc-entry" }, () => ({
            contents: entrySource,
            loader: "js",
            resolveDir: absoluteWorkingDirectory
          }));
          buildApi.onLoad({ filter: /.*/, namespace: "rpc-shim" }, (args) => ({
            contents: args.path === "@tanstack/react-start/server-rpc" ? `export function createServerRpc(meta, fn) { return Object.assign(fn, { serverFnMeta: meta, url: "/api/serverless/tanstack-start/core-rpc?id=" + meta.id }); }` : createReactStartRpcShim(),
            loader: "js",
            resolveDir: absoluteWorkingDirectory
          }));
          buildApi.onResolve(
            { filter: /.*/ },
            (args) => onResolveWorkspaceModule(fileMap, serverSplits, args)
          );
          buildApi.onLoad({ filter: /.*/, namespace: "server-split" }, (args) => ({
            contents: serverSplits.get(args.path),
            loader: "tsx",
            resolveDir: absoluteWorkingDirectory
          }));
          buildApi.onLoad({ filter: /.*/, namespace: "workspace" }, (args) => ({
            contents: fileMap.get(args.path),
            loader: loaderForPath(args.path),
            resolveDir: absoluteWorkingDirectory
          }));
        }
      }
    ],
    target: ["node22"],
    treeShaking: true,
    write: false
  });
  const jsOutput = bundle.outputFiles.find((file) => file.path.endsWith(".js"));
  if (!jsOutput) throw new Error("RPC bundle did not produce JavaScript.");
  try {
    const dataUrl = `data:text/javascript;base64,${Buffer.from(jsOutput.text).toString("base64")}`;
    await import(dataUrl);
    const result = globalResultStore[resultKey];
    if (result?.error) throw result.error;
    return {
      result: await serializeRpcValue(result?.result),
      context: await serializeRpcValue(result?.context ?? {})
    };
  } finally {
    delete globalResultStore[resultKey];
    delete globalResultStore[payloadKey];
  }
}
function normalizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    error: message,
    diagnostics: [createDiagnostic("error", message)]
  };
}
async function readInput() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk.toString("utf8");
  return JSON.parse(input);
}
async function main() {
  let result;
  try {
    const payload = await readInput();
    const value = await executeServerFn(payload);
    result = {
      success: true,
      ...value,
      diagnostics: [createDiagnostic("info", "Server function executed with Start core.")]
    };
  } catch (error) {
    result = normalizeError(error);
  }
  process.stdout.write(
    `
${resultStartMarker}
${JSON.stringify(result)}
${resultEndMarker}
`
  );
}
main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
