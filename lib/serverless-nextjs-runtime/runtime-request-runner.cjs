/* eslint-disable @typescript-eslint/no-require-imports */
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const { createServer } = require("node:http");
const os = require("node:os");
const path = require("node:path");

const nextImport = require("next");
const next = nextImport.default || nextImport;

const workspaceRoot = path.join(os.tmpdir(), "tuto-serverless-nextjs-runtime");
const dependencyRoot = path.join(process.cwd(), "node_modules");
const resultStartMarker = "__TUTO_SERVERLESS_NEXT_RESULT_START__";
const resultEndMarker = "__TUTO_SERVERLESS_NEXT_RESULT_END__";
const maxFileCount = 32;
const maxFileSize = 200_000;
const maxTotalSize = 1_000_000;
const maxLogEntries = 200;
const cleanupAgeMs = 60 * 60 * 1000;

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

function pushLog(logs, level, message) {
  logs.push(createLog(level, message));

  if (logs.length > maxLogEntries) {
    logs.splice(0, logs.length - maxLogEntries);
  }
}

function normalizeWorkspacePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function sanitizeWorkspaceFiles(files) {
  if (files.length === 0) {
    throw new Error("At least one file is required.");
  }

  if (files.length > maxFileCount) {
    throw new Error("Too many files for the stateless Next runtime.");
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
      throw new Error("Workspace snapshot is too large for the stateless Next runtime.");
    }

    map.set(normalizedPath, file.content);
  }

  if (!map.has("app/page.tsx") && !map.has("app/page.jsx")) {
    throw new Error("The stateless Next runtime requires app/page.tsx or app/page.jsx.");
  }

  return map;
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
  return normalized || "GET";
}

function sanitizeRequestHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key, value]) => typeof key === "string" && typeof value === "string" && key.trim(),
    ),
  );
}

function normalizeBuildError(error) {
  const message = [error?.message, error?.stack].filter(Boolean).join("\n");

  return [
    createDiagnostic("error", message || "Stateless Next runtime failed."),
  ];
}

function findPackageManifestPath(packageName) {
  try {
    return require.resolve(`${packageName}/package.json`, {
      paths: [dependencyRoot],
    });
  } catch {
    const entryPath = require.resolve(packageName, {
      paths: [dependencyRoot],
    });
    let currentDirectory = path.dirname(entryPath);

    while (true) {
      const candidatePath = path.join(currentDirectory, "package.json");

      try {
        require("node:fs").accessSync(candidatePath);
        return candidatePath;
      } catch {
        const parentDirectory = path.dirname(currentDirectory);

        if (parentDirectory === currentDirectory) {
          throw new Error(`Unable to locate package.json for ${packageName}.`);
        }

        currentDirectory = parentDirectory;
      }
    }
  }
}

async function readPackageManifest(packageName) {
  const manifestPath = findPackageManifestPath(packageName);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  return {
    manifest,
    packageDirectory: path.dirname(manifestPath),
  };
}

async function collectRuntimePackages(seedPackages) {
  const visited = new Set();
  const packages = [];
  const queue = [...seedPackages];

  while (queue.length > 0) {
    const packageName = queue.shift();

    if (!packageName || visited.has(packageName)) {
      continue;
    }

    visited.add(packageName);

    try {
      const { manifest, packageDirectory } = await readPackageManifest(packageName);
      packages.push({ packageName, packageDirectory });

      for (const dependencyName of Object.keys({
        ...(manifest.dependencies ?? {}),
        ...(manifest.optionalDependencies ?? {}),
        ...(manifest.peerDependencies ?? {}),
      })) {
        if (!visited.has(dependencyName)) {
          queue.push(dependencyName);
        }
      }
    } catch {
      // Skip packages that are not installed for the current environment.
    }
  }

  return packages;
}

async function ensureWorkspaceScaffold(fileMap, workspaceDirectory) {
  if (!fileMap.has("package.json")) {
    await fs.writeFile(
      path.join(workspaceDirectory, "package.json"),
      JSON.stringify(
        {
          name: "serverless-nextjs-runtime",
          private: true,
          dependencies: {
            next: "16.2.0",
            react: "19.2.4",
            "react-dom": "19.2.4",
          },
          devDependencies: {
            typescript: "^5",
            "@types/react": "^19",
            "@types/react-dom": "^19",
            "@types/node": "^20",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  if (!fileMap.has("tsconfig.json")) {
    await fs.writeFile(
      path.join(workspaceDirectory, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["dom", "dom.iterable", "es2022"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
          },
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
          exclude: ["node_modules"],
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  if (!fileMap.has("next-env.d.ts")) {
    await fs.writeFile(
      path.join(workspaceDirectory, "next-env.d.ts"),
      `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file is auto-generated for the stateless Next runtime experiment.
`,
      "utf8",
    );
  }
}

async function writeWorkspaceFiles(fileMap, workspaceDirectory) {
  for (const [filePath, content] of fileMap.entries()) {
    const targetPath = path.join(workspaceDirectory, ...filePath.split("/"));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
  }
}

async function ensureDependencyTree(workspaceDirectory, logs) {
  const targetRoot = path.join(workspaceDirectory, "node_modules");
  const packages = await collectRuntimePackages([
    "next",
    "react",
    "react-dom",
    "typescript",
    "@types/react",
    "@types/react-dom",
    "@types/node",
  ]);

  await fs.mkdir(targetRoot, { recursive: true });
  pushLog(logs, "info", `Staging ${packages.length} runtime packages into temp workspace.`);

  for (const entry of packages) {
    const targetPath = path.join(targetRoot, ...entry.packageName.split("/"));

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.cp(entry.packageDirectory, targetPath, {
      recursive: true,
      force: true,
    });
  }
}

async function pruneOldWorkspaces() {
  await fs.mkdir(workspaceRoot, { recursive: true });
  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - cleanupAgeMs;

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) {
        return;
      }

      const target = path.join(workspaceRoot, entry.name);

      try {
        const stat = await fs.stat(target);

        if (stat.mtimeMs < cutoff) {
          await fs.rm(target, { recursive: true, force: true });
        }
      } catch {
        // Ignore stale cleanup failures.
      }
    }),
  );
}

async function createWorkspace(fileMap, logs) {
  await pruneOldWorkspaces();
  const workspaceDirectory = path.join(workspaceRoot, randomUUID());

  await fs.mkdir(workspaceDirectory, { recursive: true });
  await writeWorkspaceFiles(fileMap, workspaceDirectory);
  await ensureWorkspaceScaffold(fileMap, workspaceDirectory);
  await ensureDependencyTree(workspaceDirectory, logs);

  return workspaceDirectory;
}

async function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        rejectListen(new Error("Unable to determine Next runtime port."));
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

function captureProcessOutput(logs) {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk, encoding, callback) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const trimmed = text.trim();

    if (trimmed) {
      pushLog(logs, "info", trimmed);
    }

    if (typeof callback === "function") {
      callback();
    }

    return true;
  });

  process.stderr.write = ((chunk, encoding, callback) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const trimmed = text.trim();

    if (trimmed) {
      pushLog(logs, "error", trimmed);
    }

    if (typeof callback === "function") {
      callback();
    }

    return true;
  });

  return () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  };
}

async function invokeRequest(workspaceDirectory, request, logs) {
  const app = next({
    dev: true,
    dir: workspaceDirectory,
    hostname: "127.0.0.1",
    port: 0,
    webpack: false,
    turbopack: true,
  });

  pushLog(logs, "info", "Preparing Next runtime.");
  await app.prepare();

  const handler = app.getRequestHandler();
  const server = createServer((req, res) => handler(req, res));
  const port = await listen(server);
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

  try {
    const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
      method,
      headers,
      body: requestBody,
    });
    const responseBody = await response.text();

    pushLog(logs, "info", `Next responded ${response.status} for ${method} ${requestPath}.`);

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody,
      contentType: response.headers.get("content-type") ?? "text/plain; charset=utf-8",
    };
  } finally {
    await closeServer(server).catch(() => undefined);

    if (typeof app.close === "function") {
      await app.close().catch(() => undefined);
    }
  }
}

async function runServerlessNextRuntime(files, request) {
  const startedAt = Date.now();
  const logs = [];
  const fileMap = sanitizeWorkspaceFiles(files);
  const workspaceDirectory = await createWorkspace(fileMap, logs);
  const restoreOutput = captureProcessOutput(logs);

  try {
    const response = await invokeRequest(workspaceDirectory, request || {}, logs);
    const durationMs = Date.now() - startedAt;

    restoreOutput();

    return {
      success: true,
      diagnostics: [
        createDiagnostic(
          "info",
          `Stateless Next runtime completed in ${durationMs}ms.`,
        ),
      ],
      logs,
      response,
      durationMs,
    };
  } catch (error) {
    restoreOutput();

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
    const result = await runServerlessNextRuntime(
      payload.files || [],
      payload.request || {},
    );
    process.stdout.write(
      `${resultStartMarker}\n${JSON.stringify(result)}\n${resultEndMarker}`,
      () => {
      process.exit(0);
      },
    );
  } catch (error) {
    process.stderr.write(
      error instanceof Error ? error.stack || error.message : String(error),
      () => {
        process.exit(1);
      },
    );
  }
});
