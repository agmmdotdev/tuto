/* eslint-disable @typescript-eslint/no-require-imports */
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const nodePath = require("node:path");
const { posix: path } = nodePath;
const { pathToFileURL } = require("node:url");
const { build } = require("esbuild");
const tailwindcss = require("tailwindcss");
const { Scanner } = require("@tailwindcss/oxide");
const {
  transformStartServerFunctions,
} = require("./server-functions-transform.generated.cjs");

const absoluteWorkingDirectory = process.cwd();
const resultStartMarker = "__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_END__";
const virtualWorkspaceRoot = "/__tuto_tanstack_start_core__";
const maxFileCount = 64;
const maxFileSize = 220_000;
const maxTotalSize = 1_250_000;
const tailwindSourceExtensions = new Set([
  "astro", "css", "cts", "html", "js", "jsx", "md", "mdx", "mts", "svelte", "ts", "tsx", "txt", "vue",
]);
const tailwindDirectivePattern =
  /@(?:reference|theme|variant|custom-variant|source|utility|plugin|config|apply|tailwind)\b/;
const tailwindImportPattern =
  /@import\s+["']tailwindcss(?:\/(?:index|preflight|theme|utilities)(?:\.css)?)?["']/;
const previewBridgeScript = `<script>
(() => {
  const previewSource = "tuto-serverless-preview-log";
  const toText = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const send = (level, args) => window.parent?.postMessage({
    source: previewSource,
    level,
    message: args.map(toText).join(" "),
    timestamp: new Date().toISOString(),
  }, "*");
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level];
    console[level] = (...args) => {
      send(level, args);
      return original.apply(console, args);
    };
  }
  window.addEventListener("error", (event) => send("error", [event.message]));
  window.addEventListener("unhandledrejection", (event) => send("error", [event.reason]));
})();
</script>`;

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

function toVirtualWorkspacePath(filePath) {
  return path.join(virtualWorkspaceRoot, normalizeWorkspacePath(filePath));
}

function fromVirtualWorkspacePath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  return normalized.startsWith(`${virtualWorkspaceRoot}/`)
    ? normalized.slice(virtualWorkspaceRoot.length + 1)
    : null;
}

function sanitizeWorkspaceFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("At least one file is required.");
  }

  if (files.length > maxFileCount) {
    throw new Error("Too many files for the TanStack Start core preview.");
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

    if (typeof file.content !== "string") {
      throw new Error(`Unsupported file content for ${normalizedPath}.`);
    }

    if (file.content.length > maxFileSize) {
      throw new Error(`File is too large: ${normalizedPath}`);
    }

    totalSize += file.content.length;

    if (totalSize > maxTotalSize) {
      throw new Error("Workspace snapshot is too large for the TanStack Start core preview.");
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
    case ".css":
      return "css";
    case ".json":
      return "json";
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".svg":
    case ".webp":
    case ".woff":
    case ".woff2":
      return "dataurl";
    default:
      return "file";
  }
}

function findWorkspaceFile(files, candidatePath) {
  const normalized = normalizeWorkspacePath(candidatePath);
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".css", ".json"];

  if (files.has(normalized)) return normalized;

  for (const extension of extensions) {
    const directPath =
      extension && normalized.endsWith(extension) ? normalized : `${normalized}${extension}`;
    if (files.has(directPath)) return directPath;
  }

  for (const extension of extensions.slice(1)) {
    const nestedIndexPath = path.join(normalized, `index${extension}`);
    if (files.has(nestedIndexPath)) return nestedIndexPath;
  }

  return null;
}

function resolveWorkspaceImport(files, source, importerPath) {
  if (source.startsWith("/")) return findWorkspaceFile(files, source);
  if (!source.startsWith(".")) return null;

  const baseDir = importerPath ? path.dirname(importerPath) : "";
  return findWorkspaceFile(files, path.normalize(path.join(baseDir, source)));
}

function extractEntryPoint(files) {
  const html = files.get("index.html");

  if (!html) {
    throw new Error("The TanStack Start core preview requires index.html.");
  }

  const scriptMatch = html.match(
    /<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*><\/script>/i,
  );
  const rawEntryPath = scriptMatch?.[1] ?? "./src/main.tsx";
  const entryPath =
    resolveWorkspaceImport(files, rawEntryPath, "index.html") ??
    findWorkspaceFile(files, rawEntryPath);

  if (!entryPath) {
    throw new Error(`Unable to resolve the HTML entry script: ${rawEntryPath}`);
  }

  return { html, entryPath };
}

function looksLikeTailwindCss(contents) {
  return tailwindImportPattern.test(contents) || tailwindDirectivePattern.test(contents);
}

function createTailwindScanInputs(files) {
  return [...files.entries()]
    .map(([filePath, content]) => {
      const extension = path.extname(filePath).slice(1).toLowerCase();
      return tailwindSourceExtensions.has(extension) && content
        ? { file: toVirtualWorkspacePath(filePath), content, extension }
        : null;
    })
    .filter(Boolean);
}

function createTailwindScannerSources(compiledCss) {
  if (compiledCss.root === "none") return [];
  if (compiledCss.root === null) {
    return [{ base: virtualWorkspaceRoot, pattern: "**/*", negated: false }, ...compiledCss.sources];
  }
  return [{ ...compiledCss.root, negated: false }, ...compiledCss.sources];
}

function scanTailwindCandidates(compiledCss, files) {
  const scanner = new Scanner({
    sources: createTailwindScannerSources(compiledCss),
  });
  const candidates = new Set();

  for (const input of createTailwindScanInputs(files)) {
    for (const match of scanner.getCandidatesWithPositions(input)) {
      candidates.add(match.candidate);
    }
  }

  return [...candidates];
}

function resolveTailwindPackageStylesheet(id) {
  const match = id.match(/^tailwindcss(?:\/(index|preflight|theme|utilities)(?:\.css)?)?$/);
  if (!match) return null;
  return require.resolve(`tailwindcss/${match[1] ?? "index"}.css`);
}

async function loadTailwindStylesheet(files, id, base) {
  const workspaceFilePath =
    id.startsWith(".") || id.startsWith("/")
      ? (() => {
          if (id.startsWith("/")) return findWorkspaceFile(files, id);
          const workspaceBasePath = base ? fromVirtualWorkspacePath(base) : null;
          return workspaceBasePath
            ? findWorkspaceFile(files, path.normalize(path.join(workspaceBasePath, id)))
            : null;
        })()
      : findWorkspaceFile(files, id);

  if (workspaceFilePath) {
    return {
      path: toVirtualWorkspacePath(workspaceFilePath),
      base: path.dirname(toVirtualWorkspacePath(workspaceFilePath)),
      content: files.get(workspaceFilePath),
    };
  }

  const diskPath = resolveTailwindPackageStylesheet(id) ?? require.resolve(id, {
    paths: [absoluteWorkingDirectory],
  });

  return {
    path: diskPath,
    base: nodePath.dirname(diskPath),
    content: await readFile(diskPath, "utf8"),
  };
}

async function loadTailwindModule(id, base, resourceHint) {
  if (id.startsWith(".") || id.startsWith("/")) {
    throw new Error(
      `Tailwind ${resourceHint} modules must come from installed packages in the core preview.`,
    );
  }

  const resolvedPath = require.resolve(id, { paths: [absoluteWorkingDirectory] });
  const loadedModule = await import(pathToFileURL(resolvedPath).href);

  return {
    path: resolvedPath,
    base: nodePath.dirname(resolvedPath),
    module: loadedModule.default ?? loadedModule,
  };
}

async function compileTailwindCss(files, filePath, contents) {
  if (!looksLikeTailwindCss(contents)) return contents;

  const virtualFilePath = toVirtualWorkspacePath(filePath);
  const compiledCss = await tailwindcss.compile(contents, {
    base: path.dirname(virtualFilePath),
    from: virtualFilePath,
    loadModule: (id, base, resourceHint) => loadTailwindModule(id, base, resourceHint),
    loadStylesheet: (id, base) => loadTailwindStylesheet(files, id, base),
    polyfills: tailwindcss.Polyfills.All,
  });
  let candidates = [];

  if (
    compiledCss.root !== "none" &&
    (compiledCss.features & tailwindcss.Features.Utilities) !== 0
  ) {
    candidates = scanTailwindCandidates(compiledCss, files);
  }

  return compiledCss.build(candidates);
}

function createClientRpcShimSource(files) {
  return `
export function createClientRpc(id) {
  const fn = async (payload = {}) => {
    const response = await fetch("/api/serverless/tanstack-start/core-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, payload, files: ${JSON.stringify(files)} }),
    });
    const json = await response.json();
    if (!response.ok || !json.success) {
      throw new Error(json.error || "Server function failed.");
    }
    return { result: json.result, context: json.context || {} };
  };
  fn.serverFnMeta = { id };
  fn.url = "/api/serverless/tanstack-start/core-rpc?id=" + encodeURIComponent(id);
  return fn;
}
`;
}

function createReactStartShimSource() {
  return `
export function createServerFn(options = {}, __opts) {
  const resolvedOptions = __opts || options || {};
  if (typeof resolvedOptions.method === "undefined") {
    resolvedOptions.method = "GET";
  }
  const builder = (nextOptions = {}) => createServerFn(undefined, {
    ...resolvedOptions,
    ...nextOptions,
  });
  builder.middleware = (middleware) => createServerFn(undefined, {
    ...resolvedOptions,
    middleware: [...(resolvedOptions.middleware || []), ...middleware],
  });
  builder.inputValidator = (inputValidator) => createServerFn(undefined, {
    ...resolvedOptions,
    inputValidator,
  });
  builder.handler = (extractedFn) => {
    extractedFn.method = resolvedOptions.method;
    return Object.assign(async (opts) => {
      const response = await extractedFn({
        data: opts?.data,
        headers: opts?.headers || {},
        signal: opts?.signal,
        context: {},
        method: resolvedOptions.method,
      });
      if (response?.error) throw response.error;
      return response?.result;
    }, extractedFn, {
      method: resolvedOptions.method,
    });
  };
  return builder;
}

export function createMiddleware(options = {}) {
  return {
    options,
    middleware: (middleware) => createMiddleware({
      ...options,
      middleware: [...(options.middleware || []), ...middleware],
    }),
    client: (client) => createMiddleware({ ...options, client }),
    server: (server) => createMiddleware({ ...options, server }),
    validator: (inputValidator) => createMiddleware({ ...options, inputValidator }),
  };
}
export const createServerOnlyFn = (fn) => fn;
export const createClientOnlyFn = (fn) => fn;
export const createIsomorphicFn = () => ({ client: (fn) => fn, server: (fn) => fn });
export const createStart = (options) => ({ getOptions: () => options });
`;
}

function createWorkspacePlugin(files, originalFiles) {
  return {
    name: "tuto-tanstack-start-core-preview-workspace",
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === "@tanstack/react-start" || args.path === "@tanstack/start-client-core") {
          return { path: args.path, namespace: "tanstack-start-core-shim" };
        }

        if (args.path === "@tanstack/react-start/client-rpc") {
          return { path: args.path, namespace: "tanstack-start-core-shim" };
        }

        if (args.kind === "entry-point") {
          const entryMatch = findWorkspaceFile(files, args.path);
          if (entryMatch) return { path: entryMatch, namespace: "workspace" };
        }

        const workspaceMatch =
          args.namespace === "workspace"
            ? resolveWorkspaceImport(files, args.path, args.importer)
            : null;

        if (workspaceMatch) return { path: workspaceMatch, namespace: "workspace" };
        if (args.path.startsWith("node:")) return null;

        return null;
      });

      buildApi.onLoad({ filter: /.*/, namespace: "workspace" }, async (args) => {
        const contents = files.get(args.path);
        if (typeof contents !== "string") return null;

        const loader = loaderForPath(args.path);
        return {
          contents:
            loader === "css"
              ? await compileTailwindCss(files, args.path, contents)
              : contents,
          loader,
          resolveDir: absoluteWorkingDirectory,
        };
      });

      buildApi.onLoad({ filter: /.*/, namespace: "tanstack-start-core-shim" }, (args) => ({
        contents:
          args.path === "@tanstack/react-start/client-rpc"
            ? createClientRpcShimSource(
                [...originalFiles.entries()].map(([filePath, content]) => ({
                  path: filePath,
                  content,
                  language: loaderForPath(filePath),
                })),
              )
            : createReactStartShimSource(),
        loader: "js",
        resolveDir: absoluteWorkingDirectory,
      }));
    },
  };
}

function injectPreviewAssets({ html, cssText, jsText }) {
  let nextHtml = html.replace(
    /<script\b[^>]*type=["']module["'][^>]*src=["'][^"']+["'][^>]*><\/script>/i,
    "",
  );
  const styles = cssText ? `<style>${cssText}</style>` : "";
  const script = `<script type="module">${jsText}</script>`;

  if (nextHtml.includes("</head>")) {
    nextHtml = nextHtml.replace("</head>", () => `${styles}</head>`);
  } else {
    nextHtml = `${styles}${nextHtml}`;
  }

  if (nextHtml.includes("</body>")) {
    return nextHtml.replace("</body>", () => `${script}${previewBridgeScript}</body>`);
  }

  return `${nextHtml}${script}${previewBridgeScript}`;
}

function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function buildFailurePreview(diagnostics) {
  const body = diagnostics
    .map((diagnostic) => `<article><strong>${escapeHtml(
      diagnostic.filePath ?? "build",
    )}</strong><pre>${escapeHtml(diagnostic.message)}</pre></article>`)
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8" /><style>body{margin:0;padding:24px;background:#1e1e1e;color:#f5f5f5;font:14px/1.5 Consolas,monospace}article{border-top:1px solid #333;padding:16px}strong{color:#9cdcfe}pre{white-space:pre-wrap}</style></head><body>${body}</body></html>`;
}

function normalizeBuildError(error) {
  if (Array.isArray(error?.errors) && error.errors.length > 0) {
    return error.errors.map((entry) =>
      createDiagnostic("error", entry.text || entry.message || "TanStack core preview failed.", {
        filePath: entry.location?.file ? normalizeWorkspacePath(entry.location.file) : undefined,
        line: entry.location?.line,
        column: entry.location?.column ? entry.location.column + 1 : undefined,
      }),
    );
  }

  const message = [error?.message, error?.stack].filter(Boolean).join("\n");
  return [createDiagnostic("error", message || "TanStack core preview failed.")];
}

async function compilePreview(files) {
  const startedAt = Date.now();

  try {
    const originalFileMap = sanitizeWorkspaceFiles(files);
    const transform = await transformStartServerFunctions(originalFileMap, {
      root: nodePath.join(absoluteWorkingDirectory, ".tmp", "tanstack-start-core"),
    });
    const transformed = transform.clientFiles;
    const serverFnsById = transform.serverFnsById;
    const { entryPath, html } = extractEntryPoint(transformed);
    const result = await build({
      absWorkingDir: absoluteWorkingDirectory,
      bundle: true,
      charset: "utf8",
      define: {
        "process.env.NODE_ENV": '"production"',
      },
      entryPoints: [entryPath],
      format: "esm",
      jsx: "automatic",
      jsxImportSource: "react",
      legalComments: "none",
      logLevel: "silent",
      mainFields: ["browser", "module", "main"],
      minify: true,
      outdir: "/out",
      platform: "browser",
      plugins: [createWorkspacePlugin(transformed, originalFileMap)],
      target: ["es2022"],
      treeShaking: true,
      write: false,
    });
    const jsOutput = result.outputFiles.find((file) => file.path.endsWith(".js"));
    const cssOutput = result.outputFiles.find((file) => file.path.endsWith(".css"));

    if (!jsOutput) throw new Error("The TanStack core preview did not produce JavaScript.");

    const durationMs = Date.now() - startedAt;

    return {
      success: true,
      html: injectPreviewAssets({
        html,
        cssText: cssOutput?.text ?? "",
        jsText: jsOutput.text,
      }),
      diagnostics: [
        createDiagnostic(
          "info",
          `TanStack Start core preview compiled ${Object.keys(serverFnsById).length} server function(s) in ${durationMs}ms.`,
        ),
      ],
      durationMs,
    };
  } catch (error) {
    const diagnostics = normalizeBuildError(error);
    return {
      success: false,
      html: buildFailurePreview(diagnostics),
      diagnostics,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function readInput() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk.toString("utf8");
  return JSON.parse(input);
}

async function main() {
  const payload = await readInput();
  const result = await compilePreview(payload.files ?? []);
  process.stdout.write(
    `\n${resultStartMarker}\n${JSON.stringify(result)}\n${resultEndMarker}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
