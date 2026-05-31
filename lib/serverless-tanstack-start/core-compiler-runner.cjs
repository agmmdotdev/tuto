/* eslint-disable @typescript-eslint/no-require-imports */
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const resultStartMarker = "__TUTO_TANSTACK_START_CORE_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_RESULT_END__";
const maxFileCount = 64;
const maxFileSize = 220_000;
const maxTotalSize = 1_250_000;

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
    throw new Error("Too many files for the TanStack Start core compiler.");
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
      throw new Error("Workspace snapshot is too large for the TanStack Start core compiler.");
    }

    map.set(normalizedPath, file.content);
  }

  return map;
}

function normalizeBuildError(error) {
  const message = [error?.message, error?.stack].filter(Boolean).join("\n");
  return [createDiagnostic("error", message || "TanStack Start core compiler failed.")];
}

async function importStartCompilerInternals() {
  const packageRoot = path.dirname(
    require.resolve("@tanstack/start-plugin-core/package.json"),
  );
  const esmRoot = path.join(packageRoot, "dist", "esm", "start-compiler");

  const host = await import(pathToFileURL(path.join(esmRoot, "host.js")).toString());
  const compiler = await import(
    pathToFileURL(path.join(esmRoot, "compiler.js")).toString()
  );
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

function createResolver(root, fileMap) {
  const extensions = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];

  return async function resolveId(source, importer) {
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

async function compileWithStartCore(files) {
  const {
    createStartCompiler,
    detectKindsInCode,
    getLookupKindsForEnv,
    getLookupConfigurationsForEnv,
  } = await importStartCompilerInternals();
  const fileMap = sanitizeWorkspaceFiles(files);
  const root = path.join(process.cwd(), ".tmp", "tanstack-start-core-virtual");
  const serverFnsById = {};
  const transformed = {
    client: {},
    server: {},
    serverSplits: {},
  };
  const resolveId = createResolver(root, fileMap);
  const compilers = {};

  function createCompiler(env) {
    const compiler = createStartCompiler({
      env,
      envName: env === "client" ? "client" : "ssr",
      root,
      framework: "react",
      providerEnvName: "ssr",
      mode: "build",
      lookupKinds: getLookupKindsForEnv(env),
      lookupConfigurations: getLookupConfigurationsForEnv(env, "react"),
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
      resolveId,
    });

    return compiler;
  }

  compilers.client = createCompiler("client");
  compilers.server = createCompiler("server");

  for (const [workspacePath, code] of fileMap.entries()) {
    if (!/\.[cm]?[tj]sx?$/.test(workspacePath)) {
      continue;
    }

    const id = toAbsoluteModuleId(root, workspacePath);
    const clientResult = await compilers.client.compile({
      code,
      id,
      detectedKinds: detectKindsInCode(code, "client"),
    });
    const serverResult = await compilers.server.compile({
      code,
      id,
      detectedKinds: detectKindsInCode(code, "server"),
    });

    transformed.client[workspacePath] = clientResult?.code ?? code;
    transformed.server[workspacePath] = serverResult?.code ?? code;
  }

  for (const serverFn of Object.values(serverFnsById)) {
    const workspacePath = toWorkspacePath(root, serverFn.filename);
    const code = workspacePath ? fileMap.get(workspacePath) : undefined;

    if (!workspacePath || !code) {
      continue;
    }

    const splitId = `${toAbsoluteModuleId(root, workspacePath)}?tss-serverfn-split`;
    const splitResult = await compilers.server.compile({
      code,
      id: splitId,
      parserFilename: toAbsoluteModuleId(root, workspacePath),
      detectedKinds: detectKindsInCode(code, "server"),
    });

    if (splitResult?.code) {
      transformed.serverSplits[`${workspacePath}?tss-serverfn-split`] = splitResult.code;
    }
  }

  const resolverModule = [
    "const manifest = {",
    ...Object.entries(serverFnsById).map(([id, serverFn]) => {
      const splitPath = toWorkspaceModuleId(root, serverFn.extractedFilename);
      return `${JSON.stringify(id)}: { functionName: ${JSON.stringify(
        serverFn.functionName,
      )}, module: ${JSON.stringify(splitPath)} },`;
    }),
    "};",
    "export async function getServerFnById(id) {",
    "  const entry = manifest[id];",
    "  if (!entry) throw new Error('Server function info not found for ' + id);",
    "  return entry;",
    "}",
  ].join("\n");

  return {
    serverFnsById,
    transformed,
    resolverModule,
  };
}

async function readInput() {
  let input = "";

  for await (const chunk of process.stdin) {
    input += chunk.toString("utf8");
  }

  return JSON.parse(input);
}

async function main() {
  const startedAt = performance.now();
  let result;

  try {
    const payload = await readInput();
    const compiled = await compileWithStartCore(payload.files ?? []);

    result = {
      success: true,
      ...compiled,
      diagnostics: [
        createDiagnostic(
          "info",
          `Compiled with @tanstack/start-plugin-core internals in ${Math.round(
            performance.now() - startedAt,
          )}ms.`,
        ),
      ],
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    result = {
      success: false,
      diagnostics: normalizeBuildError(error),
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  process.stdout.write(
    `\n${resultStartMarker}\n${JSON.stringify(result)}\n${resultEndMarker}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
