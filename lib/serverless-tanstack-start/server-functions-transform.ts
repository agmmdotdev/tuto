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
type StartCompilerEnv = Parameters<typeof detectKindsInCodeType>[1];

export type StartServerFunctionsTransform = {
  clientFiles: WorkspaceFileMap;
  resolverModule: string;
  serverFiles: WorkspaceFileMap;
  serverFnsById: Record<string, ServerFn>;
  serverSplits: WorkspaceFileMap;
};

const sourceModulePattern = /\.[cm]?[tj]sx?$/;

export async function importStartCompilerInternals(): Promise<StartCompilerInternals> {
  const packageRoot = path.dirname(
    require.resolve("@tanstack/start-plugin-core/package.json"),
  );
  const esmRoot = path.join(packageRoot, "dist", "esm", "start-compiler");

  const host = await import(pathToFileURL(path.join(esmRoot, "host.js")).toString());
  const compiler = await import(
    pathToFileURL(path.join(esmRoot, "compiler.js")).toString()
  );

  return {
    createStartCompiler: host.createStartCompiler,
    detectKindsInCode: compiler.detectKindsInCode,
  };
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

export function createStartCoreResolver(root: string, fileMap: WorkspaceFileMap) {
  const extensions = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];

  return async function resolveId(source: string, importer?: string) {
    if (source.startsWith("@tanstack/") || source === "react" || source.startsWith("react/")) {
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
    onServerFnsById: (nextServerFns) => Object.assign(serverFnsById, nextServerFns),
    loadModule: async (moduleId) => {
      const workspacePath = toWorkspacePath(root, moduleId);
      const code = workspacePath ? fileMap.get(workspacePath) : undefined;

      if (workspacePath && code) {
        compiler.ingestModule({
          code,
          id: toAbsoluteModuleId(root, workspacePath),
        });
      }
    },
    resolveId: createStartCoreResolver(root, fileMap),
  });

  return compiler;
}

export function createServerFnResolverModule(
  serverFnsById: Record<string, ServerFn>,
  root: string,
) {
  const manifestEntries = Object.entries(serverFnsById).map(([id, serverFn]) => {
    const splitPath = toWorkspaceModuleId(root, serverFn.extractedFilename);

    return `${JSON.stringify(id)}: { functionName: ${JSON.stringify(
      serverFn.functionName,
    )}, module: ${JSON.stringify(splitPath)} },`;
  });

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
  const {
    createStartCompiler,
    detectKindsInCode,
  } = await importStartCompilerInternals();
  const root = options.root ?? path.join(process.cwd(), ".tmp", "tanstack-start-core");
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
      serverSplits.set(toWorkspaceModuleId(root, serverFn.extractedFilename), splitResult.code);
    }
  }

  return {
    clientFiles,
    serverFiles,
    serverSplits,
    serverFnsById,
    resolverModule: createServerFnResolverModule(serverFnsById, root),
  };
}
