"use strict";
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { build } = require("esbuild");
const {
  toWorkspaceModuleId,
  transformStartServerFunctions
} = require("./server-functions-transform.generated.cjs");
const resultStartMarker = "__TUTO_TANSTACK_START_CORE_RPC_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_RPC_RESULT_END__";
const maxFileCount = 64;
const maxFileSize = 22e4;
const maxTotalSize = 125e4;
const absoluteWorkingDirectory = process.cwd();
function createDiagnostic(level, message, details = {}) {
  return {
    id: randomUUID(),
    level,
    message,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    ...details
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
    if (!normalizedPath || normalizedPath.includes("..") || normalizedPath.startsWith(".") || path.posix.isAbsolute(normalizedPath)) {
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
  const extension = path.extname(filePath).toLowerCase();
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
  const baseDir = importerPath ? path.posix.dirname(importerPath.replaceAll("\\", "/")) : "";
  return findWorkspaceFile(files, path.posix.normalize(path.posix.join(baseDir, source)));
}
async function executeServerFn({ id, payload, files }) {
  const fileMap = sanitizeWorkspaceFiles(files);
  const root = path.join(absoluteWorkingDirectory, ".tmp", "tanstack-start-core");
  const { serverFnsById, serverSplits } = await transformStartServerFunctions(fileMap, {
    root
  });
  const serverFn = serverFnsById[id];
  if (!serverFn) {
    throw new Error(`Unknown server function id: ${id}`);
  }
  const splitModuleId = toWorkspaceModuleId(root, serverFn.extractedFilename);
  const splitCode = serverSplits.get(splitModuleId);
  if (!splitCode) {
    throw new Error(`Unable to load split module for server function id: ${id}`);
  }
  const resultKey = `__TUTO_RPC_RESULT_${randomUUID().replaceAll("-", "_")}`;
  const payloadKey = `__TUTO_RPC_PAYLOAD_${randomUUID().replaceAll("-", "_")}`;
  globalThis[payloadKey] = payload ?? {};
  const entrySource = `
import { ${serverFn.functionName} as action } from ${JSON.stringify(splitModuleId)};

const payload = globalThis[${JSON.stringify(payloadKey)}] || {};
globalThis[${JSON.stringify(resultKey)}] = await action(payload);
`;
  const bundle = await build({
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
            contents: args.path === "@tanstack/react-start/server-rpc" ? `export function createServerRpc(meta, fn) { return Object.assign(fn, { serverFnMeta: meta, url: "/api/serverless/tanstack-start/core-rpc?id=" + meta.id }); }` : `export function createServerFn(options = {}, __opts) {
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
                          return { result: await serverFn({ ...opts, data, method: resolvedOptions.method }), context: {} };
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
                  }`,
            loader: "js",
            resolveDir: absoluteWorkingDirectory
          }));
          buildApi.onResolve({ filter: /.*/ }, (args) => {
            if (serverSplits.has(args.path)) {
              return { path: args.path, namespace: "server-split" };
            }
            const workspaceMatch = args.namespace === "server-split" || args.namespace === "workspace" ? resolveWorkspaceImport(fileMap, args.path, args.importer) : null;
            if (workspaceMatch) return { path: workspaceMatch, namespace: "workspace" };
            return null;
          });
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
    const result = globalThis[resultKey];
    if (result?.error) throw result.error;
    return {
      result: result?.result,
      context: result?.context ?? {}
    };
  } finally {
    delete globalThis[resultKey];
    delete globalThis[payloadKey];
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
