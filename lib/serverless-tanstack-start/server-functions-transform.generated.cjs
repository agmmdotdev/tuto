"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lib/serverless-tanstack-start/server-functions-transform.ts
var server_functions_transform_exports = {};
__export(server_functions_transform_exports, {
  createServerFnResolverModule: () => createServerFnResolverModule,
  createStartCoreResolver: () => createStartCoreResolver,
  importStartCompilerInternals: () => importStartCompilerInternals,
  toAbsoluteModuleId: () => toAbsoluteModuleId,
  toWorkspaceModuleId: () => toWorkspaceModuleId,
  toWorkspacePath: () => toWorkspacePath,
  transformStartServerFunctions: () => transformStartServerFunctions
});
module.exports = __toCommonJS(server_functions_transform_exports);
var import_node_path = __toESM(require("node:path"));
var import_node_url = require("node:url");
var sourceModulePattern = /\.[cm]?[tj]sx?$/;
async function importStartCompilerInternals() {
  const packageRoot = import_node_path.default.dirname(
    require.resolve("@tanstack/start-plugin-core/package.json")
  );
  const esmRoot = import_node_path.default.join(packageRoot, "dist", "esm", "start-compiler");
  const host = await import((0, import_node_url.pathToFileURL)(import_node_path.default.join(esmRoot, "host.js")).toString());
  const compiler = await import((0, import_node_url.pathToFileURL)(import_node_path.default.join(esmRoot, "compiler.js")).toString());
  return {
    createStartCompiler: host.createStartCompiler,
    detectKindsInCode: compiler.detectKindsInCode
  };
}
async function importRouterCompilerInternals() {
  const packageRoot = import_node_path.default.dirname(
    require.resolve("@tanstack/router-plugin/package.json")
  );
  return import((0, import_node_url.pathToFileURL)(
    import_node_path.default.join(
      packageRoot,
      "dist",
      "esm",
      "core",
      "code-splitter",
      "compilers.js"
    )
  ).toString());
}
async function stripClientServerRouteOptions(files, root) {
  const { compileCodeSplitReferenceRoute } = await importRouterCompilerInternals();
  for (const [workspacePath, code] of files) {
    if (!/^src\/routes\/.+\.[cm]?[tj]sx?$/.test(workspacePath) || !code.includes("createFileRoute") && !code.includes("createRootRoute")) {
      continue;
    }
    const id = toAbsoluteModuleId(root, workspacePath);
    const result = compileCodeSplitReferenceRoute({
      addHmr: false,
      code,
      codeSplitGroupings: [],
      compilerPlugins: [],
      deleteNodes: /* @__PURE__ */ new Set(["headers", "server", "ssr"]),
      filename: id,
      id,
      targetFramework: "react"
    });
    if (result?.code) files.set(workspacePath, result.code);
  }
}
function toAbsoluteModuleId(root, workspacePath) {
  return import_node_path.default.join(root, ...workspacePath.split("/"));
}
function toWorkspacePath(root, absoluteId) {
  const cleanId = absoluteId.split("?")[0] ?? absoluteId;
  const relativePath = import_node_path.default.relative(root, cleanId).replaceAll("\\", "/");
  return relativePath.startsWith("..") ? null : relativePath;
}
function toWorkspaceModuleId(root, absoluteId) {
  const queryIndex = absoluteId.indexOf("?");
  const query = queryIndex === -1 ? "" : absoluteId.slice(queryIndex);
  const workspacePath = toWorkspacePath(root, absoluteId);
  return workspacePath ? `${workspacePath}${query}` : absoluteId;
}
function createStartCoreResolver(root, fileMap) {
  const extensions = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];
  return async function resolveId(source, importer) {
    if (source.startsWith("@tanstack/") || source === "react" || source.startsWith("react/")) {
      return source;
    }
    if (!source.startsWith(".")) {
      return source;
    }
    const importerPath = importer ? importer.split("?")[0] : root;
    const basePath = import_node_path.default.resolve(import_node_path.default.dirname(importerPath), source);
    for (const extension of extensions) {
      const candidate = `${basePath}${extension}`;
      const workspacePath = toWorkspacePath(root, candidate);
      if (workspacePath && fileMap.has(workspacePath)) {
        return candidate;
      }
    }
    return basePath;
  };
}
function createCompiler({
  createStartCompiler,
  fileMap,
  root,
  serverFnsById,
  env
}) {
  const compiler = createStartCompiler({
    env,
    envName: env === "client" ? "client" : "ssr",
    root,
    framework: "react",
    providerEnvName: "ssr",
    mode: "build",
    getKnownServerFns: () => serverFnsById,
    onServerFnsById: (nextServerFns) => Object.assign(serverFnsById, nextServerFns),
    loadModule: async (moduleId) => {
      const workspacePath = toWorkspacePath(root, moduleId);
      const code = workspacePath ? fileMap.get(workspacePath) : void 0;
      compiler.ingestModule({
        // Bare framework imports are already classified through the compiler's
        // known-import table. Ingest an empty external module for other imports
        // (for example React hooks co-located with a server function) so an
        // unrelated call can resolve to `None` instead of aborting the build.
        code: code ?? "export {};",
        id: workspacePath ? toAbsoluteModuleId(root, workspacePath) : moduleId
      });
    },
    resolveId: createStartCoreResolver(root, fileMap)
  });
  return compiler;
}
function createServerFnResolverModule(serverFnsById, root) {
  const manifestEntries = Object.entries(serverFnsById).map(
    ([id, serverFn]) => {
      const splitPath = toWorkspaceModuleId(root, serverFn.extractedFilename);
      return `${JSON.stringify(id)}: { functionName: ${JSON.stringify(
        serverFn.functionName
      )}, module: ${JSON.stringify(splitPath)} },`;
    }
  );
  return [
    "const manifest = {",
    ...manifestEntries,
    "};",
    "export async function getServerFnById(id) {",
    "  const entry = manifest[id];",
    "  if (!entry) throw new Error('Server function info not found for ' + id);",
    "  return entry;",
    "}"
  ].join("\n");
}
async function transformStartServerFunctions(fileMap, options = {}) {
  const { createStartCompiler, detectKindsInCode } = await importStartCompilerInternals();
  const root = options.root ?? import_node_path.default.join(process.cwd(), ".tmp", "tanstack-start-core");
  const serverFnsById = {};
  const clientFiles = /* @__PURE__ */ new Map();
  const serverFiles = /* @__PURE__ */ new Map();
  const serverSplits = /* @__PURE__ */ new Map();
  const clientCompiler = createCompiler({
    createStartCompiler,
    detectKindsInCode,
    fileMap,
    root,
    serverFnsById,
    env: "client"
  });
  const serverCompiler = createCompiler({
    createStartCompiler,
    detectKindsInCode,
    fileMap,
    root,
    serverFnsById,
    env: "server"
  });
  for (const [workspacePath, code] of fileMap.entries()) {
    if (!sourceModulePattern.test(workspacePath)) {
      clientFiles.set(workspacePath, code);
      serverFiles.set(workspacePath, code);
      continue;
    }
    if (!code.includes("createServerFn") && !code.includes("createMiddleware") && !code.includes("createServerOnlyFn") && !code.includes("createClientOnlyFn") && !code.includes("createIsomorphicFn")) {
      clientFiles.set(workspacePath, code);
      serverFiles.set(workspacePath, code);
      continue;
    }
    const id = toAbsoluteModuleId(root, workspacePath);
    const clientResult = await clientCompiler.compile({
      code,
      id,
      detectedKinds: detectKindsInCode(code, "client")
    });
    const serverResult = await serverCompiler.compile({
      code,
      id,
      detectedKinds: detectKindsInCode(code, "server")
    });
    clientFiles.set(workspacePath, clientResult?.code ?? code);
    serverFiles.set(workspacePath, serverResult?.code ?? code);
  }
  for (const serverFn of Object.values(serverFnsById)) {
    const workspacePath = toWorkspacePath(root, serverFn.filename);
    const code = workspacePath ? fileMap.get(workspacePath) : void 0;
    if (!workspacePath || !code) {
      continue;
    }
    const splitId = `${toAbsoluteModuleId(root, workspacePath)}?tss-serverfn-split`;
    const splitResult = await serverCompiler.compile({
      code,
      id: splitId,
      parserFilename: toAbsoluteModuleId(root, workspacePath),
      detectedKinds: detectKindsInCode(code, "server")
    });
    if (splitResult?.code) {
      serverSplits.set(
        toWorkspaceModuleId(root, serverFn.extractedFilename),
        splitResult.code
      );
    }
  }
  await stripClientServerRouteOptions(clientFiles, root);
  return {
    clientFiles,
    serverFiles,
    serverSplits,
    serverFnsById,
    resolverModule: createServerFnResolverModule(serverFnsById, root)
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createServerFnResolverModule,
  createStartCoreResolver,
  importStartCompilerInternals,
  toAbsoluteModuleId,
  toWorkspaceModuleId,
  toWorkspacePath,
  transformStartServerFunctions
});
