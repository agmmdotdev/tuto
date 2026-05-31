/* eslint-disable @typescript-eslint/no-require-imports */
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { build } = require("esbuild");

const resultStartMarker = "__TUTO_TANSTACK_START_CORE_RPC_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_RPC_RESULT_END__";
const maxFileCount = 64;
const maxFileSize = 220_000;
const maxTotalSize = 1_250_000;
const absoluteWorkingDirectory = process.cwd();

function createDiagnostic(level, message, details = {}) {
  return {
    id: randomUUID(),
    level,
    message,
    timestamp: new Date().toISOString(),
    ...details,
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

  const map = new Map();
  let totalSize = 0;

  for (const file of files) {
    const normalizedPath = normalizeWorkspacePath(file.path);

    if (
      !normalizedPath ||
      normalizedPath.includes("..") ||
      normalizedPath.startsWith(".") ||
      path.posix.isAbsolute(normalizedPath)
    ) {
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

async function importStartCompilerInternals() {
  const packageRoot = path.dirname(
    require.resolve("@tanstack/start-plugin-core/package.json"),
  );
  const esmRoot = path.join(packageRoot, "dist", "esm", "start-compiler");
  const host = await import(pathToFileURL(path.join(esmRoot, "host.js")).toString());
  const compiler = await import(pathToFileURL(path.join(esmRoot, "compiler.js")).toString());
  const config = await import(pathToFileURL(path.join(esmRoot, "config.js")).toString());

  return {
    createStartCompiler: host.createStartCompiler,
    detectKindsInCode: compiler.detectKindsInCode,
    getLookupKindsForEnv: compiler.getLookupKindsForEnv,
    getLookupConfigurationsForEnv: config.getLookupConfigurationsForEnv,
  };
}

function toAbsoluteModuleId(root, workspacePath) {
  return path.join(root, ...workspacePath.split("/"));
}

function toWorkspacePath(root, absoluteId) {
  const cleanId = absoluteId.split("?")[0];
  const relativePath = path.relative(root, cleanId).replaceAll("\\", "/");
  return relativePath.startsWith("..") ? null : relativePath;
}

function toWorkspaceModuleId(root, absoluteId) {
  const queryIndex = absoluteId.indexOf("?");
  const query = queryIndex === -1 ? "" : absoluteId.slice(queryIndex);
  const workspacePath = toWorkspacePath(root, absoluteId);
  return workspacePath ? `${workspacePath}${query}` : absoluteId;
}

function createCoreResolver(root, fileMap) {
  const extensions = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];

  return async function resolveId(source, importer) {
    if (source.startsWith("@tanstack/") || source === "react" || source.startsWith("react/")) {
      return source;
    }

    if (!source.startsWith(".")) return source;

    const importerPath = importer ? importer.split("?")[0] : root;
    const basePath = path.resolve(path.dirname(importerPath), source);

    for (const extension of extensions) {
      const candidate = `${basePath}${extension}`;
      const workspacePath = toWorkspacePath(root, candidate);
      if (workspacePath && fileMap.has(workspacePath)) return candidate;
    }

    return basePath;
  };
}

async function compileServerSplits(fileMap) {
  const {
    createStartCompiler,
    detectKindsInCode,
    getLookupKindsForEnv,
    getLookupConfigurationsForEnv,
  } = await importStartCompilerInternals();
  const root = path.join(absoluteWorkingDirectory, ".tmp", "tanstack-start-core");
  const serverFnsById = {};
  const serverSplits = new Map();
  const resolveId = createCoreResolver(root, fileMap);
  let compiler;

  compiler = createStartCompiler({
    env: "server",
    envName: "ssr",
    root,
    framework: "react",
    providerEnvName: "ssr",
    mode: "build",
    lookupKinds: getLookupKindsForEnv("server"),
    lookupConfigurations: getLookupConfigurationsForEnv("server", "react"),
    getKnownServerFns: () => serverFnsById,
    onServerFnsById: (next) => Object.assign(serverFnsById, next),
    loadModule: async (moduleId) => {
      const workspacePath = toWorkspacePath(root, moduleId);
      const code = workspacePath ? fileMap.get(workspacePath) : undefined;
      if (workspacePath && code) {
        compiler.ingestModule({ code, id: toAbsoluteModuleId(root, workspacePath) });
      }
    },
    resolveId,
  });

  for (const [workspacePath, code] of fileMap.entries()) {
    if (!/\.[cm]?[tj]sx?$/.test(workspacePath)) continue;
    const id = toAbsoluteModuleId(root, workspacePath);
    await compiler.compile({
      code,
      id,
      detectedKinds: detectKindsInCode(code, "server"),
    });
  }

  for (const serverFn of Object.values(serverFnsById)) {
    const workspacePath = toWorkspacePath(root, serverFn.filename);
    const code = workspacePath ? fileMap.get(workspacePath) : undefined;
    if (!workspacePath || !code) continue;

    const splitId = `${toAbsoluteModuleId(root, workspacePath)}?tss-serverfn-split`;
    const splitResult = await compiler.compile({
      code,
      id: splitId,
      parserFilename: toAbsoluteModuleId(root, workspacePath),
      detectedKinds: detectKindsInCode(code, "server"),
    });

    if (splitResult?.code) {
      serverSplits.set(toWorkspaceModuleId(root, serverFn.extractedFilename), splitResult.code);
    }
  }

  return { serverFnsById, serverSplits };
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
    const directPath =
      extension && normalized.endsWith(extension) ? normalized : `${normalized}${extension}`;
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
  const { serverFnsById, serverSplits } = await compileServerSplits(fileMap);
  const serverFn = serverFnsById[id];

  if (!serverFn) {
    throw new Error(`Unknown server function id: ${id}`);
  }

  const splitModuleId = toWorkspaceModuleId(
    path.join(absoluteWorkingDirectory, ".tmp", "tanstack-start-core"),
    serverFn.extractedFilename,
  );
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
      "process.env.TSS_SERVER_FN_BASE": '"/api/serverless/tanstack-start/core-rpc?id="',
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
            namespace: "rpc-entry",
          }));
          buildApi.onResolve({ filter: /^@tanstack\/react-start$/ }, () => ({
            path: "@tanstack/react-start",
            namespace: "rpc-shim",
          }));
          buildApi.onResolve({ filter: /^@tanstack\/react-start\/server-rpc$/ }, () => ({
            path: "@tanstack/react-start/server-rpc",
            namespace: "rpc-shim",
          }));
          buildApi.onLoad({ filter: /.*/, namespace: "rpc-entry" }, () => ({
            contents: entrySource,
            loader: "js",
            resolveDir: absoluteWorkingDirectory,
          }));
          buildApi.onLoad({ filter: /.*/, namespace: "rpc-shim" }, (args) => ({
            contents:
              args.path === "@tanstack/react-start/server-rpc"
                ? `export function createServerRpc(meta, fn) { return Object.assign(fn, { serverFnMeta: meta, url: "/api/serverless/tanstack-start/core-rpc?id=" + meta.id }); }`
                : `export function createServerFn(options = {}, __opts) {
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
            resolveDir: absoluteWorkingDirectory,
          }));
          buildApi.onResolve({ filter: /.*/ }, (args) => {
            if (serverSplits.has(args.path)) {
              return { path: args.path, namespace: "server-split" };
            }
            const workspaceMatch =
              args.namespace === "server-split" || args.namespace === "workspace"
                ? resolveWorkspaceImport(fileMap, args.path, args.importer)
                : null;
            if (workspaceMatch) return { path: workspaceMatch, namespace: "workspace" };
            return null;
          });
          buildApi.onLoad({ filter: /.*/, namespace: "server-split" }, (args) => ({
            contents: serverSplits.get(args.path),
            loader: "tsx",
            resolveDir: absoluteWorkingDirectory,
          }));
          buildApi.onLoad({ filter: /.*/, namespace: "workspace" }, (args) => ({
            contents: fileMap.get(args.path),
            loader: loaderForPath(args.path),
            resolveDir: absoluteWorkingDirectory,
          }));
        },
      },
    ],
    target: ["node22"],
    treeShaking: true,
    write: false,
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
      context: result?.context ?? {},
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
    diagnostics: [createDiagnostic("error", message)],
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
      diagnostics: [createDiagnostic("info", "Server function executed with Start core.")],
    };
  } catch (error) {
    result = normalizeError(error);
  }
  process.stdout.write(
    `\n${resultStartMarker}\n${JSON.stringify(result)}\n${resultEndMarker}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
