/* eslint-disable @typescript-eslint/no-require-imports */
const { randomUUID } = require("node:crypto");
const { createServer } = require("node:http");
const { build } = require("esbuild");
const { createRequire, Module, builtinModules } = require("node:module");
const { posix: path } = require("node:path");

const workspaceRequire = createRequire(process.cwd() + "/");
const absoluteWorkingDirectory = process.cwd();

const maxFileCount = 24;
const maxFileSize = 200_000;
const maxTotalSize = 800_000;
const externalBareImports = new Set([
  "express",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function createDiagnostic(level, message, details = {}) {
  return {
    id: randomUUID(),
    level,
    message,
    timestamp: new Date().toISOString(),
    ...details,
  };
}

function createLog(level, message) {
  return {
    id: randomUUID(),
    level,
    message,
    timestamp: new Date().toISOString(),
  };
}

function normalizeWorkspacePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function sanitizeWorkspaceFiles(files) {
  if (files.length === 0) {
    throw new Error("At least one file is required.");
  }

  if (files.length > maxFileCount) {
    throw new Error("Too many files for the stateless Express runner.");
  }

  const map = new Map();
  let totalSize = 0;

  for (const file of files) {
    const normalizedPath = normalizeWorkspacePath(file.path);

    if (
      !normalizedPath ||
      normalizedPath.includes("..") ||
      normalizedPath.startsWith(".") ||
      path.isAbsolute(normalizedPath)
    ) {
      throw new Error(`Unsupported file path: ${file.path}`);
    }

    if (file.content.length > maxFileSize) {
      throw new Error(`File is too large: ${normalizedPath}`);
    }

    totalSize += file.content.length;

    if (totalSize > maxTotalSize) {
      throw new Error("Workspace snapshot is too large for the stateless Express runner.");
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
    case ".txt":
    case ".md":
      return "text";
    default:
      return "file";
  }
}

function findWorkspaceFile(files, candidatePath) {
  const normalized = normalizeWorkspacePath(candidatePath);
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".json"];

  if (files.has(normalized)) {
    return normalized;
  }

  for (const extension of extensions) {
    const directPath =
      extension && normalized.endsWith(extension)
        ? normalized
        : `${normalized}${extension}`;

    if (files.has(directPath)) {
      return directPath;
    }
  }

  for (const extension of extensions.slice(1)) {
    const nestedIndexPath = path.join(normalized, `index${extension}`);

    if (files.has(nestedIndexPath)) {
      return nestedIndexPath;
    }
  }

  return null;
}

function resolveWorkspaceImport(files, source, importerPath) {
  if (source.startsWith("/")) {
    return findWorkspaceFile(files, source);
  }

  if (!source.startsWith(".")) {
    return null;
  }

  const baseDir = importerPath ? path.dirname(importerPath) : "";
  return findWorkspaceFile(files, path.normalize(path.join(baseDir, source)));
}

function extractEntryPoint(files) {
  const entryPath =
    findWorkspaceFile(files, "src/server.ts") ??
    findWorkspaceFile(files, "src/server.js") ??
    findWorkspaceFile(files, "server.ts") ??
    findWorkspaceFile(files, "server.js");

  if (!entryPath) {
    throw new Error("The stateless Express runner requires src/server.ts or server.ts.");
  }

  return entryPath;
}

function normalizeBuildError(error) {
  if (Array.isArray(error?.errors) && error.errors.length > 0) {
    return error.errors.map((entry) =>
      createDiagnostic("error", entry.text || "Stateless Express build failed.", {
        filePath: entry.location?.file
          ? normalizeWorkspacePath(entry.location.file)
          : undefined,
        line: entry.location?.line,
        column: entry.location?.column ? entry.location.column + 1 : undefined,
      }),
    );
  }

  const message = [error?.message, error?.frame].filter(Boolean).join("\n");

  return [
    createDiagnostic("error", message || "Stateless Express build failed.", {
      filePath: error?.loc?.file ?? error?.id,
      line: error?.loc?.line,
      column: error?.loc?.column,
    }),
  ];
}

function createWorkspacePlugin(files) {
  return {
    name: "tuto-serverless-express-workspace",
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") {
          const entryMatch = findWorkspaceFile(files, args.path);

          if (entryMatch) {
            return {
              path: entryMatch,
              namespace: "workspace",
            };
          }
        }

        const workspaceMatch =
          args.namespace === "workspace"
            ? resolveWorkspaceImport(files, args.path, args.importer)
            : null;

        if (workspaceMatch) {
          return {
            path: workspaceMatch,
            namespace: "workspace",
          };
        }

        if (
          !args.path.startsWith(".") &&
          !args.path.startsWith("/") &&
          !args.path.startsWith("\0")
        ) {
          if (externalBareImports.has(args.path)) {
            return {
              path: args.path,
              external: true,
            };
          }

          try {
            workspaceRequire.resolve(args.path);
            return {
              path: args.path,
              external: true,
            };
          } catch {
            return null;
          }
        }

        return null;
      });

      buildApi.onLoad({ filter: /.*/, namespace: "workspace" }, (args) => {
        const contents = files.get(args.path);

        if (typeof contents !== "string") {
          return null;
        }

        return {
          contents,
          loader: loaderForPath(args.path),
          resolveDir: absoluteWorkingDirectory,
        };
      });
    },
  };
}

function loadBundledModule(bundleText) {
  const virtualFilename = path.join(
    absoluteWorkingDirectory.replaceAll("\\", "/"),
    "__serverless_express_bundle__.cjs",
  );
  const runtimeModule = new Module(virtualFilename, module);

  runtimeModule.filename = virtualFilename;
  runtimeModule.paths = Module._nodeModulePaths(absoluteWorkingDirectory);
  runtimeModule._compile(bundleText, virtualFilename);

  return runtimeModule.exports;
}

async function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        rejectListen(new Error("Unable to determine ephemeral Express port."));
        return;
      }

      resolveListen(address.port);
    });
  });
}

async function closeServer(server) {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
}

function sanitizeRequestPath(requestPath) {
  if (typeof requestPath !== "string" || requestPath.trim() === "") {
    return "/";
  }

  const trimmed = requestPath.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function sanitizeRequestMethod(method) {
  if (typeof method !== "string") {
    return "GET";
  }

  const normalized = method.trim().toUpperCase();

  if (!normalized) {
    return "GET";
  }

  return normalized;
}

function sanitizeRequestHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return {};
  }

  const entries = Object.entries(headers).filter(
    ([key, value]) => typeof key === "string" && typeof value === "string" && key.trim(),
  );

  return Object.fromEntries(entries);
}

async function invokeRequest(app, request, logs) {
  const server = createServer(app);
  const port = await listen(server);

  try {
    const method = sanitizeRequestMethod(request.method);
    const requestPath = sanitizeRequestPath(request.path);
    const headers = sanitizeRequestHeaders(request.headers);
    const requestBody =
      method === "GET" || method === "HEAD"
        ? undefined
        : typeof request.body === "string"
          ? request.body
          : "";

    if (requestBody && !headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }

    const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
      method,
      headers,
      body: requestBody,
    });
    const responseBody = await response.text();

    logs.push(
      createLog(
        "info",
        `Express responded ${response.status} for ${method} ${requestPath}.`,
      ),
    );

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody,
      contentType: response.headers.get("content-type") ?? "text/plain; charset=utf-8",
    };
  } finally {
    await closeServer(server);
  }
}

async function runServerlessExpressRequestRuntime(files, request) {
  const startedAt = Date.now();
  const logs = [];

  try {
    const fileMap = sanitizeWorkspaceFiles(files);
    const entryPath = extractEntryPoint(fileMap);
    const buildResult = await build({
      absWorkingDir: absoluteWorkingDirectory,
      bundle: true,
      charset: "utf8",
      entryPoints: [entryPath],
      format: "cjs",
      legalComments: "none",
      logLevel: "silent",
      minify: false,
      outdir: "out",
      platform: "node",
      plugins: [createWorkspacePlugin(fileMap)],
      sourcemap: false,
      target: ["node20"],
      write: false,
    });
    const outputFile = buildResult.outputFiles.find((file) => file.path.endsWith(".js"));

    if (!outputFile) {
      throw new Error("The stateless Express runner did not produce a server bundle.");
    }

    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };

    for (const level of ["log", "info", "warn", "error"]) {
      console[level] = (...args) => {
        logs.push(
          createLog(
            level === "log" ? "info" : level,
            args
              .map((value) => {
                if (value instanceof Error) {
                  return value.stack || value.message;
                }
                if (typeof value === "string") {
                  return value;
                }
                try {
                  return JSON.stringify(value);
                } catch {
                  return String(value);
                }
              })
              .join(" "),
          ),
        );
        return originalConsole[level].apply(console, args);
      };
    }

    let response;

    try {
      const loadedModule = loadBundledModule(outputFile.text);
      const exportedApp =
        loadedModule?.default ?? loadedModule?.app ?? loadedModule;

      if (typeof exportedApp !== "function") {
        throw new Error("The Express workspace must export a default app or request handler.");
      }

      response = await invokeRequest(exportedApp, request || {}, logs);
    } finally {
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
    }

    const durationMs = Date.now() - startedAt;

    return {
      success: true,
      diagnostics: [
        ...buildResult.warnings.map((warning) =>
          createDiagnostic("warn", warning.text || "Stateless Express warning.", {
            filePath: warning.location?.file
              ? normalizeWorkspacePath(warning.location.file)
              : undefined,
            line: warning.location?.line,
            column: warning.location?.column
              ? warning.location.column + 1
              : undefined,
          }),
        ),
        createDiagnostic(
          "info",
          `Stateless Express request completed in ${durationMs}ms.`,
        ),
      ],
      logs,
      response,
      durationMs,
    };
  } catch (error) {
    return {
      success: false,
      diagnostics: normalizeBuildError(error),
      logs,
      response: null,
      durationMs: Date.now() - startedAt,
    };
  }
}

let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", async () => {
  try {
    const payload = JSON.parse(input || "{}");
    const result = await runServerlessExpressRequestRuntime(
      payload.files || [],
      payload.request || {},
    );
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
});
