/* eslint-disable @typescript-eslint/no-require-imports */
const { randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const { posix: path } = require("node:path");
const react = require("@vitejs/plugin-react").default;
const { build } = require("vite");
const workspaceRequire = createRequire(process.cwd() + "/");

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

  if (!map.has("index.html") || !map.has("src/main.tsx")) {
    throw new Error("The stateless compiler requires index.html and src/main.tsx.");
  }

  return map;
}

function createVirtualWorkspacePlugin(files) {
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".css", ".json"];
  const toVirtualId = (filePath) => `virtual:workspace/${filePath}`;
  const fromVirtualId = (id) => id.replace(/^virtual:workspace\//, "");

  function findWorkspaceFile(candidatePath) {
    const normalized = normalizeWorkspacePath(candidatePath);

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

  return {
    name: "tuto-serverless-workspace",
    resolveId(source, importer) {
      if (source.startsWith("virtual:workspace/")) {
        return source;
      }

      if (source.startsWith("/")) {
        const absoluteMatch = findWorkspaceFile(source);

        if (absoluteMatch) {
          return toVirtualId(absoluteMatch);
        }
      }

      if (importer?.startsWith("virtual:workspace/")) {
        const importerPath = fromVirtualId(importer);
        const relativeMatch = findWorkspaceFile(
          path.normalize(path.join(path.dirname(importerPath), source)),
        );

        if (relativeMatch) {
          return toVirtualId(relativeMatch);
        }
      }

      if (
        !source.startsWith(".") &&
        !source.startsWith("/") &&
        !source.startsWith("\0")
      ) {
        try {
          return workspaceRequire.resolve(source);
        } catch {
          return null;
        }
      }

      return null;
    },
    load(id) {
      if (!id.startsWith("virtual:workspace/")) {
        return null;
      }

      return files.get(fromVirtualId(id)) ?? null;
    },
  };
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

function inlinePreviewAssets(output) {
  const htmlAsset = output.find(
    (entry) => entry.type === "asset" && entry.fileName.endsWith(".html"),
  );

  if (!htmlAsset) {
    throw new Error("Build did not produce an HTML entry.");
  }

  const assetContents = new Map();

  for (const entry of output) {
    if (entry.type === "chunk") {
      assetContents.set(`/${entry.fileName}`, entry.code);
      continue;
    }

    if (typeof entry.source === "string") {
      assetContents.set(`/${entry.fileName}`, entry.source);
    }
  }

  let html = String(htmlAsset.source);

  html = html.replace(
    /<link\b[^>]*rel="modulepreload"[^>]*>/g,
    "",
  );
  html = html.replace(
    /<link\b[^>]*href="([^"]+)"[^>]*>/g,
    (match, href) => {
      const css = assetContents.get(href);

      if (!css) {
        return match;
      }

      return `<style>${css}</style>`;
    },
  );
  html = html.replace(
    /<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g,
    (match, src) => {
      const script = assetContents.get(src);

      if (!script) {
        return match;
      }

      return `<script type="module">${script}</script>`;
    },
  );

  if (html.includes("</body>")) {
    html = html.replace("</body>", `${previewBridgeScript}</body>`);
  } else {
    html += previewBridgeScript;
  }

  return html;
}

function normalizeBuildError(error) {
  const message = [error?.message, error?.frame].filter(Boolean).join("\n");

  return [
    createDiagnostic("error", message || "Stateless build failed.", {
      filePath: error?.loc?.file ?? error?.id,
      line: error?.loc?.line,
      column: error?.loc?.column,
    }),
  ];
}

async function compileServerlessWorkspaceRuntime(files) {
  const startedAt = Date.now();

  try {
    const fileMap = sanitizeWorkspaceFiles(files);
    const result = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [createVirtualWorkspacePlugin(fileMap), react()],
      build: {
        write: false,
        minify: 'oxc',
        codeSplitting: false,
        cssCodeSplit: false,
        target: "es2022",
        modulePreload: false,
        rollupOptions: {
          input: "virtual:workspace/index.html",
        },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(
      (entry) => entry.output,
    );
    const html = inlinePreviewAssets(outputs);
    const durationMs = Date.now() - startedAt;

    return {
      success: true,
      html,
      diagnostics: [
        createDiagnostic("info", `Stateless build completed in ${durationMs}ms.`),
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

module.exports = {
  compileServerlessWorkspaceRuntime,
};
