"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_module = require("node:module");
var import_node_path = __toESM(require("node:path"));
var import_node_url = require("node:url");
var import_esbuild = require("esbuild");
var import_parseAst = require("rolldown/parseAst");
var import_transforms = require("@vitejs/plugin-rsc/transforms");
var import_oxide = require("@tailwindcss/oxide");
var import_tailwindcss = require("tailwindcss");
var import_kernel_manifest_generated = __toESM(require("./kernel-manifest.generated.json"));
var import_client_route_fetch = require("./client-route-fetch.generated.cjs");
var import_server_functions_transform = require("./server-functions-transform.generated.cjs");
const require2 = (0, import_node_module.createRequire)(__filename);
const path = import_node_path.default.posix;
const absoluteWorkingDirectory = process.cwd();
const resultStartMarker = "__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_END__";
const virtualWorkspaceRoot = "/__tuto_tanstack_start_core__";
const maxFileCount = 64;
const maxFileSize = 22e4;
const maxTotalSize = 125e4;
const tailwindSourceExtensions = /* @__PURE__ */ new Set([
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
  "vue"
]);
const tailwindDirectivePattern = /@(?:reference|theme|variant|custom-variant|source|utility|plugin|config|apply|tailwind)\b/;
const tailwindImportPattern = /@import\s+["']tailwindcss(?:\/(?:index|preflight|theme|utilities)(?:\.css)?)?["']/;
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
    id: (0, import_node_crypto.randomUUID)(),
    level,
    message,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    ...details
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
  return normalized.startsWith(`${virtualWorkspaceRoot}/`) ? normalized.slice(virtualWorkspaceRoot.length + 1) : null;
}
function sanitizeWorkspaceFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("At least one file is required.");
  }
  if (files.length > maxFileCount) {
    throw new Error("Too many files for the TanStack Start core preview.");
  }
  const map = /* @__PURE__ */ new Map();
  let totalSize = 0;
  for (const file of files) {
    const normalizedPath = normalizeWorkspacePath(file.path);
    if (!normalizedPath || normalizedPath.includes("..") || normalizedPath.startsWith(".") || path.isAbsolute(normalizedPath)) {
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
        "Workspace snapshot is too large for the TanStack Start core preview."
      );
    }
    map.set(normalizedPath, file.content);
  }
  return map;
}
function loaderForPath(filePath) {
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
function findWorkspaceFile(files, candidatePath) {
  const normalized = normalizeWorkspacePath(candidatePath);
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".css", ".json"];
  if (files.has(normalized)) return normalized;
  for (const extension of extensions) {
    const directPath = extension && normalized.endsWith(extension) ? normalized : `${normalized}${extension}`;
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
    /<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*><\/script>/i
  );
  const rawEntryPath = scriptMatch?.[1] ?? "./src/main.tsx";
  const entryPath = resolveWorkspaceImport(files, rawEntryPath, "index.html") ?? findWorkspaceFile(files, rawEntryPath);
  if (!entryPath) {
    throw new Error(`Unable to resolve the HTML entry script: ${rawEntryPath}`);
  }
  return { html, entryPath };
}
function looksLikeTailwindCss(contents) {
  return tailwindImportPattern.test(contents) || tailwindDirectivePattern.test(contents);
}
function createTailwindScanInputs(files) {
  return [...files.entries()].flatMap(([filePath, content]) => {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    return tailwindSourceExtensions.has(extension) && content ? [{ file: toVirtualWorkspacePath(filePath), content, extension }] : [];
  });
}
function createTailwindScannerSources(compiledCss) {
  if (compiledCss.root === "none") return [];
  if (compiledCss.root === null) {
    return [
      { base: virtualWorkspaceRoot, pattern: "**/*", negated: false },
      ...compiledCss.sources
    ];
  }
  return [{ ...compiledCss.root, negated: false }, ...compiledCss.sources];
}
function scanTailwindCandidates(compiledCss, files) {
  const scanner = new import_oxide.Scanner({
    sources: createTailwindScannerSources(compiledCss)
  });
  const candidates = /* @__PURE__ */ new Set();
  for (const input of createTailwindScanInputs(files)) {
    for (const match of scanner.getCandidatesWithPositions(input)) {
      candidates.add(match.candidate);
    }
  }
  return [...candidates];
}
function resolveTailwindPackageStylesheet(id) {
  const match = id.match(
    /^tailwindcss(?:\/(index|preflight|theme|utilities)(?:\.css)?)?$/
  );
  if (!match) return null;
  return require2.resolve(`tailwindcss/${match[1] ?? "index"}.css`);
}
async function loadTailwindStylesheet(files, id, base) {
  const workspaceFilePath = id.startsWith(".") || id.startsWith("/") ? (() => {
    if (id.startsWith("/")) return findWorkspaceFile(files, id);
    const workspaceBasePath = base ? fromVirtualWorkspacePath(base) : null;
    return workspaceBasePath ? findWorkspaceFile(
      files,
      path.normalize(path.join(workspaceBasePath, id))
    ) : null;
  })() : findWorkspaceFile(files, id);
  if (workspaceFilePath) {
    return {
      path: toVirtualWorkspacePath(workspaceFilePath),
      base: path.dirname(toVirtualWorkspacePath(workspaceFilePath)),
      content: files.get(workspaceFilePath) ?? ""
    };
  }
  const diskPath = resolveTailwindPackageStylesheet(id) ?? require2.resolve(id, {
    paths: [absoluteWorkingDirectory]
  });
  return {
    path: diskPath,
    base: import_node_path.default.dirname(diskPath),
    content: await (0, import_promises.readFile)(diskPath, "utf8")
  };
}
async function loadTailwindModule(id, _base, resourceHint) {
  if (id.startsWith(".") || id.startsWith("/")) {
    throw new Error(
      `Tailwind ${resourceHint} modules must come from installed packages in the core preview.`
    );
  }
  const resolvedPath = require2.resolve(id, {
    paths: [absoluteWorkingDirectory]
  });
  const loadedModule = await import((0, import_node_url.pathToFileURL)(resolvedPath).href);
  return {
    path: resolvedPath,
    base: import_node_path.default.dirname(resolvedPath),
    module: loadedModule.default ?? loadedModule
  };
}
async function compileTailwindCss(files, filePath, contents) {
  if (!looksLikeTailwindCss(contents)) return contents;
  const virtualFilePath = toVirtualWorkspacePath(filePath);
  const compiledCss = await (0, import_tailwindcss.compile)(contents, {
    base: path.dirname(virtualFilePath),
    from: virtualFilePath,
    loadModule: (id, base, resourceHint) => loadTailwindModule(id, base, resourceHint),
    loadStylesheet: (id, base) => loadTailwindStylesheet(files, id, base),
    polyfills: 3
  });
  let candidates = [];
  if (compiledCss.root !== "none" && (compiledCss.features & 16) !== 0) {
    candidates = scanTailwindCandidates(compiledCss, files);
  }
  return compiledCss.build(candidates);
}
function createKernelExternalPlugin(target) {
  const targetManifest = import_kernel_manifest_generated.default[target];
  const modules = new Set(targetManifest.modules);
  return {
    name: `tuto-tanstack-start-${target}-kernel-externals`,
    setup(buildApi) {
      buildApi.onResolve(
        { filter: /.*/ },
        (args) => modules.has(args.path) ? {
          path: args.path,
          namespace: `tuto-${target}-kernel-external`
        } : null
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: `tuto-${target}-kernel-external` },
        (args) => {
          const exportNames = targetManifest.exports[args.path];
          if (!exportNames) {
            throw new Error(
              `Missing ${target} kernel exports for ${args.path}.`
            );
          }
          const namedExports = exportNames.filter(
            (name) => name !== "default" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
          );
          const declarations = namedExports.map(
            (name, index) => `const value${index} = moduleValue[${JSON.stringify(
              name
            )}]; export { value${index} as ${name} };`
          );
          const defaultExport = exportNames.includes("default") ? "export default moduleValue.default;" : "";
          return {
            contents: `
const kernel = globalThis[${JSON.stringify(targetManifest.globalKey)}];
if (!kernel || kernel.id !== ${JSON.stringify(import_kernel_manifest_generated.default.id)}) {
  throw new Error('TanStack Start ${target} kernel ${import_kernel_manifest_generated.default.id} is not loaded.');
}
const moduleValue = kernel.modules[${JSON.stringify(args.path)}];
if (!moduleValue) throw new Error('Missing TanStack Start kernel module: ${args.path}');
${declarations.join("\n")}
${defaultExport}
`,
            loader: "js"
          };
        }
      );
    }
  };
}
function rscReferenceKey(filePath) {
  return `tuto-rsc-${(0, import_node_crypto.createHash)("sha256").update(filePath).digest("hex").slice(0, 20)}`;
}
async function isUseClientModule(source) {
  if (!source.includes("use client")) return false;
  const ast = await (0, import_parseAst.parseAstAsync)(source, { lang: "tsx" });
  return (0, import_transforms.hasDirective)(
    ast.body,
    "use client"
  );
}
async function collectRscClientReferences(files) {
  const references = {};
  await Promise.all(
    [...files.entries()].map(async ([filePath, source]) => {
      if (loaderForPath(filePath) === "css") return;
      if (await isUseClientModule(source)) {
        references[rscReferenceKey(filePath)] = filePath;
      }
    })
  );
  return references;
}
function createRscWorkspacePlugin({
  clientReferences,
  entrySource,
  files,
  root
}) {
  const referenceByFile = new Map(
    Object.entries(clientReferences).map(([reference, filePath]) => [
      filePath,
      reference
    ])
  );
  return {
    name: "tuto-tanstack-start-rsc-workspace",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^__tuto_rsc_entry__$/ }, () => ({
        path: "__tuto_rsc_entry__",
        namespace: "tuto-rsc-entry"
      }));
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        const rootedModule = (0, import_server_functions_transform.toWorkspaceModuleId)(root, args.path);
        if (files.has(rootedModule)) {
          return { path: rootedModule, namespace: "tuto-rsc-workspace" };
        }
        if (files.has(args.path)) {
          return { path: args.path, namespace: "tuto-rsc-workspace" };
        }
        if (args.namespace === "tuto-rsc-entry" || args.namespace === "tuto-rsc-workspace") {
          const match = resolveWorkspaceImport(files, args.path, args.importer);
          if (match) return { path: match, namespace: "tuto-rsc-workspace" };
        }
        return null;
      });
      buildApi.onLoad({ filter: /.*/, namespace: "tuto-rsc-entry" }, () => ({
        contents: entrySource,
        loader: "js",
        resolveDir: absoluteWorkingDirectory
      }));
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-rsc-workspace" },
        async (args) => {
          const source = files.get(args.path);
          if (typeof source !== "string") return null;
          const loader = loaderForPath(args.path);
          if (loader === "css") return { contents: "", loader: "js" };
          const reference = referenceByFile.get(args.path);
          if (!reference) {
            return {
              contents: source,
              loader,
              resolveDir: absoluteWorkingDirectory
            };
          }
          const ast = await (0, import_parseAst.parseAstAsync)(source, { lang: "tsx" });
          const transformed = (0, import_transforms.transformDirectiveProxyExport)(
            ast,
            {
              code: source,
              directive: "use client",
              keep: false,
              runtime: (name) => `$$registerClientReference(() => { throw new Error(${JSON.stringify(
                `Client reference ${args.path}#${name} cannot execute in the RSC environment.`
              )}); }, ${JSON.stringify(reference)}, ${JSON.stringify(name)})`
            }
          );
          if (!transformed) {
            throw new Error(`Unable to compile RSC client boundary ${args.path}.`);
          }
          return {
            contents: `import { registerClientReference as $$registerClientReference } from '@vitejs/plugin-rsc/react/rsc';
${transformed.output.toString()}`,
            loader,
            resolveDir: absoluteWorkingDirectory
          };
        }
      );
    }
  };
}
function createServerWorkspacePlugin({
  entrySource,
  files,
  resolverSource,
  root
}) {
  return {
    name: "tuto-real-start-server-workspace",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^__tuto_server_entry__$/ }, () => ({
        path: "__tuto_server_entry__",
        namespace: "tuto-server-entry"
      }));
      buildApi.onResolve(
        { filter: /^#tanstack-start-server-fn-resolver$/ },
        () => ({
          path: "#tanstack-start-server-fn-resolver",
          namespace: "tuto-server-resolver"
        })
      );
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        const rootedModule = (0, import_server_functions_transform.toWorkspaceModuleId)(root, args.path);
        if (files.has(rootedModule)) {
          return {
            path: rootedModule,
            namespace: "tuto-server-workspace"
          };
        }
        if (files.has(args.path)) {
          return { path: args.path, namespace: "tuto-server-workspace" };
        }
        if (args.namespace === "tuto-server-workspace" || args.namespace === "tuto-server-resolver") {
          const match = resolveWorkspaceImport(files, args.path, args.importer);
          if (match) return { path: match, namespace: "tuto-server-workspace" };
        }
        return null;
      });
      buildApi.onLoad({ filter: /.*/, namespace: "tuto-server-entry" }, () => ({
        contents: entrySource,
        loader: "js",
        resolveDir: absoluteWorkingDirectory
      }));
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-server-resolver" },
        () => ({
          contents: resolverSource,
          loader: "js",
          resolveDir: absoluteWorkingDirectory
        })
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
            resolveDir: absoluteWorkingDirectory
          };
        }
      );
    }
  };
}
function resolveWorkspaceModule(files, args, root) {
  const rootedModule = root ? (0, import_server_functions_transform.toWorkspaceModuleId)(root, args.path) : null;
  if (rootedModule && files.has(rootedModule)) {
    return { path: rootedModule, namespace: "workspace" };
  }
  if (args.kind === "entry-point") {
    const entryMatch = findWorkspaceFile(files, args.path);
    if (entryMatch) return { path: entryMatch, namespace: "workspace" };
  }
  const workspaceMatch = args.namespace === "workspace" ? resolveWorkspaceImport(files, args.path, args.importer) : null;
  if (workspaceMatch) return { path: workspaceMatch, namespace: "workspace" };
  if (args.path.startsWith("node:")) return null;
  return null;
}
function createWorkspacePlugin(files, root) {
  return {
    name: "tuto-tanstack-start-core-preview-workspace",
    setup(buildApi) {
      buildApi.onResolve(
        { filter: /.*/ },
        (args) => resolveWorkspaceModule(files, args, root)
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: "workspace" },
        async (args) => {
          const contents = files.get(args.path);
          if (typeof contents !== "string") return null;
          const loader = loaderForPath(args.path);
          return {
            contents: loader === "css" ? await compileTailwindCss(files, args.path, contents) : contents,
            loader,
            resolveDir: absoluteWorkingDirectory
          };
        }
      );
    }
  };
}
function injectPreviewAssets({
  html,
  cssText,
  jsText
}) {
  let nextHtml = html.replace(
    /<script\b[^>]*type=["']module["'][^>]*src=["'][^"']+["'][^>]*><\/script>/i,
    ""
  );
  const styles = cssText ? `<style>${cssText}</style>` : "";
  const kernelScript = `<script src="${import_kernel_manifest_generated.default.client.url}"></script>`;
  const script = `<script type="module">${jsText}</script>`;
  if (nextHtml.includes("</head>")) {
    nextHtml = nextHtml.replace("</head>", () => `${styles}</head>`);
  } else {
    nextHtml = `${styles}${nextHtml}`;
  }
  if (nextHtml.includes("</body>")) {
    return nextHtml.replace(
      "</body>",
      () => `${kernelScript}${script}${previewBridgeScript}</body>`
    );
  }
  return `${nextHtml}${kernelScript}${script}${previewBridgeScript}`;
}
function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function buildFailurePreview(diagnostics) {
  const body = diagnostics.map(
    (diagnostic) => `<article><strong>${escapeHtml(
      diagnostic.filePath ?? "build"
    )}</strong><pre>${escapeHtml(diagnostic.message)}</pre></article>`
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8" /><style>body{margin:0;padding:24px;background:#1e1e1e;color:#f5f5f5;font:14px/1.5 Consolas,monospace}article{border-top:1px solid #333;padding:16px}strong{color:#9cdcfe}pre{white-space:pre-wrap}</style></head><body>${body}</body></html>`;
}
function buildSsrPreviewRedirect(revision, rpcToken) {
  const renderUrl = `/api/serverless/tanstack-start/core-render?revision=${encodeURIComponent(
    revision
  )}&token=${encodeURIComponent(rpcToken)}&path=%2F`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Loading Start preview</title></head><body><script>location.replace(${JSON.stringify(
    renderUrl
  )})</script></body></html>`;
}
function isEsbuildError(error) {
  return typeof error === "object" && error !== null;
}
function normalizeBuildError(error) {
  if (isEsbuildError(error) && Array.isArray(error.errors) && error.errors.length > 0) {
    return error.errors.map(
      (entry) => createDiagnostic(
        "error",
        entry.text || entry.message || "TanStack core preview failed.",
        {
          filePath: entry.location?.file ? normalizeWorkspacePath(entry.location.file) : void 0,
          line: entry.location?.line,
          column: entry.location?.column ? entry.location.column + 1 : void 0
        }
      )
    );
  }
  const message = error instanceof Error ? [error.message, error.stack].filter(Boolean).join("\n") : String(error);
  return [
    createDiagnostic("error", message || "TanStack core preview failed.")
  ];
}
async function buildNativeServerBundle({
  clientAssetUrl,
  cssAssetUrl,
  routeManifest,
  root,
  transform
}) {
  const serverFiles = new Map(transform.serverFiles);
  const startModule = findWorkspaceFile(serverFiles, "src/start");
  const routerModule = findWorkspaceFile(serverFiles, "src/router");
  if (Object.keys(transform.serverFnsById).length === 0 && !routerModule) {
    return { chunks: {}, code: "", frameworkInputs: 0 };
  }
  const entries = [];
  for (const [splitId, splitSource] of transform.serverRouteSplits) {
    serverFiles.set(splitId, splitSource);
  }
  for (const [id, serverFn] of Object.entries(transform.serverFnsById)) {
    const splitModuleId = (0, import_server_functions_transform.toWorkspaceModuleId)(root, serverFn.extractedFilename);
    const splitSource = transform.serverSplits.get(splitModuleId);
    if (!splitSource) {
      throw new Error(`Missing server split for function ${id}.`);
    }
    serverFiles.set(splitModuleId, splitSource);
    entries.push(
      `${JSON.stringify(id)}: () => import(${JSON.stringify(
        splitModuleId
      )}).then((module) => module[${JSON.stringify(serverFn.functionName)}]),`
    );
  }
  const { __root__: rootRouteManifest, ...childRouteManifest } = routeManifest;
  const startInstanceSource = startModule ? `import { startInstance } from ${JSON.stringify(startModule)};
globalThis.${import_kernel_manifest_generated.default.server.startInstanceKey} = startInstance;` : `delete globalThis.${import_kernel_manifest_generated.default.server.startInstanceKey};`;
  const routerSource = routerModule ? `import { getRouter } from ${JSON.stringify(routerModule)};
globalThis.${import_kernel_manifest_generated.default.server.routerKey} = getRouter;
globalThis.${import_kernel_manifest_generated.default.server.manifestKey} = ${JSON.stringify({
    routes: {
      __root__: {
        css: [
          ...cssAssetUrl ? [cssAssetUrl] : [],
          ...rootRouteManifest?.css ?? []
        ],
        preloads: [
          clientAssetUrl,
          ...rootRouteManifest?.preloads ?? []
        ],
        scripts: [
          { attrs: { src: import_kernel_manifest_generated.default.client.url } },
          { attrs: { src: clientAssetUrl, type: "module" } }
        ]
      },
      ...childRouteManifest
    }
  })};` : `delete globalThis.${import_kernel_manifest_generated.default.server.routerKey};
delete globalThis.${import_kernel_manifest_generated.default.server.manifestKey};`;
  const resolverSource = `${startInstanceSource}
${routerSource}
const actions = { ${entries.join("\n")} };
globalThis.${import_kernel_manifest_generated.default.server.resolverKey} = async function getServerFnById(id) {
  const loadAction = actions[id];
  if (!loadAction) throw new Error('Unknown server function: ' + id);
  return loadAction();
}`;
  const entrySource = resolverSource;
  const result = await (0, import_esbuild.build)({
    absWorkingDir: absoluteWorkingDirectory,
    bundle: true,
    charset: "utf8",
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.TSS_SERVER_FN_BASE": JSON.stringify(
        import_kernel_manifest_generated.default.server.serverFnBase
      )
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
        root
      })
    ],
    splitting: true,
    target: ["node22"],
    treeShaking: true,
    write: false
  });
  const output = result.outputFiles.find(
    (file) => file.path.replaceAll("\\", "/").endsWith("/entry.js")
  );
  if (!output)
    throw new Error("The Start server runtime did not produce JavaScript.");
  return {
    chunks: Object.fromEntries(
      result.outputFiles.filter(
        (file) => file.path.endsWith(".js") && file.path !== output.path
      ).map((file) => [relativeOutputName(file.path), file.text])
    ),
    code: output.text,
    frameworkInputs: 0
  };
}
async function buildRscServerBundle({
  clientReferences,
  files,
  root
}) {
  const rscModule = findWorkspaceFile(files, "src/rsc");
  if (!rscModule) return { chunks: {}, code: "" };
  const entrySource = `
import React from 'react';
import RscRoot from ${JSON.stringify(rscModule)};
import { renderToReadableStream } from '@tanstack/react-start/rsc';

globalThis.${import_kernel_manifest_generated.default.rsc.handlerKey} = async function handleRsc(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed.', {
      headers: { allow: 'GET, HEAD' },
      status: 405,
    });
  }
  const stream = renderToReadableStream(
    React.createElement(RscRoot, { requestUrl: request.url }),
  );
  return new Response(request.method === 'HEAD' ? null : stream, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/x-component; charset=utf-8',
      'vary': 'accept',
    },
  });
};
`;
  const result = await (0, import_esbuild.build)({
    absWorkingDir: absoluteWorkingDirectory,
    bundle: true,
    charset: "utf8",
    conditions: ["react-server", "module", "import", "default"],
    define: {
      "import.meta.env.DEV": "false",
      "import.meta.env.__vite_rsc_build__": "true",
      "process.env.NODE_ENV": '"production"'
    },
    entryNames: "chunks/rsc-entry",
    entryPoints: ["__tuto_rsc_entry__"],
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "react",
    legalComments: "none",
    logLevel: "silent",
    chunkNames: "chunks/rsc-[hash]",
    outdir: "/out",
    platform: "node",
    plugins: [
      createKernelExternalPlugin("rsc"),
      createRscWorkspacePlugin({ clientReferences, entrySource, files, root })
    ],
    splitting: true,
    target: ["node22"],
    treeShaking: true,
    write: false
  });
  const entry = result.outputFiles.find(
    (file) => file.path.replaceAll("\\", "/").endsWith("/chunks/rsc-entry.js")
  );
  if (!entry) throw new Error("The RSC runtime did not produce an entry.");
  return {
    chunks: Object.fromEntries(
      result.outputFiles.filter((file) => file.path.endsWith(".js")).map((file) => [relativeOutputName(file.path), file.text])
    ),
    code: entry.text
  };
}
function relativeOutputName(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  const outMarker = "/out/";
  const markerIndex = normalized.lastIndexOf(outMarker);
  return markerIndex === -1 ? path.basename(normalized) : normalized.slice(markerIndex + outMarker.length);
}
function routeChunkUrl(chunkAssetBase, outputName) {
  return `${chunkAssetBase}${encodeURIComponent(outputName)}`;
}
function routeStyleUrl(styleAssetBase, outputName) {
  return `${styleAssetBase}${encodeURIComponent(outputName)}`;
}
function routeStyleLoader(styleUrl) {
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
  routeIds
}) {
  const manifest = {};
  const outputByName = new Map(
    Object.entries(metafile.outputs).map(([outputPath, output]) => [
      relativeOutputName(outputPath),
      output
    ])
  );
  const chunkImportPattern = new RegExp(
    `${chunkAssetBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/?([^"'\\s;]+)`,
    "g"
  );
  function resolveImportedOutputName(currentName, importPath) {
    if (importPath.startsWith(chunkAssetBase)) {
      return decodeURIComponent(
        importPath.slice(chunkAssetBase.length)
      ).replace(/^\/+/, "");
    }
    const relativeName = path.normalize(
      path.join(path.dirname(currentName), importPath)
    );
    if (outputByName.has(relativeName)) return relativeName;
    const directName = importPath.replace(/^\.\//, "").replace(/^\/+/, "");
    return outputByName.has(directName) ? directName : null;
  }
  function collectPreloads(outputName, seen = /* @__PURE__ */ new Set()) {
    if (seen.has(outputName)) return [];
    seen.add(outputName);
    const output = outputByName.get(outputName);
    if (!output) return [];
    const emittedImports = [
      ...(chunks[outputName] ?? "").matchAll(chunkImportPattern)
    ].map((match) => decodeURIComponent(match[1] ?? "")).filter((name) => outputByName.has(name));
    return [
      routeChunkUrl(chunkAssetBase, outputName),
      ...emittedImports.flatMap((name) => collectPreloads(name, seen)),
      ...output.imports.flatMap((entry) => {
        if (entry.kind === "dynamic-import" || entry.external && !entry.path.startsWith(chunkAssetBase))
          return [];
        const importedName = resolveImportedOutputName(outputName, entry.path);
        return importedName ? collectPreloads(importedName, seen) : [];
      })
    ];
  }
  for (const [outputPath, output] of Object.entries(metafile.outputs)) {
    if (!outputPath.endsWith(".js") || relativeOutputName(outputPath) === "entry.js")
      continue;
    const routePath = Object.keys(routeIds).find(
      (workspacePath) => Object.keys(output.inputs).some(
        (inputPath) => inputPath.includes(`${workspacePath}?tsr-split=`)
      )
    );
    if (!routePath) continue;
    const routeId = routeIds[routePath];
    if (!routeId) continue;
    const entry = manifest[routeId] ??= { preloads: [] };
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
function workspacePathFromMetafileInput(inputPath, files) {
  const namespaceSeparator = inputPath.indexOf(":");
  const candidate = namespaceSeparator === -1 ? inputPath : inputPath.slice(namespaceSeparator + 1);
  return files.has(candidate) ? candidate : null;
}
async function buildStaticClientCss({
  entryFiles,
  entryOutputName,
  metafile,
  root
}) {
  const entryOutput = Object.entries(metafile.outputs).find(
    ([outputPath]) => relativeOutputName(outputPath) === entryOutputName
  )?.[1];
  const entryPoint = entryOutput?.entryPoint;
  if (!entryPoint) return "";
  const staticInputs = /* @__PURE__ */ new Set();
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
  const cssInputs = [...staticInputs].map((inputPath) => workspacePathFromMetafileInput(inputPath, entryFiles)).filter((inputPath) => inputPath !== null).filter((inputPath) => loaderForPath(inputPath) === "css");
  if (cssInputs.length === 0) return "";
  const cssEntryPath = "__tuto_ssr_static_css_entry__.js";
  const cssFiles = new Map(entryFiles);
  cssFiles.set(
    cssEntryPath,
    cssInputs.map((inputPath) => `import ${JSON.stringify(`./${inputPath}`)};`).join("\n")
  );
  const result = await (0, import_esbuild.build)({
    absWorkingDir: absoluteWorkingDirectory,
    bundle: true,
    charset: "utf8",
    entryPoints: [cssEntryPath],
    legalComments: "none",
    logLevel: "silent",
    outdir: "/out/static-css",
    platform: "browser",
    plugins: [createWorkspacePlugin(cssFiles, root)],
    write: false
  });
  return result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
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
  rscClientReferences
}) {
  const routerModule = findWorkspaceFile(files, "src/router");
  if (!routerModule)
    return {
      chunks: {},
      code: "",
      css: "",
      cssChunks: {},
      frameworkInputs: 0,
      routeManifest: {}
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
${startModule ? `import { startInstance } from ${JSON.stringify(`./${startModule}`)};` : "const startInstance = undefined;"}

globalThis.${import_kernel_manifest_generated.default.client.routerKey} = getRouter;
globalThis.${import_kernel_manifest_generated.default.client.startInstanceKey} = startInstance;
const rscClientReferences = {
${Object.entries(rscClientReferences).map(
      ([reference, filePath]) => `  ${JSON.stringify(reference)}: () => import(${JSON.stringify(
        `./${filePath}`
      )}),`
    ).join("\n")}
};
globalThis.${import_kernel_manifest_generated.default.client.rscLoaderKey} = async function loadRscClientReference(id) {
  const load = rscClientReferences[id];
  if (!load) throw new Error('Unknown RSC client reference: ' + id);
  return load();
};

const nativeFetch = globalThis.fetch.bind(globalThis);
const createRouteFetch = ${import_client_route_fetch.createTanstackStartRouteFetch.toString()};
globalThis.fetch = createRouteFetch(
  nativeFetch,
  globalThis.location,
  ${JSON.stringify(serverRouteBase)},
);

startTransition(() => {
  hydrateRoot(document, <StrictMode><StartClient /></StrictMode>);
});`
  );
  const result = await (0, import_esbuild.build)({
    absWorkingDir: absoluteWorkingDirectory,
    banner: {
      js: `globalThis.${import_kernel_manifest_generated.default.client.serverFnBaseKey}=${JSON.stringify(
        serverFnBase
      )};`
    },
    bundle: true,
    charset: "utf8",
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.TSS_ROUTER_BASEPATH": '"/"',
      "process.env.TSS_SERVER_FN_BASE": JSON.stringify(serverFnBase)
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
      createWorkspacePlugin(entryFiles, root)
    ],
    target: ["es2022"],
    treeShaking: true,
    metafile: true,
    chunkNames: "chunks/chunk-[hash]",
    splitting: true,
    write: false
  });
  const jsOutput = result.outputFiles.find(
    (file) => file.path.replaceAll("\\", "/").endsWith("/entry.js")
  );
  if (!jsOutput)
    throw new Error("The Start SSR client did not produce JavaScript.");
  const outputByName = new Map(
    Object.entries(result.metafile.outputs).map(([outputPath, output]) => [
      relativeOutputName(outputPath),
      output
    ])
  );
  const chunks = Object.fromEntries(
    result.outputFiles.filter(
      (file) => file.path.endsWith(".js") && file.path !== jsOutput.path
    ).map((file) => {
      const outputName = relativeOutputName(file.path);
      const cssBundle = outputByName.get(outputName)?.cssBundle;
      return [
        outputName,
        cssBundle ? `${routeStyleLoader(
          routeStyleUrl(styleAssetBase, relativeOutputName(cssBundle))
        )}${file.text}` : file.text
      ];
    })
  );
  const cssChunks = Object.fromEntries(
    result.outputFiles.filter(
      (file) => file.path.replaceAll("\\", "/").includes("/chunks/") && file.path.endsWith(".css")
    ).map((file) => [relativeOutputName(file.path), file.text])
  );
  const css = await buildStaticClientCss({
    entryFiles,
    entryOutputName: "entry.js",
    metafile: result.metafile,
    root
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
      routeIds
    })
  };
}
async function compilePreview(files, revision) {
  const startedAt = Date.now();
  const rpcToken = (0, import_node_crypto.randomBytes)(32).toString("base64url");
  const serverFnBase = `/api/serverless/tanstack-start/core-rpc?revision=${encodeURIComponent(
    revision
  )}&token=${encodeURIComponent(rpcToken)}&id=`;
  const assetBase = `/api/serverless/tanstack-start/core-asset?revision=${encodeURIComponent(
    revision
  )}&token=${encodeURIComponent(rpcToken)}&kind=`;
  const serverRouteBase = `/api/serverless/tanstack-start/core-route?revision=${encodeURIComponent(
    revision
  )}&token=${encodeURIComponent(rpcToken)}&path=`;
  const chunkAssetBase = `${assetBase}chunk&name=`;
  const styleAssetBase = `${assetBase}style&name=`;
  try {
    const originalFileMap = sanitizeWorkspaceFiles(files);
    const root = import_node_path.default.join(
      absoluteWorkingDirectory,
      ".tmp",
      "tanstack-start-core"
    );
    const transform = await (0, import_server_functions_transform.transformStartServerFunctions)(originalFileMap, {
      root
    });
    const rscClientReferences = await collectRscClientReferences(originalFileMap);
    const transformed = transform.clientFiles;
    const transformedWithRouteSplits = new Map(transformed);
    for (const [splitId, splitCode] of transform.clientRouteSplits) {
      transformedWithRouteSplits.set(splitId, splitCode);
    }
    const serverFnsById = transform.serverFnsById;
    const { entryPath, html } = extractEntryPoint(transformed);
    const result = await (0, import_esbuild.build)({
      absWorkingDir: absoluteWorkingDirectory,
      banner: {
        js: `globalThis.${import_kernel_manifest_generated.default.client.serverFnBaseKey}=${JSON.stringify(
          serverFnBase
        )};globalThis.__TSS_START_OPTIONS__={...(globalThis.__TSS_START_OPTIONS__??{}),serverFns:{...(globalThis.__TSS_START_OPTIONS__?.serverFns??{}),fetch:(url,init)=>globalThis.fetch(url,{...init,credentials:"include"})}};`
      },
      bundle: true,
      charset: "utf8",
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.TSS_SERVER_FN_BASE": JSON.stringify(serverFnBase)
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
        createWorkspacePlugin(transformedWithRouteSplits, root)
      ],
      target: ["es2022"],
      treeShaking: true,
      write: false
    });
    const jsOutput = result.outputFiles.find(
      (file) => file.path.endsWith(".js")
    );
    const cssOutput = result.outputFiles.find(
      (file) => file.path.endsWith(".css")
    );
    if (!jsOutput)
      throw new Error("The TanStack core preview did not produce JavaScript.");
    const ssrClientBuild = await buildSsrClientBundle({
      chunkAssetBase,
      files: transformed,
      root,
      routeIds: transform.clientRouteIds,
      routeSplits: transform.clientRouteSplits,
      rscClientReferences,
      serverRouteBase,
      serverFnBase,
      styleAssetBase
    });
    const serverBuild = await buildNativeServerBundle({
      clientAssetUrl: `${assetBase}client`,
      ...ssrClientBuild.css ? { cssAssetUrl: `${assetBase}style` } : {},
      routeManifest: ssrClientBuild.routeManifest,
      root,
      transform
    });
    const rscBuild = await buildRscServerBundle({
      clientReferences: rscClientReferences,
      files: transform.serverFiles,
      root
    });
    const serverBundle = rscBuild.code ? `import ${JSON.stringify("./chunks/rsc-entry.js")};
${serverBuild.code}` : serverBuild.code;
    const serverChunks = {
      ...serverBuild.chunks,
      ...rscBuild.chunks
    };
    const durationMs = Date.now() - startedAt;
    const buildMetrics = {
      clientFrameworkInputs: 0,
      clientRevisionBytes: jsOutput.contents.byteLength + Buffer.byteLength(ssrClientBuild.code) + Object.values(ssrClientBuild.chunks).reduce(
        (bytes, chunk) => bytes + Buffer.byteLength(chunk),
        0
      ) + Buffer.byteLength(ssrClientBuild.css) + Object.values(ssrClientBuild.cssChunks).reduce(
        (bytes, chunk) => bytes + Buffer.byteLength(chunk),
        0
      ),
      serverFrameworkInputs: serverBuild.frameworkInputs,
      serverRevisionBytes: Buffer.byteLength(serverBundle) + Object.values(serverChunks).reduce(
        (bytes, chunk) => bytes + Buffer.byteLength(chunk),
        0
      ),
      sharedClientKernelBytes: import_kernel_manifest_generated.default.client.bytes,
      sharedServerKernelBytes: import_kernel_manifest_generated.default.server.bytes + import_kernel_manifest_generated.default.rsc.bytes
    };
    return {
      buildMetrics,
      success: true,
      html: ssrClientBuild.code ? buildSsrPreviewRedirect(revision, rpcToken) : injectPreviewAssets({
        html,
        cssText: cssOutput?.text ?? "",
        jsText: jsOutput.text
      }),
      diagnostics: [
        createDiagnostic(
          "info",
          `TanStack Start core preview compiled ${Object.keys(serverFnsById).length} server function(s) and ${rscBuild.code ? 1 : 0} RSC entry in ${durationMs}ms. Revision bundles: ${buildMetrics.clientRevisionBytes} client bytes and ${buildMetrics.serverRevisionBytes} server bytes; shared kernel ${import_kernel_manifest_generated.default.id}.`
        )
      ],
      durationMs,
      kernelId: import_kernel_manifest_generated.default.id,
      revision,
      routeManifest: ssrClientBuild.routeManifest,
      rpcToken,
      ssrClientBundle: ssrClientBuild.code,
      ssrClientChunks: ssrClientBuild.chunks,
      ssrCss: ssrClientBuild.css,
      ssrCssChunks: ssrClientBuild.cssChunks,
      serverBundle,
      serverChunks,
      serverFnIds: Object.keys(serverFnsById)
    };
  } catch (error) {
    const diagnostics = normalizeBuildError(error);
    return {
      buildMetrics: {
        clientFrameworkInputs: 0,
        clientRevisionBytes: 0,
        serverFrameworkInputs: 0,
        serverRevisionBytes: 0,
        sharedClientKernelBytes: import_kernel_manifest_generated.default.client.bytes,
        sharedServerKernelBytes: import_kernel_manifest_generated.default.server.bytes + import_kernel_manifest_generated.default.rsc.bytes
      },
      success: false,
      html: buildFailurePreview(diagnostics),
      diagnostics,
      durationMs: Date.now() - startedAt,
      kernelId: import_kernel_manifest_generated.default.id,
      revision,
      routeManifest: {},
      rpcToken,
      ssrClientBundle: "",
      ssrClientChunks: {},
      ssrCss: "",
      ssrCssChunks: {},
      serverBundle: "",
      serverChunks: {},
      serverFnIds: []
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
  if (!payload.revision || !/^[a-f0-9]{64}$/.test(payload.revision)) {
    throw new Error("A valid workspace revision is required.");
  }
  const result = await compilePreview(payload.files ?? [], payload.revision);
  process.stdout.write(
    `
${resultStartMarker}
${JSON.stringify(result)}
${resultEndMarker}
`
  );
}
main().catch((error) => {
  process.stderr.write(
    error instanceof Error ? error.stack || error.message : String(error)
  );
  process.exitCode = 1;
});
