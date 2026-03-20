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

  if (!map.has("index.html")) {
    throw new Error("The stateless compiler requires index.html.");
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
  const html = files.get("index.html");

  if (!html) {
    throw new Error("The stateless compiler requires index.html.");
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
  };
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

function createWorkspacePlugin(files) {
  return {
    name: "tuto-serverless-esbuild-workspace",
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

        if (args.path.startsWith("node:")) {
          return null;
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
    },
  };
}

async function compileServerlessWorkspaceRuntime(files) {
  const startedAt = Date.now();

  try {
    const fileMap = sanitizeWorkspaceFiles(files);
    const { entryPath, html } = extractEntryPoint(fileMap);
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
      plugins: [createWorkspacePlugin(fileMap)],
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
