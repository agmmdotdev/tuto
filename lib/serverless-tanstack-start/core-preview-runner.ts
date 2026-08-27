import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type {
  Loader,
  OnLoadArgs,
  OnResolveArgs,
  Plugin,
  PluginBuild,
} from "esbuild";
import { Scanner } from "@tailwindcss/oxide";
import type { ChangedContent, SourceEntry } from "@tailwindcss/oxide";
import { compile as compileTailwind } from "tailwindcss";
import kernelManifest from "./kernel-manifest.generated.json";
import { createTanstackStartRouteFetch } from "./client-route-fetch";
import {
  toWorkspaceModuleId,
  transformStartServerFunctions,
  type StartServerFunctionsTransform,
} from "./server-functions-transform";

type BuildDiagnosticLevel = "info" | "warning" | "error";

type BuildDiagnostic = {
  id: string;
  level: BuildDiagnosticLevel;
  message: string;
  timestamp: string;
  filePath?: string;
  line?: number;
  column?: number;
};

type WorkspaceFileInput = {
  path: string;
  content: string;
};

type WorkspaceFileMap = Map<string, string>;

type HtmlEntryPoint = {
  html: string;
  entryPath: string;
};

type TailwindRoot =
  | "none"
  | null
  | {
      base: string;
      pattern: string;
      negated?: boolean;
    };

type CompiledTailwindCss = {
  root: TailwindRoot;
  sources: SourceEntry[];
  features: number;
  build(candidates: string[]): string;
};

type TailwindCompileOptions = NonNullable<
  Parameters<typeof compileTailwind>[1]
>;
type TailwindLoadModule = NonNullable<TailwindCompileOptions["loadModule"]>;
type TailwindLoadStylesheet = NonNullable<
  TailwindCompileOptions["loadStylesheet"]
>;
type TailwindModuleResult = Awaited<ReturnType<TailwindLoadModule>>;
type TailwindStylesheetResult = Awaited<ReturnType<TailwindLoadStylesheet>>;
type RouteManifestEntry = {
  css?: string[];
  preloads: string[];
};
type ServerlessPreviewResult = {
  buildMetrics: {
    clientFrameworkInputs: number;
    clientRevisionBytes: number;
    serverFrameworkInputs: number;
    serverRevisionBytes: number;
    sharedClientKernelBytes: number;
    sharedServerKernelBytes: number;
  };
  success: boolean;
  html: string;
  kernelId: string;
  diagnostics: BuildDiagnostic[];
  durationMs: number;
  revision: string;
  routeManifest: Record<string, RouteManifestEntry>;
  rpcToken: string;
  ssrClientBundle: string;
  ssrClientChunks: Record<string, string>;
  ssrCss: string;
  ssrCssChunks: Record<string, string>;
  serverBundle: string;
  serverChunks: Record<string, string>;
  serverFnIds: string[];
};

type CompilePayload = {
  files?: WorkspaceFileInput[];
  revision?: string;
};

type EsbuildErrorEntry = {
  text?: string;
  message?: string;
  location?: {
    file?: string;
    line?: number;
    column?: number;
  };
};

type EsbuildError = {
  errors?: EsbuildErrorEntry[];
  message?: string;
  stack?: string;
};

const require = createRequire(__filename);
const path = nodePath.posix;
const absoluteWorkingDirectory = process.cwd();
const resultStartMarker = "__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_END__";
const virtualWorkspaceRoot = "/__tuto_tanstack_start_core__";
const maxFileCount = 64;
const maxFileSize = 220_000;
const maxTotalSize = 1_250_000;
const tailwindSourceExtensions = new Set([
  "astro",
  "css",
  "cts",
  "html",
  "js",
  "jsx",
  "md",
  "mdx",
  "mts",
  "svelte",
  "ts",
  "tsx",
  "txt",
  "vue",
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

function createDiagnostic(
  level: BuildDiagnosticLevel,
  message: string,
  details: Partial<BuildDiagnostic> = {},
): BuildDiagnostic {
  return {
    id: randomUUID(),
    level,
    message,
    timestamp: new Date().toISOString(),
    ...details,
  };
}

function normalizeWorkspacePath(filePath: string) {
  return filePath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function toVirtualWorkspacePath(filePath: string) {
  return path.join(virtualWorkspaceRoot, normalizeWorkspacePath(filePath));
}

function fromVirtualWorkspacePath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");

  return normalized.startsWith(`${virtualWorkspaceRoot}/`)
    ? normalized.slice(virtualWorkspaceRoot.length + 1)
    : null;
}

function sanitizeWorkspaceFiles(files: unknown): WorkspaceFileMap {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("At least one file is required.");
  }

  if (files.length > maxFileCount) {
    throw new Error("Too many files for the TanStack Start core preview.");
  }

  const map: WorkspaceFileMap = new Map();
  let totalSize = 0;

  for (const file of files as WorkspaceFileInput[]) {
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
      throw new Error(
        "Workspace snapshot is too large for the TanStack Start core preview.",
      );
    }

    map.set(normalizedPath, file.content);
  }

  return map;
}

function loaderForPath(filePath: string): Loader {
  const extension = path.extname(filePath.split("?")[0]).toLowerCase();

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

function findWorkspaceFile(files: WorkspaceFileMap, candidatePath: string) {
  const normalized = normalizeWorkspacePath(candidatePath);
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".css", ".json"];

  if (files.has(normalized)) return normalized;

  for (const extension of extensions) {
    const directPath =
      extension && normalized.endsWith(extension)
        ? normalized
        : `${normalized}${extension}`;

    if (files.has(directPath)) return directPath;
  }

  for (const extension of extensions.slice(1)) {
    const nestedIndexPath = path.join(normalized, `index${extension}`);

    if (files.has(nestedIndexPath)) return nestedIndexPath;
  }

  return null;
}

function resolveWorkspaceImport(
  files: WorkspaceFileMap,
  source: string,
  importerPath: string,
) {
  if (source.startsWith("/")) return findWorkspaceFile(files, source);
  if (!source.startsWith(".")) return null;

  const baseDir = importerPath ? path.dirname(importerPath) : "";

  return findWorkspaceFile(files, path.normalize(path.join(baseDir, source)));
}

function extractEntryPoint(files: WorkspaceFileMap): HtmlEntryPoint {
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

function looksLikeTailwindCss(contents: string) {
  return (
    tailwindImportPattern.test(contents) ||
    tailwindDirectivePattern.test(contents)
  );
}

function createTailwindScanInputs(files: WorkspaceFileMap): ChangedContent[] {
  return [...files.entries()].flatMap(([filePath, content]) => {
    const extension = path.extname(filePath).slice(1).toLowerCase();

    return tailwindSourceExtensions.has(extension) && content
      ? [{ file: toVirtualWorkspacePath(filePath), content, extension }]
      : [];
  });
}

function createTailwindScannerSources(
  compiledCss: CompiledTailwindCss,
): SourceEntry[] {
  if (compiledCss.root === "none") return [];
  if (compiledCss.root === null) {
    return [
      { base: virtualWorkspaceRoot, pattern: "**/*", negated: false },
      ...compiledCss.sources,
    ];
  }

  return [{ ...compiledCss.root, negated: false }, ...compiledCss.sources];
}

function scanTailwindCandidates(
  compiledCss: CompiledTailwindCss,
  files: WorkspaceFileMap,
) {
  const scanner = new Scanner({
    sources: createTailwindScannerSources(compiledCss),
  });
  const candidates = new Set<string>();

  for (const input of createTailwindScanInputs(files)) {
    for (const match of scanner.getCandidatesWithPositions(input)) {
      candidates.add(match.candidate);
    }
  }

  return [...candidates];
}

function resolveTailwindPackageStylesheet(id: string) {
  const match = id.match(
    /^tailwindcss(?:\/(index|preflight|theme|utilities)(?:\.css)?)?$/,
  );

  if (!match) return null;

  return require.resolve(`tailwindcss/${match[1] ?? "index"}.css`);
}

async function loadTailwindStylesheet(
  files: WorkspaceFileMap,
  id: string,
  base: string,
): Promise<TailwindStylesheetResult> {
  const workspaceFilePath =
    id.startsWith(".") || id.startsWith("/")
      ? (() => {
          if (id.startsWith("/")) return findWorkspaceFile(files, id);
          const workspaceBasePath = base
            ? fromVirtualWorkspacePath(base)
            : null;
          return workspaceBasePath
            ? findWorkspaceFile(
                files,
                path.normalize(path.join(workspaceBasePath, id)),
              )
            : null;
        })()
      : findWorkspaceFile(files, id);

  if (workspaceFilePath) {
    return {
      path: toVirtualWorkspacePath(workspaceFilePath),
      base: path.dirname(toVirtualWorkspacePath(workspaceFilePath)),
      content: files.get(workspaceFilePath) ?? "",
    };
  }

  const diskPath =
    resolveTailwindPackageStylesheet(id) ??
    require.resolve(id, {
      paths: [absoluteWorkingDirectory],
    });

  return {
    path: diskPath,
    base: nodePath.dirname(diskPath),
    content: await readFile(diskPath, "utf8"),
  };
}

async function loadTailwindModule(
  id: string,
  _base: string,
  resourceHint: "plugin" | "config",
): Promise<TailwindModuleResult> {
  if (id.startsWith(".") || id.startsWith("/")) {
    throw new Error(
      `Tailwind ${resourceHint} modules must come from installed packages in the core preview.`,
    );
  }

  const resolvedPath = require.resolve(id, {
    paths: [absoluteWorkingDirectory],
  });
  const loadedModule = await import(pathToFileURL(resolvedPath).href);

  return {
    path: resolvedPath,
    base: nodePath.dirname(resolvedPath),
    module: (loadedModule.default ??
      loadedModule) as TailwindModuleResult["module"],
  };
}

async function compileTailwindCss(
  files: WorkspaceFileMap,
  filePath: string,
  contents: string,
) {
  if (!looksLikeTailwindCss(contents)) return contents;

  const virtualFilePath = toVirtualWorkspacePath(filePath);
  const compiledCss = (await compileTailwind(contents, {
    base: path.dirname(virtualFilePath),
    from: virtualFilePath,
    loadModule: (id: string, base: string, resourceHint: "plugin" | "config") =>
      loadTailwindModule(id, base, resourceHint),
    loadStylesheet: (id: string, base: string) =>
      loadTailwindStylesheet(files, id, base),
    polyfills: 3,
  })) as CompiledTailwindCss;
  let candidates: string[] = [];

  if (compiledCss.root !== "none" && (compiledCss.features & 16) !== 0) {
    candidates = scanTailwindCandidates(compiledCss, files);
  }

  return compiledCss.build(candidates);
}

function createKernelExternalPlugin(target: "client" | "server"): Plugin {
  const targetManifest = kernelManifest[target];
  const modules = new Set<string>(targetManifest.modules);

  return {
    name: `tuto-tanstack-start-${target}-kernel-externals`,
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) =>
        modules.has(args.path)
          ? {
              path: args.path,
              namespace: `tuto-${target}-kernel-external`,
            }
          : null,
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: `tuto-${target}-kernel-external` },
        (args) => {
          const exportNames = (
            targetManifest.exports as Record<string, string[]>
          )[args.path];
          if (!exportNames) {
            throw new Error(
              `Missing ${target} kernel exports for ${args.path}.`,
            );
          }
          const namedExports = exportNames.filter(
            (name) =>
              name !== "default" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name),
          );
          const declarations = namedExports.map(
            (name, index) =>
              `const value${index} = moduleValue[${JSON.stringify(
                name,
              )}]; export { value${index} as ${name} };`,
          );
          const defaultExport = exportNames.includes("default")
            ? "export default moduleValue.default;"
            : "";

          return {
            contents: `
const kernel = globalThis[${JSON.stringify(targetManifest.globalKey)}];
if (!kernel || kernel.id !== ${JSON.stringify(kernelManifest.id)}) {
  throw new Error('TanStack Start ${target} kernel ${kernelManifest.id} is not loaded.');
}
const moduleValue = kernel.modules[${JSON.stringify(args.path)}];
if (!moduleValue) throw new Error('Missing TanStack Start kernel module: ${args.path}');
${declarations.join("\n")}
${defaultExport}
`,
            loader: "js",
          };
        },
      );
    },
  };
}

function createServerWorkspacePlugin({
  entrySource,
  files,
  resolverSource,
  root,
}: {
  entrySource: string;
  files: WorkspaceFileMap;
  resolverSource: string;
  root: string;
}): Plugin {
  return {
    name: "tuto-real-start-server-workspace",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^__tuto_server_entry__$/ }, () => ({
        path: "__tuto_server_entry__",
        namespace: "tuto-server-entry",
      }));
      buildApi.onResolve(
        { filter: /^#tanstack-start-server-fn-resolver$/ },
        () => ({
          path: "#tanstack-start-server-fn-resolver",
          namespace: "tuto-server-resolver",
        }),
      );
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        const rootedModule = toWorkspaceModuleId(root, args.path);
        if (files.has(rootedModule)) {
          return {
            path: rootedModule,
            namespace: "tuto-server-workspace",
          };
        }
        if (files.has(args.path)) {
          return { path: args.path, namespace: "tuto-server-workspace" };
        }
        if (
          args.namespace === "tuto-server-workspace" ||
          args.namespace === "tuto-server-resolver"
        ) {
          const match = resolveWorkspaceImport(files, args.path, args.importer);
          if (match) return { path: match, namespace: "tuto-server-workspace" };
        }
        return null;
      });
      buildApi.onLoad({ filter: /.*/, namespace: "tuto-server-entry" }, () => ({
        contents: entrySource,
        loader: "js",
        resolveDir: absoluteWorkingDirectory,
      }));
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-server-resolver" },
        () => ({
          contents: resolverSource,
          loader: "js",
          resolveDir: absoluteWorkingDirectory,
        }),
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-server-workspace" },
        (args) => {
          const loader = loaderForPath(args.path);
          return {
            // Route modules commonly import their stylesheet. The browser SSR
            // entry compiles that stylesheet separately; the server only needs
            // the module graph and must not try to resolve CSS package imports.
            contents: loader === "css" ? "" : files.get(args.path),
            loader,
            resolveDir: absoluteWorkingDirectory,
          };
        },
      );
    },
  };
}

function resolveWorkspaceModule(
  files: WorkspaceFileMap,
  args: OnResolveArgs,
  root?: string,
) {
  const rootedModule = root ? toWorkspaceModuleId(root, args.path) : null;
  if (rootedModule && files.has(rootedModule)) {
    return { path: rootedModule, namespace: "workspace" };
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
}

function createWorkspacePlugin(files: WorkspaceFileMap, root?: string): Plugin {
  return {
    name: "tuto-tanstack-start-core-preview-workspace",
    setup(buildApi: PluginBuild) {
      buildApi.onResolve({ filter: /.*/ }, (args: OnResolveArgs) =>
        resolveWorkspaceModule(files, args, root),
      );

      buildApi.onLoad(
        { filter: /.*/, namespace: "workspace" },
        async (args: OnLoadArgs) => {
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
        },
      );
    },
  };
}

function injectPreviewAssets({
  html,
  cssText,
  jsText,
}: {
  html: string;
  cssText: string;
  jsText: string;
}) {
  let nextHtml = html.replace(
    /<script\b[^>]*type=["']module["'][^>]*src=["'][^"']+["'][^>]*><\/script>/i,
    "",
  );
  const styles = cssText ? `<style>${cssText}</style>` : "";
  const kernelScript = `<script src="${kernelManifest.client.url}"></script>`;
  const script = `<script type="module">${jsText}</script>`;

  if (nextHtml.includes("</head>")) {
    nextHtml = nextHtml.replace("</head>", () => `${styles}</head>`);
  } else {
    nextHtml = `${styles}${nextHtml}`;
  }

  if (nextHtml.includes("</body>")) {
    return nextHtml.replace(
      "</body>",
      () => `${kernelScript}${script}${previewBridgeScript}</body>`,
    );
  }

  return `${nextHtml}${kernelScript}${script}${previewBridgeScript}`;
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildFailurePreview(diagnostics: BuildDiagnostic[]) {
  const body = diagnostics
    .map(
      (diagnostic) =>
        `<article><strong>${escapeHtml(
          diagnostic.filePath ?? "build",
        )}</strong><pre>${escapeHtml(diagnostic.message)}</pre></article>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8" /><style>body{margin:0;padding:24px;background:#1e1e1e;color:#f5f5f5;font:14px/1.5 Consolas,monospace}article{border-top:1px solid #333;padding:16px}strong{color:#9cdcfe}pre{white-space:pre-wrap}</style></head><body>${body}</body></html>`;
}

function buildSsrPreviewRedirect(revision: string, rpcToken: string) {
  const renderUrl = `/api/serverless/tanstack-start/core-render?revision=${encodeURIComponent(
    revision,
  )}&token=${encodeURIComponent(rpcToken)}&path=%2F`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Loading Start preview</title></head><body><script>location.replace(${JSON.stringify(
    renderUrl,
  )})</script></body></html>`;
}

function isEsbuildError(error: unknown): error is EsbuildError {
  return typeof error === "object" && error !== null;
}

function normalizeBuildError(error: unknown): BuildDiagnostic[] {
  if (
    isEsbuildError(error) &&
    Array.isArray(error.errors) &&
    error.errors.length > 0
  ) {
    return error.errors.map((entry) =>
      createDiagnostic(
        "error",
        entry.text || entry.message || "TanStack core preview failed.",
        {
          filePath: entry.location?.file
            ? normalizeWorkspacePath(entry.location.file)
            : undefined,
          line: entry.location?.line,
          column: entry.location?.column
            ? entry.location.column + 1
            : undefined,
        },
      ),
    );
  }

  const message =
    error instanceof Error
      ? [error.message, error.stack].filter(Boolean).join("\n")
      : String(error);

  return [
    createDiagnostic("error", message || "TanStack core preview failed."),
  ];
}

async function buildNativeServerBundle({
  clientAssetUrl,
  cssAssetUrl,
  routeManifest,
  root,
  transform,
}: {
  clientAssetUrl: string;
  cssAssetUrl?: string;
  routeManifest: Record<string, RouteManifestEntry>;
  root: string;
  transform: StartServerFunctionsTransform;
}) {
  const serverFiles = new Map(transform.serverFiles);
  const startModule = findWorkspaceFile(serverFiles, "src/start");
  const routerModule = findWorkspaceFile(serverFiles, "src/router");
  if (Object.keys(transform.serverFnsById).length === 0 && !routerModule) {
    return { chunks: {}, code: "", frameworkInputs: 0 };
  }
  const entries: string[] = [];

  for (const [splitId, splitSource] of transform.serverRouteSplits) {
    serverFiles.set(splitId, splitSource);
  }

  for (const [id, serverFn] of Object.entries(transform.serverFnsById)) {
    const splitModuleId = toWorkspaceModuleId(root, serverFn.extractedFilename);
    const splitSource = transform.serverSplits.get(splitModuleId);
    if (!splitSource) {
      throw new Error(`Missing server split for function ${id}.`);
    }
    serverFiles.set(splitModuleId, splitSource);
    entries.push(
      `${JSON.stringify(id)}: () => import(${JSON.stringify(
        splitModuleId,
      )}).then((module) => module[${JSON.stringify(serverFn.functionName)}]),`,
    );
  }

  const { __root__: rootRouteManifest, ...childRouteManifest } = routeManifest;

  const startInstanceSource = startModule
    ? `import { startInstance } from ${JSON.stringify(startModule)};
globalThis.${kernelManifest.server.startInstanceKey} = startInstance;`
    : `delete globalThis.${kernelManifest.server.startInstanceKey};`;
  const routerSource = routerModule
    ? `import { getRouter } from ${JSON.stringify(routerModule)};
globalThis.${kernelManifest.server.routerKey} = getRouter;
globalThis.${kernelManifest.server.manifestKey} = ${JSON.stringify({
        routes: {
          __root__: {
            css: [
              ...(cssAssetUrl ? [cssAssetUrl] : []),
              ...(rootRouteManifest?.css ?? []),
            ],
            preloads: [
              clientAssetUrl,
              ...(rootRouteManifest?.preloads ?? []),
            ],
            scripts: [
              { attrs: { src: kernelManifest.client.url } },
              { attrs: { src: clientAssetUrl, type: "module" } },
            ],
          },
          ...childRouteManifest,
        },
      })};`
    : `delete globalThis.${kernelManifest.server.routerKey};
delete globalThis.${kernelManifest.server.manifestKey};`;
  const resolverSource = `${startInstanceSource}
${routerSource}
const actions = { ${entries.join("\n")} };
globalThis.${kernelManifest.server.resolverKey} = async function getServerFnById(id) {
  const loadAction = actions[id];
  if (!loadAction) throw new Error('Unknown server function: ' + id);
  return loadAction();
}`;
  const entrySource = resolverSource;
  const result = await build({
    absWorkingDir: absoluteWorkingDirectory,
    bundle: true,
    charset: "utf8",
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.TSS_SERVER_FN_BASE": JSON.stringify(
        kernelManifest.server.serverFnBase,
      ),
    },
    entryPoints: ["__tuto_server_entry__"],
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "react",
    legalComments: "none",
    logLevel: "silent",
    chunkNames: "chunks/chunk-[hash]",
    entryNames: "entry",
    outdir: "/out",
    platform: "node",
    plugins: [
      createKernelExternalPlugin("server"),
      createServerWorkspacePlugin({
        entrySource,
        files: serverFiles,
        resolverSource,
        root,
      }),
    ],
    splitting: true,
    target: ["node22"],
    treeShaking: true,
    write: false,
  });
  const output = result.outputFiles.find((file) =>
    file.path.replaceAll("\\", "/").endsWith("/entry.js"),
  );
  if (!output)
    throw new Error("The Start server runtime did not produce JavaScript.");
  return {
    chunks: Object.fromEntries(
      result.outputFiles
        .filter(
          (file) => file.path.endsWith(".js") && file.path !== output.path,
        )
        .map((file) => [relativeOutputName(file.path), file.text]),
    ),
    code: output.text,
    frameworkInputs: 0,
  };
}

function relativeOutputName(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  const outMarker = "/out/";
  const markerIndex = normalized.lastIndexOf(outMarker);

  return markerIndex === -1
    ? path.basename(normalized)
    : normalized.slice(markerIndex + outMarker.length);
}

function routeChunkUrl(chunkAssetBase: string, outputName: string) {
  return `${chunkAssetBase}${encodeURIComponent(outputName)}`;
}

function routeStyleUrl(styleAssetBase: string, outputName: string) {
  return `${styleAssetBase}${encodeURIComponent(outputName)}`;
}

function routeStyleLoader(styleUrl: string) {
  return `
if (typeof document !== "undefined") {
  const styleHref = new URL(${JSON.stringify(styleUrl)}, document.baseURI).href;
  const existingStyle = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .find((link) => link.href === styleHref);
  if (!existingStyle) {
    await new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = styleHref;
      link.addEventListener("load", resolve, { once: true });
      link.addEventListener("error", () => reject(new Error("Unable to load route stylesheet.")), { once: true });
      document.head.append(link);
    });
  }
}
`;
}

function buildClientRouteManifest({
  chunks,
  chunkAssetBase,
  styleAssetBase,
  metafile,
  routeIds,
}: {
  chunks: Record<string, string>;
  chunkAssetBase: string;
  styleAssetBase: string;
  metafile: NonNullable<Awaited<ReturnType<typeof build>>["metafile"]>;
  routeIds: Record<string, string>;
}) {
  const manifest: Record<string, RouteManifestEntry> = {};
  const outputByName = new Map(
    Object.entries(metafile.outputs).map(([outputPath, output]) => [
      relativeOutputName(outputPath),
      output,
    ]),
  );
  const chunkImportPattern = new RegExp(
    `${chunkAssetBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/?([^"'\\s;]+)`,
    "g",
  );

  function resolveImportedOutputName(currentName: string, importPath: string) {
    if (importPath.startsWith(chunkAssetBase)) {
      return decodeURIComponent(
        importPath.slice(chunkAssetBase.length),
      ).replace(/^\/+/, "");
    }
    const relativeName = path.normalize(
      path.join(path.dirname(currentName), importPath),
    );
    if (outputByName.has(relativeName)) return relativeName;
    const directName = importPath.replace(/^\.\//, "").replace(/^\/+/, "");
    return outputByName.has(directName) ? directName : null;
  }

  function collectPreloads(
    outputName: string,
    seen = new Set<string>(),
  ): string[] {
    if (seen.has(outputName)) return [];
    seen.add(outputName);
    const output = outputByName.get(outputName);
    if (!output) return [];
    const emittedImports = [
      ...(chunks[outputName] ?? "").matchAll(chunkImportPattern),
    ]
      .map((match) => decodeURIComponent(match[1] ?? ""))
      .filter((name) => outputByName.has(name));

    return [
      routeChunkUrl(chunkAssetBase, outputName),
      ...emittedImports.flatMap((name) => collectPreloads(name, seen)),
      ...output.imports.flatMap((entry) => {
        if (
          entry.kind === "dynamic-import" ||
          (entry.external && !entry.path.startsWith(chunkAssetBase))
        )
          return [];
        const importedName = resolveImportedOutputName(outputName, entry.path);
        return importedName ? collectPreloads(importedName, seen) : [];
      }),
    ];
  }

  for (const [outputPath, output] of Object.entries(metafile.outputs)) {
    if (
      !outputPath.endsWith(".js") ||
      relativeOutputName(outputPath) === "entry.js"
    )
      continue;
    const routePath = Object.keys(routeIds).find((workspacePath) =>
      Object.keys(output.inputs).some((inputPath) =>
        inputPath.includes(`${workspacePath}?tsr-split=`),
      ),
    );
    if (!routePath) continue;
    const routeId = routeIds[routePath];
    if (!routeId) continue;
    const entry = (manifest[routeId] ??= { preloads: [] });
    for (const preload of collectPreloads(relativeOutputName(outputPath))) {
      if (!entry.preloads.includes(preload)) entry.preloads.push(preload);
    }
    if (output.cssBundle) {
      const cssName = relativeOutputName(output.cssBundle);
      const cssUrl = routeStyleUrl(styleAssetBase, cssName);
      entry.css ??= [];
      if (!entry.css.includes(cssUrl)) entry.css.push(cssUrl);
    }
  }

  return manifest;
}

function workspacePathFromMetafileInput(
  inputPath: string,
  files: WorkspaceFileMap,
) {
  const namespaceSeparator = inputPath.indexOf(":");
  const candidate =
    namespaceSeparator === -1
      ? inputPath
      : inputPath.slice(namespaceSeparator + 1);
  return files.has(candidate) ? candidate : null;
}

async function buildStaticClientCss({
  entryFiles,
  entryOutputName,
  metafile,
  root,
}: {
  entryFiles: WorkspaceFileMap;
  entryOutputName: string;
  metafile: NonNullable<Awaited<ReturnType<typeof build>>["metafile"]>;
  root: string;
}) {
  const entryOutput = Object.entries(metafile.outputs).find(
    ([outputPath]) => relativeOutputName(outputPath) === entryOutputName,
  )?.[1];
  const entryPoint = entryOutput?.entryPoint;
  if (!entryPoint) return "";

  const staticInputs = new Set<string>();
  const pending = [entryPoint];
  while (pending.length > 0) {
    const inputPath = pending.pop();
    if (!inputPath || staticInputs.has(inputPath)) continue;
    staticInputs.add(inputPath);
    const input = metafile.inputs[inputPath];
    if (!input) continue;
    for (const imported of input.imports) {
      if (!imported.external && imported.kind !== "dynamic-import") {
        pending.push(imported.path);
      }
    }
  }

  const cssInputs = [...staticInputs]
    .map((inputPath) => workspacePathFromMetafileInput(inputPath, entryFiles))
    .filter((inputPath): inputPath is string => inputPath !== null)
    .filter((inputPath) => loaderForPath(inputPath) === "css");
  if (cssInputs.length === 0) return "";

  const cssEntryPath = "__tuto_ssr_static_css_entry__.js";
  const cssFiles = new Map(entryFiles);
  cssFiles.set(
    cssEntryPath,
    cssInputs
      .map((inputPath) => `import ${JSON.stringify(`./${inputPath}`)};`)
      .join("\n"),
  );
  const result = await build({
    absWorkingDir: absoluteWorkingDirectory,
    bundle: true,
    charset: "utf8",
    entryPoints: [cssEntryPath],
    legalComments: "none",
    logLevel: "silent",
    outdir: "/out/static-css",
    platform: "browser",
    plugins: [createWorkspacePlugin(cssFiles, root)],
    write: false,
  });
  return (
    result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? ""
  );
}

async function buildSsrClientBundle({
  chunkAssetBase,
  files,
  root,
  serverRouteBase,
  serverFnBase,
  styleAssetBase,
  routeIds,
  routeSplits,
}: {
  chunkAssetBase: string;
  files: WorkspaceFileMap;
  root: string;
  serverRouteBase: string;
  serverFnBase: string;
  styleAssetBase: string;
  routeIds: Record<string, string>;
  routeSplits: WorkspaceFileMap;
}) {
  const routerModule = findWorkspaceFile(files, "src/router");
  if (!routerModule)
    return {
      chunks: {},
      code: "",
      css: "",
      cssChunks: {},
      frameworkInputs: 0,
      routeManifest: {},
    };
  const startModule = findWorkspaceFile(files, "src/start");
  const entryPath = "__tuto_ssr_client_entry__.tsx";
  const entryFiles = new Map(files);
  for (const [splitId, splitCode] of routeSplits) {
    entryFiles.set(splitId, splitCode);
  }
  entryFiles.set(
    entryPath,
    `import React, { StrictMode, startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { StartClient } from '@tanstack/react-start/client';
import { getRouter } from ${JSON.stringify(`./${routerModule}`)};
${
  startModule
    ? `import { startInstance } from ${JSON.stringify(`./${startModule}`)};`
    : "const startInstance = undefined;"
}

globalThis.${kernelManifest.client.routerKey} = getRouter;
globalThis.${kernelManifest.client.startInstanceKey} = startInstance;

const nativeFetch = globalThis.fetch.bind(globalThis);
const createRouteFetch = ${createTanstackStartRouteFetch.toString()};
globalThis.fetch = createRouteFetch(
  nativeFetch,
  globalThis.location,
  ${JSON.stringify(serverRouteBase)},
);

startTransition(() => {
  hydrateRoot(document, <StrictMode><StartClient /></StrictMode>);
});`,
  );
  const result = await build({
    absWorkingDir: absoluteWorkingDirectory,
    banner: {
      js: `globalThis.${kernelManifest.client.serverFnBaseKey}=${JSON.stringify(
        serverFnBase,
      )};`,
    },
    bundle: true,
    charset: "utf8",
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.TSS_ROUTER_BASEPATH": '"/"',
      "process.env.TSS_SERVER_FN_BASE": JSON.stringify(serverFnBase),
    },
    entryPoints: [entryPath],
    entryNames: "entry",
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "react",
    legalComments: "none",
    logLevel: "silent",
    outdir: "/out",
    platform: "browser",
    publicPath: chunkAssetBase,
    plugins: [
      createKernelExternalPlugin("client"),
      createWorkspacePlugin(entryFiles, root),
    ],
    target: ["es2022"],
    treeShaking: true,
    metafile: true,
    chunkNames: "chunks/chunk-[hash]",
    splitting: true,
    write: false,
  });
  const jsOutput = result.outputFiles.find((file) =>
    file.path.replaceAll("\\", "/").endsWith("/entry.js"),
  );
  if (!jsOutput)
    throw new Error("The Start SSR client did not produce JavaScript.");
  const outputByName = new Map(
    Object.entries(result.metafile.outputs).map(([outputPath, output]) => [
      relativeOutputName(outputPath),
      output,
    ]),
  );
  const chunks = Object.fromEntries(
    result.outputFiles
      .filter(
        (file) => file.path.endsWith(".js") && file.path !== jsOutput.path,
      )
      .map((file) => {
        const outputName = relativeOutputName(file.path);
        const cssBundle = outputByName.get(outputName)?.cssBundle;
        return [
          outputName,
          cssBundle
            ? `${routeStyleLoader(
                routeStyleUrl(styleAssetBase, relativeOutputName(cssBundle)),
              )}${file.text}`
            : file.text,
        ];
      }),
  );
  const cssChunks = Object.fromEntries(
    result.outputFiles
      .filter((file) =>
        file.path.replaceAll("\\", "/").includes("/chunks/") &&
        file.path.endsWith(".css"),
      )
      .map((file) => [relativeOutputName(file.path), file.text]),
  );
  const css = await buildStaticClientCss({
    entryFiles,
    entryOutputName: "entry.js",
    metafile: result.metafile,
    root,
  });
  return {
    chunks,
    code: jsOutput.text,
    css,
    cssChunks,
    frameworkInputs: 0,
    routeManifest: buildClientRouteManifest({
      chunks,
      chunkAssetBase,
      styleAssetBase,
      metafile: result.metafile,
      routeIds,
    }),
  };
}

async function compilePreview(
  files: unknown,
  revision: string,
): Promise<ServerlessPreviewResult> {
  const startedAt = Date.now();
  const rpcToken = randomBytes(32).toString("base64url");
  const serverFnBase = `/api/serverless/tanstack-start/core-rpc?revision=${encodeURIComponent(
    revision,
  )}&token=${encodeURIComponent(rpcToken)}&id=`;
  const assetBase = `/api/serverless/tanstack-start/core-asset?revision=${encodeURIComponent(
    revision,
  )}&token=${encodeURIComponent(rpcToken)}&kind=`;
  const serverRouteBase = `/api/serverless/tanstack-start/core-route?revision=${encodeURIComponent(
    revision,
  )}&token=${encodeURIComponent(rpcToken)}&path=`;
  const chunkAssetBase = `${assetBase}chunk&name=`;
  const styleAssetBase = `${assetBase}style&name=`;

  try {
    const originalFileMap = sanitizeWorkspaceFiles(files);
    const root = nodePath.join(
      absoluteWorkingDirectory,
      ".tmp",
      "tanstack-start-core",
    );
    const transform = await transformStartServerFunctions(originalFileMap, {
      root,
    });
    const transformed = transform.clientFiles;
    const transformedWithRouteSplits = new Map(transformed);
    for (const [splitId, splitCode] of transform.clientRouteSplits) {
      transformedWithRouteSplits.set(splitId, splitCode);
    }
    const serverFnsById = transform.serverFnsById;
    const { entryPath, html } = extractEntryPoint(transformed);
    const result = await build({
      absWorkingDir: absoluteWorkingDirectory,
      banner: {
        js: `globalThis.${kernelManifest.client.serverFnBaseKey}=${JSON.stringify(
          serverFnBase,
        )};globalThis.__TSS_START_OPTIONS__={...(globalThis.__TSS_START_OPTIONS__??{}),serverFns:{...(globalThis.__TSS_START_OPTIONS__?.serverFns??{}),fetch:(url,init)=>globalThis.fetch(url,{...init,credentials:"include"})}};`,
      },
      bundle: true,
      charset: "utf8",
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.TSS_SERVER_FN_BASE": JSON.stringify(serverFnBase),
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
      plugins: [
        createKernelExternalPlugin("client"),
        createWorkspacePlugin(transformedWithRouteSplits, root),
      ],
      target: ["es2022"],
      treeShaking: true,
      write: false,
    });
    const jsOutput = result.outputFiles.find((file) =>
      file.path.endsWith(".js"),
    );
    const cssOutput = result.outputFiles.find((file) =>
      file.path.endsWith(".css"),
    );

    if (!jsOutput)
      throw new Error("The TanStack core preview did not produce JavaScript.");

    const ssrClientBuild = await buildSsrClientBundle({
      chunkAssetBase,
      files: transformed,
      root,
      routeIds: transform.clientRouteIds,
      routeSplits: transform.clientRouteSplits,
      serverRouteBase,
      serverFnBase,
      styleAssetBase,
    });
    const serverBuild = await buildNativeServerBundle({
      clientAssetUrl: `${assetBase}client`,
      ...(ssrClientBuild.css ? { cssAssetUrl: `${assetBase}style` } : {}),
      routeManifest: ssrClientBuild.routeManifest,
      root,
      transform,
    });
    const serverBundle = serverBuild.code;
    const serverChunks = serverBuild.chunks;
    const durationMs = Date.now() - startedAt;
    const buildMetrics = {
      clientFrameworkInputs: 0,
      clientRevisionBytes:
        jsOutput.contents.byteLength +
        Buffer.byteLength(ssrClientBuild.code) +
        Object.values(ssrClientBuild.chunks).reduce(
          (bytes, chunk) => bytes + Buffer.byteLength(chunk),
          0,
        ) +
        Buffer.byteLength(ssrClientBuild.css) +
        Object.values(ssrClientBuild.cssChunks).reduce(
          (bytes, chunk) => bytes + Buffer.byteLength(chunk),
          0,
        ),
      serverFrameworkInputs: serverBuild.frameworkInputs,
      serverRevisionBytes:
        Buffer.byteLength(serverBundle) +
        Object.values(serverChunks).reduce(
          (bytes, chunk) => bytes + Buffer.byteLength(chunk),
          0,
        ),
      sharedClientKernelBytes: kernelManifest.client.bytes,
      sharedServerKernelBytes: kernelManifest.server.bytes,
    };

    return {
      buildMetrics,
      success: true,
      html: ssrClientBuild.code
        ? buildSsrPreviewRedirect(revision, rpcToken)
        : injectPreviewAssets({
            html,
            cssText: cssOutput?.text ?? "",
            jsText: jsOutput.text,
          }),
      diagnostics: [
        createDiagnostic(
          "info",
          `TanStack Start core preview compiled ${Object.keys(serverFnsById).length} server function(s) in ${durationMs}ms. Revision bundles: ${buildMetrics.clientRevisionBytes} client bytes and ${buildMetrics.serverRevisionBytes} server bytes; shared kernel ${kernelManifest.id}.`,
        ),
      ],
      durationMs,
      kernelId: kernelManifest.id,
      revision,
      routeManifest: ssrClientBuild.routeManifest,
      rpcToken,
      ssrClientBundle: ssrClientBuild.code,
      ssrClientChunks: ssrClientBuild.chunks,
      ssrCss: ssrClientBuild.css,
      ssrCssChunks: ssrClientBuild.cssChunks,
      serverBundle,
      serverChunks,
      serverFnIds: Object.keys(serverFnsById),
    };
  } catch (error) {
    const diagnostics = normalizeBuildError(error);
    return {
      buildMetrics: {
        clientFrameworkInputs: 0,
        clientRevisionBytes: 0,
        serverFrameworkInputs: 0,
        serverRevisionBytes: 0,
        sharedClientKernelBytes: kernelManifest.client.bytes,
        sharedServerKernelBytes: kernelManifest.server.bytes,
      },
      success: false,
      html: buildFailurePreview(diagnostics),
      diagnostics,
      durationMs: Date.now() - startedAt,
      kernelId: kernelManifest.id,
      revision,
      routeManifest: {},
      rpcToken,
      ssrClientBundle: "",
      ssrClientChunks: {},
      ssrCss: "",
      ssrCssChunks: {},
      serverBundle: "",
      serverChunks: {},
      serverFnIds: [],
    };
  }
}

async function readInput(): Promise<CompilePayload> {
  let input = "";

  for await (const chunk of process.stdin) input += chunk.toString("utf8");

  return JSON.parse(input) as CompilePayload;
}

async function main() {
  const payload = await readInput();
  if (!payload.revision || !/^[a-f0-9]{64}$/.test(payload.revision)) {
    throw new Error("A valid workspace revision is required.");
  }
  const result = await compilePreview(payload.files ?? [], payload.revision);
  process.stdout.write(
    `\n${resultStartMarker}\n${JSON.stringify(result)}\n${resultEndMarker}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exitCode = 1;
});
