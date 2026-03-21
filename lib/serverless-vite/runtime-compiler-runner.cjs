/* eslint-disable @typescript-eslint/no-require-imports */
const { randomUUID } = require("node:crypto");
const { build } = require("esbuild");
const { createRequire } = require("node:module");
const { posix: path } = require("node:path");
const workspaceRequire = createRequire(process.cwd() + "/");
const absoluteWorkingDirectory = process.cwd();

const maxFileCount = 32;
const maxFileSize = 200_000;
const maxTotalSize = 1_000_000;
const previewBridgeScript = `<script>
(() => {
  const previewSource = "tuto-serverless-preview-log";
  const toText = (value) => {
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
  };
  const send = (level, args) => {
    window.parent?.postMessage(
      {
        source: previewSource,
        level,
        message: args.map(toText).join(" "),
        timestamp: new Date().toISOString(),
      },
      "*",
    );
  };
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level];
    console[level] = (...args) => {
      send(level, args);
      return original.apply(console, args);
    };
  }
  window.addEventListener("error", (event) => {
    send("error", [event.message]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    send("error", [event.reason]);
  });
})();
</script>`;
const nextAppEntryPath = "__tuto_nextjs_entry__";
const supportedNextShimModules = new Set([
  "next/head",
  "next/image",
  "next/link",
  "next/navigation",
]);
const defaultNextHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Serverless Next.js Playground</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

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
  if (files.length === 0) {
    throw new Error("At least one file is required.");
  }

  if (files.length > maxFileCount) {
    throw new Error("Too many files for the stateless compiler.");
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
      throw new Error("Workspace snapshot is too large for the stateless compiler.");
    }

    map.set(normalizedPath, file.content);
  }

  return map;
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildFailurePreview(diagnostics) {
  const body = diagnostics
    .map((diagnostic) => {
      const location =
        diagnostic.filePath && diagnostic.line
          ? `${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column ?? 1}`
          : diagnostic.filePath ?? "build";

      return `<article><strong>${escapeHtml(location)}</strong><pre>${escapeHtml(
        diagnostic.message,
      )}</pre></article>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Build failed</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        padding: 24px;
        background: #1e1e1e;
        color: #f5f5f5;
        font: 14px/1.5 Consolas, monospace;
      }
      .panel {
        max-width: 960px;
        margin: 0 auto;
        border: 1px solid #3c3c3c;
        border-radius: 18px;
        background: #252526;
        overflow: hidden;
      }
      header {
        padding: 18px 20px;
        border-bottom: 1px solid #3c3c3c;
        background: #2d2d30;
      }
      h1 { margin: 0; font-size: 16px; color: #f48771; }
      article { padding: 18px 20px; border-top: 1px solid #333; }
      article:first-of-type { border-top: 0; }
      strong { display: block; margin-bottom: 10px; color: #9cdcfe; }
      pre { margin: 0; white-space: pre-wrap; color: #d4d4d4; }
    </style>
  </head>
  <body>
    <section class="panel">
      <header>
        <h1>Build failed</h1>
      </header>
      ${body}
    </section>
    ${previewBridgeScript}
  </body>
</html>`;
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
    case ".avif":
    case ".eot":
    case ".gif":
    case ".jpeg":
    case ".jpg":
    case ".otf":
    case ".png":
    case ".svg":
    case ".ttf":
    case ".webp":
    case ".woff":
    case ".woff2":
      return "dataurl";
    case ".txt":
    case ".md":
      return "text";
    default:
      return "file";
  }
}

function findWorkspaceFile(files, candidatePath) {
  const normalized = normalizeWorkspacePath(candidatePath);
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".css", ".json"];

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
  const nextPagePath = findWorkspaceFile(files, "app/page");

  if (nextPagePath) {
    return {
      html: defaultNextHtml,
      entryPath: nextAppEntryPath,
      nextApp: {
        pagePath: nextPagePath,
        layoutPath: findWorkspaceFile(files, "app/layout"),
        globalsPath: findWorkspaceFile(files, "app/globals.css"),
      },
    };
  }

  const html = files.get("index.html");

  if (!html) {
    throw new Error(
      "The stateless compiler requires either index.html or app/page.tsx.",
    );
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

  return {
    html,
    entryPath,
    nextApp: null,
  };
}

function createNextAppEntrySource(nextApp) {
  const pageImportPath = `./${nextApp.pagePath}`;
  const layoutImport = nextApp.layoutPath
    ? `import RootLayout from ${JSON.stringify(`./${nextApp.layoutPath}`)};`
    : `const RootLayout = ({ children }) => children;`;
  const globalsImport = nextApp.globalsPath
    ? `import ${JSON.stringify(`./${nextApp.globalsPath}`)};`
    : "";

  return `
import React from "react";
import ReactDOM from "react-dom/client";
import Page from ${JSON.stringify(pageImportPath)};
${layoutImport}
${globalsImport}

function toChildrenArray(children) {
  return React.Children.toArray(children);
}

function extractText(node) {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(extractText).join("");
  }

  if (React.isValidElement(node)) {
    return extractText(node.props?.children);
  }

  return "";
}

function applyAttributes(element, props) {
  if (!props) {
    return;
  }

  for (const [key, value] of Object.entries(props)) {
    if (
      key === "children" ||
      key === "suppressHydrationWarning" ||
      key.startsWith("on")
    ) {
      continue;
    }

    if (key === "className" && typeof value === "string") {
      element.setAttribute("class", value);
      continue;
    }

    if (key === "style" && value && typeof value === "object") {
      Object.assign(element.style, value);
      continue;
    }

    if (typeof value === "boolean") {
      if (value) {
        element.setAttribute(key, "");
      } else {
        element.removeAttribute(key);
      }
      continue;
    }

    if (value == null) {
      continue;
    }

    element.setAttribute(key, String(value));
  }
}

function unwrapDocument(node) {
  if (!React.isValidElement(node) || node.type !== "html") {
    return {
      renderNode: node,
      htmlProps: {},
      bodyProps: {},
      title: "",
    };
  }

  const htmlProps = node.props ?? {};
  const htmlChildren = toChildrenArray(htmlProps.children);
  const headNode = htmlChildren.find(
    (child) => React.isValidElement(child) && child.type === "head",
  );
  const bodyNode = htmlChildren.find(
    (child) => React.isValidElement(child) && child.type === "body",
  );
  const titleNode =
    React.isValidElement(headNode) &&
    toChildrenArray(headNode.props?.children).find(
      (child) => React.isValidElement(child) && child.type === "title",
    );

  return {
    renderNode:
      React.isValidElement(bodyNode)
        ? React.createElement(React.Fragment, null, bodyNode.props?.children)
        : React.createElement(
            React.Fragment,
            null,
            ...htmlChildren.filter((child) => child !== headNode),
          ),
    htmlProps,
    bodyProps: React.isValidElement(bodyNode) ? bodyNode.props ?? {} : {},
    title: React.isValidElement(titleNode)
      ? extractText(titleNode.props?.children)
      : "",
  };
}

const root = document.getElementById("root");

if (!root) {
  throw new Error('Missing preview root element "#root".');
}

const pageNode = React.createElement(Page);
const layoutTree = React.createElement(RootLayout, { children: pageNode });
const { renderNode, htmlProps, bodyProps, title } = unwrapDocument(layoutTree);

applyAttributes(document.documentElement, htmlProps);
applyAttributes(document.body, bodyProps);

if (title) {
  document.title = title;
}

ReactDOM.createRoot(root).render(renderNode);
`;
}

function createNextShimSource(moduleId) {
  switch (moduleId) {
    case "next/head":
      return `import React from "react"; export default function Head({ children }) { return React.createElement(React.Fragment, null, children); }`;
    case "next/image":
      return `import React from "react"; export default function Image({ src, alt, fill, width, height, style, ...props }) { const resolvedSrc = typeof src === "string" ? src : src?.src ?? ""; const nextStyle = fill ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", ...(style || {}) } : style; return React.createElement("img", { src: resolvedSrc, alt, width: fill ? undefined : width, height: fill ? undefined : height, style: nextStyle, ...props }); }`;
    case "next/link":
      return `import React from "react"; export default function Link({ href, children, ...props }) { const resolvedHref = typeof href === "string" ? href : href?.pathname ?? String(href ?? "#"); return React.createElement("a", { href: resolvedHref, ...props }, children); }`;
    case "next/navigation":
      return `export function useRouter() { return { push(href) { const nextHref = typeof href === "string" ? href : String(href ?? "/"); window.history.pushState({}, "", nextHref); window.dispatchEvent(new PopStateEvent("popstate")); }, replace(href) { const nextHref = typeof href === "string" ? href : String(href ?? "/"); window.history.replaceState({}, "", nextHref); window.dispatchEvent(new PopStateEvent("popstate")); }, back() { window.history.back(); }, forward() { window.history.forward(); }, refresh() { window.location.reload(); }, async prefetch() {} }; } export function usePathname() { return window.location.pathname; } export function useSearchParams() { return new URLSearchParams(window.location.search); }`;
    default:
      return "export {};";
  }
}

function injectPreviewAssets({ html, cssText, jsText }) {
  let nextHtml = html.replace(
    /<script\b[^>]*type=["']module["'][^>]*src=["'][^"']+["'][^>]*><\/script>/gi,
    "",
  );

  if (cssText) {
    if (nextHtml.includes("</head>")) {
      nextHtml = nextHtml.replace("</head>", () => `<style>${cssText}</style></head>`);
    } else {
      nextHtml = `<style>${cssText}</style>${nextHtml}`;
    }
  }

  const scriptTag = `<script type="module">${jsText}</script>`;

  if (nextHtml.includes("</body>")) {
    nextHtml = nextHtml.replace("</body>", () => `${scriptTag}${previewBridgeScript}</body>`);
  } else {
    nextHtml += `${scriptTag}${previewBridgeScript}`;
  }

  return nextHtml;
}

function normalizeBuildError(error) {
  if (Array.isArray(error?.errors) && error.errors.length > 0) {
    return error.errors.map((entry) =>
      createDiagnostic("error", entry.text || "Stateless build failed.", {
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
    createDiagnostic("error", message || "Stateless build failed.", {
      filePath: error?.loc?.file ?? error?.id,
      line: error?.loc?.line,
      column: error?.loc?.column,
    }),
  ];
}

function createWorkspacePlugin(files, nextApp) {
  return {
    name: "tuto-serverless-esbuild-workspace",
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") {
          if (args.path === nextAppEntryPath && nextApp) {
            return {
              path: nextAppEntryPath,
              namespace: "virtual-nextjs",
            };
          }

          const entryMatch = findWorkspaceFile(files, args.path);

          if (entryMatch) {
            return {
              path: entryMatch,
              namespace: "workspace",
            };
          }
        }

        const workspaceMatch =
          args.namespace === "workspace" || args.namespace === "virtual-nextjs"
            ? resolveWorkspaceImport(files, args.path, args.importer)
            : null;

        if (workspaceMatch) {
          return {
            path: workspaceMatch,
            namespace: "workspace",
          };
        }

        if (args.path.startsWith("node:")) {
          return null;
        }

        if (supportedNextShimModules.has(args.path)) {
          return {
            path: args.path,
            namespace: "nextjs-shim",
          };
        }

        if (
          !args.path.startsWith(".") &&
          !args.path.startsWith("/") &&
          !args.path.startsWith("\0")
        ) {
          try {
            return {
              path: workspaceRequire.resolve(args.path),
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

      buildApi.onLoad({ filter: /.*/, namespace: "virtual-nextjs" }, () => ({
        contents: createNextAppEntrySource(nextApp),
        loader: "tsx",
        resolveDir: absoluteWorkingDirectory,
      }));

      buildApi.onLoad({ filter: /.*/, namespace: "nextjs-shim" }, (args) => ({
        contents: createNextShimSource(args.path),
        loader: "js",
        resolveDir: absoluteWorkingDirectory,
      }));
    },
  };
}

async function compileServerlessWorkspaceRuntime(files) {
  const startedAt = Date.now();

  try {
    const fileMap = sanitizeWorkspaceFiles(files);
    const { entryPath, html, nextApp } = extractEntryPoint(fileMap);
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
      plugins: [createWorkspacePlugin(fileMap, nextApp)],
      target: ["es2022"],
      treeShaking: true,
      write: false,
      loader: {
        ".avif": "dataurl",
        ".eot": "dataurl",
        ".gif": "dataurl",
        ".jpeg": "dataurl",
        ".jpg": "dataurl",
        ".otf": "dataurl",
        ".png": "dataurl",
        ".svg": "dataurl",
        ".ttf": "dataurl",
        ".webp": "dataurl",
        ".woff": "dataurl",
        ".woff2": "dataurl",
      },
    });
    const jsOutput = result.outputFiles.find((file) => file.path.endsWith(".js"));
    const cssOutput = result.outputFiles.find((file) => file.path.endsWith(".css"));

    if (!jsOutput) {
      throw new Error("The stateless compiler did not produce a JavaScript bundle.");
    }

    const durationMs = Date.now() - startedAt;
    const previewHtml = injectPreviewAssets({
      html,
      cssText: cssOutput?.text ?? "",
      jsText: jsOutput.text,
    });

    return {
      success: true,
      html: previewHtml,
      diagnostics: [
        createDiagnostic("info", `Stateless esbuild compile completed in ${durationMs}ms.`),
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

let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", async () => {
  try {
    const payload = JSON.parse(input || "{}");
    const result = await compileServerlessWorkspaceRuntime(payload.files || []);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
});
