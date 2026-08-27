import path from "node:path";
import { pathToFileURL } from "node:url";
import type { detectKindsInCode as detectKindsInCodeType } from "../../node_modules/@tanstack/start-plugin-core/dist/esm/start-compiler/compiler.js";
import type { createStartCompiler as createStartCompilerType } from "../../node_modules/@tanstack/start-plugin-core/dist/esm/start-compiler/host.js";
import type { ServerFn } from "../../node_modules/@tanstack/start-plugin-core/dist/esm/start-compiler/types.js";

type WorkspaceFileMap = Map<string, string>;

type StartCompilerInternals = {
  createStartCompiler: typeof createStartCompilerType;
  detectKindsInCode: typeof detectKindsInCodeType;
};
type RouterCompilerInternals = {
  compileCodeSplitSharedRoute(options: {
    code: string;
    filename: string;
    sharedBindings: Set<string>;
  }): { code: string };
  compileCodeSplitReferenceRoute(options: {
    addHmr: boolean;
    code: string;
    codeSplitGroupings: Array<Array<RouteSplitTarget>>;
    compilerPlugins: [];
    deleteNodes: Set<string>;
    filename: string;
    id: string;
    sharedBindings?: Set<string>;
    targetFramework: "react";
  }): { code: string } | null;
  compileCodeSplitVirtualRoute(options: {
    code: string;
    compilerPlugins: [];
    filename: string;
    sharedBindings?: Set<string>;
    splitTargets: Array<RouteSplitTarget>;
  }): { code: string };
  computeSharedBindings(options: {
    code: string;
    codeSplitGroupings: Array<Array<RouteSplitTarget>>;
    filename: string;
  }): Set<string>;
  detectCodeSplitGroupingsFromRoute(options: {
    code: string;
    filename: string;
  }): { groupings?: Array<Array<RouteSplitTarget>> };
};
type RouteSplitTarget =
  | "component"
  | "errorComponent"
  | "notFoundComponent"
  | "pendingComponent"
  | "loader";
type StartCompilerEnv = Parameters<typeof detectKindsInCodeType>[1];

export type StartServerFunctionsTransform = {
  clientFiles: WorkspaceFileMap;
  clientRouteIds: Record<string, string>;
  clientRouteSplits: WorkspaceFileMap;
  resolverModule: string;
  serverFiles: WorkspaceFileMap;
  serverFnsById: Record<string, ServerFn>;
  serverRouteSplits: WorkspaceFileMap;
  serverSplits: WorkspaceFileMap;
};

const sourceModulePattern = /\.[cm]?[tj]sx?$/;
const defaultRouteSplitGroupings: Array<Array<RouteSplitTarget>> = [
  ["component"],
  ["errorComponent"],
  ["notFoundComponent"],
];

export async function importStartCompilerInternals(): Promise<StartCompilerInternals> {
  const packageRoot = path.dirname(
    require.resolve("@tanstack/start-plugin-core/package.json"),
  );
  const esmRoot = path.join(packageRoot, "dist", "esm", "start-compiler");

  const host = await import(
    pathToFileURL(path.join(esmRoot, "host.js")).toString()
  );
  const compiler = await import(
    pathToFileURL(path.join(esmRoot, "compiler.js")).toString()
  );

  return {
    createStartCompiler: host.createStartCompiler,
    detectKindsInCode: compiler.detectKindsInCode,
  };
}

async function importRouterCompilerInternals(): Promise<RouterCompilerInternals> {
  const packageRoot = path.dirname(
    require.resolve("@tanstack/router-plugin/package.json"),
  );
  return import(
    pathToFileURL(
      path.join(
        packageRoot,
        "dist",
        "esm",
        "core",
        "code-splitter",
        "compilers.js",
      ),
    ).toString()
  ) as Promise<RouterCompilerInternals>;
}

function routeIdFromCode(code: string) {
  return (
    code.match(/\bcreateFileRoute\s*\(\s*(["'`])([^"'`]+)\1\s*\)/)?.[2] ??
    (/\bcreateRootRoute\s*\(/.test(code) ? "__root__" : undefined)
  );
}

function routeSplitModuleId(
  workspacePath: string,
  grouping: Array<RouteSplitTarget>,
) {
  return `${workspacePath}?tsr-split=${grouping.slice().sort().join("---")}`;
}

async function compileRoutes(
  files: WorkspaceFileMap,
  root: string,
  options: { deleteNodes?: Set<string>; stripRouteCssImports?: boolean } = {},
) {
  const {
    compileCodeSplitReferenceRoute,
    compileCodeSplitSharedRoute,
    compileCodeSplitVirtualRoute,
    computeSharedBindings,
    detectCodeSplitGroupingsFromRoute,
  } = await importRouterCompilerInternals();
  const clientRouteIds: Record<string, string> = {};
  const clientRouteSplits: WorkspaceFileMap = new Map();

  for (const [workspacePath, code] of [...files]) {
    if (
      !/^src\/routes\/.+\.[cm]?[tj]sx?$/.test(workspacePath) ||
      (!code.includes("createFileRoute") && !code.includes("createRootRoute"))
    ) {
      continue;
    }
    const routeId = routeIdFromCode(code);
    if (routeId) clientRouteIds[workspacePath] = routeId;
    const id = toAbsoluteModuleId(root, workspacePath);
    const codeSplitGroupings =
      detectCodeSplitGroupingsFromRoute({ code, filename: id }).groupings ??
      defaultRouteSplitGroupings;
    const sharedBindings = computeSharedBindings({
      code,
      codeSplitGroupings,
      filename: id,
    });
    const result = compileCodeSplitReferenceRoute({
      addHmr: false,
      code,
      codeSplitGroupings,
      compilerPlugins: [],
      deleteNodes: options.deleteNodes ?? new Set(),
      filename: id,
      id,
      ...(sharedBindings.size > 0 ? { sharedBindings } : {}),
      targetFramework: "react",
    });
    if (!result?.code) continue;
    files.set(
      workspacePath,
      options.stripRouteCssImports
        ? result.code.replace(
            /\bimport\s+(["'])[^"'\r\n]+\.css(?:\?[^"'\r\n]*)?\1\s*;?/g,
            "",
          )
        : result.code,
    );

    for (const grouping of codeSplitGroupings) {
      const splitId = routeSplitModuleId(workspacePath, grouping);
      if (!result.code.includes(splitId)) continue;
      const splitResult = compileCodeSplitVirtualRoute({
        code,
        compilerPlugins: [],
        filename: toAbsoluteModuleId(root, splitId),
        ...(sharedBindings.size > 0 ? { sharedBindings } : {}),
        splitTargets: grouping,
      });
      clientRouteSplits.set(splitId, splitResult.code);
    }
    if (sharedBindings.size > 0) {
      const sharedId = `${workspacePath}?tsr-shared=1`;
      const sharedResult = compileCodeSplitSharedRoute({
        code,
        filename: toAbsoluteModuleId(root, sharedId),
        sharedBindings,
      });
      clientRouteSplits.set(sharedId, sharedResult.code);
    }
  }

  return { clientRouteIds, clientRouteSplits };
}

export function toAbsoluteModuleId(root: string, workspacePath: string) {
  return path.join(root, ...workspacePath.split("/"));
}

export function toWorkspacePath(root: string, absoluteId: string) {
  const cleanId = absoluteId.split("?")[0] ?? absoluteId;
  const relativePath = path.relative(root, cleanId).replaceAll("\\", "/");

  return relativePath.startsWith("..") ? null : relativePath;
}

export function toWorkspaceModuleId(root: string, absoluteId: string) {
  const queryIndex = absoluteId.indexOf("?");
  const query = queryIndex === -1 ? "" : absoluteId.slice(queryIndex);
  const workspacePath = toWorkspacePath(root, absoluteId);

  return workspacePath ? `${workspacePath}${query}` : absoluteId;
}

export function createStartCoreResolver(
  root: string,
  fileMap: WorkspaceFileMap,
) {
  const extensions = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];

  return async function resolveId(source: string, importer?: string) {
    if (
      source.startsWith("@tanstack/") ||
      source === "react" ||
      source.startsWith("react/")
    ) {
      return source;
    }

    if (!source.startsWith(".")) {
      return source;
    }

    const importerPath = importer ? importer.split("?")[0] : root;
    const basePath = path.resolve(path.dirname(importerPath), source);

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
  env,
}: StartCompilerInternals & {
  env: StartCompilerEnv;
  fileMap: WorkspaceFileMap;
  root: string;
  serverFnsById: Record<string, ServerFn>;
}) {
  const compiler = createStartCompiler({
    env,
    envName: env === "client" ? "client" : "ssr",
    root,
    framework: "react",
    providerEnvName: "ssr",
    mode: "build",
    getKnownServerFns: () => serverFnsById,
    onServerFnsById: (nextServerFns) =>
      Object.assign(serverFnsById, nextServerFns),
    loadModule: async (moduleId) => {
      const workspacePath = toWorkspacePath(root, moduleId);
      const code = workspacePath ? fileMap.get(workspacePath) : undefined;

      compiler.ingestModule({
        // Bare framework imports are already classified through the compiler's
        // known-import table. Ingest an empty external module for other imports
        // (for example React hooks co-located with a server function) so an
        // unrelated call can resolve to `None` instead of aborting the build.
        code: code ?? "export {};",
        id: workspacePath ? toAbsoluteModuleId(root, workspacePath) : moduleId,
      });
    },
    resolveId: createStartCoreResolver(root, fileMap),
  });

  return compiler;
}

export function createServerFnResolverModule(
  serverFnsById: Record<string, ServerFn>,
  root: string,
) {
  const manifestEntries = Object.entries(serverFnsById).map(
    ([id, serverFn]) => {
      const splitPath = toWorkspaceModuleId(root, serverFn.extractedFilename);

      return `${JSON.stringify(id)}: { functionName: ${JSON.stringify(
        serverFn.functionName,
      )}, module: ${JSON.stringify(splitPath)} },`;
    },
  );

  return [
    "const manifest = {",
    ...manifestEntries,
    "};",
    "export async function getServerFnById(id) {",
    "  const entry = manifest[id];",
    "  if (!entry) throw new Error('Server function info not found for ' + id);",
    "  return entry;",
    "}",
  ].join("\n");
}

export async function transformStartServerFunctions(
  fileMap: WorkspaceFileMap,
  options: { root?: string } = {},
): Promise<StartServerFunctionsTransform> {
  const { createStartCompiler, detectKindsInCode } =
    await importStartCompilerInternals();
  const root =
    options.root ?? path.join(process.cwd(), ".tmp", "tanstack-start-core");
  const serverFnsById: Record<string, ServerFn> = {};
  const clientFiles: WorkspaceFileMap = new Map();
  const serverFiles: WorkspaceFileMap = new Map();
  const serverSplits: WorkspaceFileMap = new Map();
  const clientCompiler = createCompiler({
    createStartCompiler,
    detectKindsInCode,
    fileMap,
    root,
    serverFnsById,
    env: "client",
  });
  const serverCompiler = createCompiler({
    createStartCompiler,
    detectKindsInCode,
    fileMap,
    root,
    serverFnsById,
    env: "server",
  });

  for (const [workspacePath, code] of fileMap.entries()) {
    if (!sourceModulePattern.test(workspacePath)) {
      clientFiles.set(workspacePath, code);
      serverFiles.set(workspacePath, code);
      continue;
    }

    if (
      !code.includes("createServerFn") &&
      !code.includes("createMiddleware") &&
      !code.includes("createServerOnlyFn") &&
      !code.includes("createClientOnlyFn") &&
      !code.includes("createIsomorphicFn")
    ) {
      clientFiles.set(workspacePath, code);
      serverFiles.set(workspacePath, code);
      continue;
    }

    const id = toAbsoluteModuleId(root, workspacePath);
    const clientResult = await clientCompiler.compile({
      code,
      id,
      detectedKinds: detectKindsInCode(code, "client"),
    });
    const serverResult = await serverCompiler.compile({
      code,
      id,
      detectedKinds: detectKindsInCode(code, "server"),
    });

    clientFiles.set(workspacePath, clientResult?.code ?? code);
    serverFiles.set(workspacePath, serverResult?.code ?? code);
  }

  for (const serverFn of Object.values(serverFnsById)) {
    const workspacePath = toWorkspacePath(root, serverFn.filename);
    const code = workspacePath ? fileMap.get(workspacePath) : undefined;

    if (!workspacePath || !code) {
      continue;
    }

    const splitId = `${toAbsoluteModuleId(root, workspacePath)}?tss-serverfn-split`;
    const splitResult = await serverCompiler.compile({
      code,
      id: splitId,
      parserFilename: toAbsoluteModuleId(root, workspacePath),
      detectedKinds: detectKindsInCode(code, "server"),
    });

    if (splitResult?.code) {
      serverSplits.set(
        toWorkspaceModuleId(root, serverFn.extractedFilename),
        splitResult.code,
      );
    }
  }

  const { clientRouteIds, clientRouteSplits } = await compileRoutes(
    clientFiles,
    root,
    {
      deleteNodes: new Set(["headers", "server", "ssr"]),
      stripRouteCssImports: true,
    },
  );
  const { clientRouteSplits: serverRouteSplits } = await compileRoutes(
    serverFiles,
    root,
  );

  return {
    clientFiles,
    clientRouteIds,
    clientRouteSplits,
    serverFiles,
    serverSplits,
    serverFnsById,
    serverRouteSplits,
    resolverModule: createServerFnResolverModule(serverFnsById, root),
  };
}
