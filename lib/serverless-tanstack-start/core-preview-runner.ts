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
  rpcToken: string;
  ssrClientBundle: string;
  ssrCss: string;
  serverBundle: string;
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
}: {
  entrySource: string;
  files: WorkspaceFileMap;
  resolverSource: string;
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

function resolveWorkspaceModule(files: WorkspaceFileMap, args: OnResolveArgs) {
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

function createWorkspacePlugin(files: WorkspaceFileMap): Plugin {
  return {
    name: "tuto-tanstack-start-core-preview-workspace",
    setup(buildApi: PluginBuild) {
      buildApi.onResolve({ filter: /.*/ }, (args: OnResolveArgs) =>
        resolveWorkspaceModule(files, args),
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
  root,
  transform,
}: {
  clientAssetUrl: string;
  cssAssetUrl?: string;
  root: string;
  transform: StartServerFunctionsTransform;
}) {
  const serverFiles = new Map(transform.serverFiles);
  const startModule = findWorkspaceFile(serverFiles, "src/start");
  const routerModule = findWorkspaceFile(serverFiles, "src/router");
  if (Object.keys(transform.serverFnsById).length === 0 && !routerModule) {
    return { code: "", frameworkInputs: 0 };
  }
  const imports: string[] = [];
  const entries: string[] = [];

  for (const [index, [id, serverFn]] of Object.entries(
    transform.serverFnsById,
  ).entries()) {
    const splitModuleId = toWorkspaceModuleId(root, serverFn.extractedFilename);
    const splitSource = transform.serverSplits.get(splitModuleId);
    if (!splitSource) {
      throw new Error(`Missing server split for function ${id}.`);
    }
    serverFiles.set(splitModuleId, splitSource);
    imports.push(
      `import { ${serverFn.functionName} as action${index} } from ${JSON.stringify(
        splitModuleId,
      )};`,
    );
    entries.push(`${JSON.stringify(id)}: action${index},`);
  }

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
            ...(cssAssetUrl ? { css: [cssAssetUrl] } : {}),
            preloads: [clientAssetUrl],
            scripts: [
              { attrs: { src: kernelManifest.client.url } },
              { attrs: { src: clientAssetUrl, type: "module" } },
            ],
          },
        },
      })};`
    : `delete globalThis.${kernelManifest.server.routerKey};
delete globalThis.${kernelManifest.server.manifestKey};`;
  const resolverSource = `${startInstanceSource}
${routerSource}
${imports.join("\n")}
const actions = { ${entries.join("\n")} };
globalThis.${kernelManifest.server.resolverKey} = async function getServerFnById(id) {
  const action = actions[id];
  if (!action) throw new Error('Unknown server function: ' + id);
  return action;
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
    outfile: "/out/server-runtime.js",
    platform: "node",
    plugins: [
      createKernelExternalPlugin("server"),
      createServerWorkspacePlugin({
        entrySource,
        files: serverFiles,
        resolverSource,
      }),
    ],
    target: ["node22"],
    treeShaking: true,
    write: false,
  });
  const output = result.outputFiles.find((file) => file.path.endsWith(".js"));
  if (!output)
    throw new Error("The Start server runtime did not produce JavaScript.");
  return {
    code: output.text,
    frameworkInputs: 0,
  };
}

async function buildSsrClientBundle({
  files,
  serverFnBase,
}: {
  files: WorkspaceFileMap;
  serverFnBase: string;
}) {
  const routerModule = findWorkspaceFile(files, "src/router");
  if (!routerModule) return { code: "", css: "", frameworkInputs: 0 };
  const startModule = findWorkspaceFile(files, "src/start");
  const entryPath = "__tuto_ssr_client_entry__.tsx";
  const entryFiles = new Map(files);
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
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "react",
    legalComments: "none",
    logLevel: "silent",
    outdir: "/out",
    platform: "browser",
    plugins: [
      createKernelExternalPlugin("client"),
      createWorkspacePlugin(entryFiles),
    ],
    target: ["es2022"],
    treeShaking: true,
    write: false,
  });
  const jsOutput = result.outputFiles.find((file) => file.path.endsWith(".js"));
  if (!jsOutput)
    throw new Error("The Start SSR client did not produce JavaScript.");
  const cssOutput = result.outputFiles.find((file) =>
    file.path.endsWith(".css"),
  );
  return {
    code: jsOutput.text,
    css: cssOutput?.text ?? "",
    frameworkInputs: 0,
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
        createWorkspacePlugin(transformed),
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
      files: transformed,
      serverFnBase,
    });
    const serverBuild = await buildNativeServerBundle({
      clientAssetUrl: `${assetBase}client`,
      ...(ssrClientBuild.css ? { cssAssetUrl: `${assetBase}style` } : {}),
      root,
      transform,
    });
    const serverBundle = serverBuild.code;
    const durationMs = Date.now() - startedAt;
    const buildMetrics = {
      clientFrameworkInputs: 0,
      clientRevisionBytes:
        jsOutput.contents.byteLength + Buffer.byteLength(ssrClientBuild.code),
      serverFrameworkInputs: serverBuild.frameworkInputs,
      serverRevisionBytes: Buffer.byteLength(serverBundle),
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
      rpcToken,
      ssrClientBundle: ssrClientBuild.code,
      ssrCss: ssrClientBuild.css,
      serverBundle,
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
      rpcToken,
      ssrClientBundle: "",
      ssrCss: "",
      serverBundle: "",
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
