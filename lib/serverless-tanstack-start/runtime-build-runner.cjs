/* eslint-disable @typescript-eslint/no-require-imports */
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const workspaceRoot = path.join(os.tmpdir(), "tuto-serverless-tanstack-start");
const dependencyRoot = path.join(process.cwd(), "node_modules");
const resultStartMarker = "__TUTO_TANSTACK_START_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_RESULT_END__";
const maxFileCount = 48;
const maxFileSize = 220_000;
const maxTotalSize = 1_250_000;
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

function normalizeWorkspacePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function sanitizeWorkspaceFiles(files) {
  if (files.length === 0) {
    throw new Error("At least one file is required.");
  }

  if (files.length > maxFileCount) {
    throw new Error("Too many files for the TanStack Start runtime.");
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
      throw new Error("Workspace snapshot is too large for the TanStack Start runtime.");
    }

    map.set(normalizedPath, file.content);
  }

  if (!map.has("src/routes/__root.tsx")) {
    throw new Error("The TanStack Start runtime requires src/routes/__root.tsx.");
  }

  if (!map.has("src/routes/index.tsx")) {
    throw new Error("The TanStack Start runtime requires src/routes/index.tsx.");
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
    <title>TanStack Start build failed</title>
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
        <h1>TanStack Start build failed</h1>
      </header>
      ${body}
    </section>
  </body>
</html>`;
}

function normalizeBuildError(error) {
  const errors = Array.isArray(error?.errors) ? error.errors : [];

  if (errors.length > 0) {
    return errors.map((entry) =>
      createDiagnostic("error", entry.message || String(entry), {
        filePath: entry.id || entry.loc?.file,
        line: entry.loc?.line,
        column: entry.loc?.column,
      }),
    );
  }

  const message = [error?.message, error?.stack].filter(Boolean).join("\n");
  return [createDiagnostic("error", message || "TanStack Start runtime failed.")];
}

async function removeIfExists(targetPath) {
  await fs.rm(targetPath, { force: true, recursive: true });
}

async function cleanupOldWorkspaces() {
  try {
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    const now = Date.now();

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const fullPath = path.join(workspaceRoot, entry.name);
          const stat = await fs.stat(fullPath);

          if (now - stat.mtimeMs > cleanupAgeMs) {
            await removeIfExists(fullPath);
          }
        }),
    );
  } catch {
    // Best-effort temp cleanup only.
  }
}

async function ensureDependencyLink(workspaceDirectory) {
  const target = path.join(workspaceDirectory, "node_modules");

  try {
    await fs.symlink(dependencyRoot, target, "junction");
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
}

async function ensureWorkspaceScaffold(fileMap, workspaceDirectory) {
  if (!fileMap.has("package.json")) {
    await fs.writeFile(
      path.join(workspaceDirectory, "package.json"),
      JSON.stringify(
        {
          name: "tuto-tanstack-start-runtime",
          private: true,
          type: "module",
          scripts: {
            build: "vite build",
          },
          dependencies: {
            "@tanstack/react-router": "^1.170.10",
            "@tanstack/react-start": "^1.168.18",
            "@tailwindcss/vite": "^4.3.0",
            "@vitejs/plugin-react": "^6.0.1",
            vite: "^8.0.1",
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
            lib: ["DOM", "DOM.Iterable", "ES2022"],
            strict: true,
            skipLibCheck: true,
            module: "ESNext",
            moduleResolution: "Bundler",
            jsx: "react-jsx",
            esModuleInterop: true,
            allowSyntheticDefaultImports: true,
            resolveJsonModule: true,
            isolatedModules: true,
            noEmit: true,
          },
          include: ["src"],
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  if (!fileMap.has("vite.config.ts") && !fileMap.has("vite.config.mts")) {
    await fs.writeFile(
      path.join(workspaceDirectory, "vite.config.ts"),
      `import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: "src",
      prerender: {
        enabled: false,
      },
      sitemap: {
        enabled: false,
      },
    }),
    react(),
  ],
});
`,
      "utf8",
    );
  }

  const routerPath = path.join(workspaceDirectory, "src", "router.tsx");
  await fs.mkdir(path.dirname(routerPath), { recursive: true });
  await fs.writeFile(
    routerPath,
    `import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: false,
  });
}
`,
    "utf8",
  );

  if (!fileMap.has("src/styles.css")) {
    await fs.mkdir(path.join(workspaceDirectory, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDirectory, "src", "styles.css"),
      `html { color-scheme: light; }
body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
button, input, textarea, select { font: inherit; }
`,
      "utf8",
    );
  }
}

async function writeWorkspaceFiles(fileMap, workspaceDirectory) {
  for (const [filePath, content] of fileMap.entries()) {
    if (
      filePath === "index.html" ||
      filePath === "src/main.tsx" ||
      filePath === "src/router.tsx" ||
      filePath === "src/routeTree.gen.ts"
    ) {
      continue;
    }

    const targetPath = path.join(workspaceDirectory, ...filePath.split("/"));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
  }
}

function previewBridgeScript() {
  return `<script>
(() => {
  const previewSource = "tuto-serverless-preview-log";
  const toText = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const send = (level, args) => {
    window.parent?.postMessage({
      source: previewSource,
      level,
      message: args.map(toText).join(" "),
      timestamp: new Date().toISOString(),
    }, "*");
  };
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
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function inlineClientAssets(html, workspaceDirectory) {
  const clientDirectory = path.join(workspaceDirectory, "dist", "client");
  let result = html;

  result = await replaceAsync(
    result,
    /<link\b([^>]*?)href=["']([^"']+)["']([^>]*)>/gi,
    async (match, before, href, after) => {
      if (!/rel=["']stylesheet["']/i.test(`${before} ${after}`)) {
        return match;
      }

      const assetPath = path.join(clientDirectory, href.replace(/^\//, ""));
      const css = await readTextIfExists(assetPath);

      return css === null ? "" : `<style data-tuto-start-asset="${escapeHtml(href)}">\n${css}\n</style>`;
    },
  );

  result = await replaceAsync(
    result,
    /<script\b([^>]*?)src=["']([^"']+)["']([^>]*)><\/script>/gi,
    async (_match, before, src, after) => {
      const assetPath = path.join(clientDirectory, src.replace(/^\//, ""));
      const js = await readTextIfExists(assetPath);

      return js === null
        ? ""
        : `<script${before}${after}>\n${js}\n</script>`;
    },
  );

  const cssAssetRefs = new Set(
    [...result.matchAll(/["'](\/assets\/[^"']+\.css)["']/g)].map((match) => match[1]),
  );
  const missingStyleRefs = [];
  for (const href of cssAssetRefs) {
    if (!result.includes(`data-tuto-start-asset="${escapeHtml(href)}"`)) {
      missingStyleRefs.push(href);
    }
  }

  if (missingStyleRefs.length > 0) {
    const styles = [];

    for (const href of missingStyleRefs) {
      const css = await readTextIfExists(path.join(clientDirectory, href.replace(/^\//, "")));

      if (css !== null) {
        styles.push(`<style data-tuto-start-asset="${escapeHtml(href)}">\n${css}\n</style>`);
      }
    }

    if (styles.length > 0) {
      if (result.includes("</head>")) {
        result = result.replace("</head>", () => `${styles.join("\n")}</head>`);
      } else {
        result = `${styles.join("\n")}${result}`;
      }
    }
  }

  if (result.includes("</body>")) {
    return result.replace("</body>", () => `${previewBridgeScript()}</body>`);
  }

  return `${result}${previewBridgeScript()}`;
}

async function replaceAsync(text, pattern, replacer) {
  const matches = [...text.matchAll(pattern)];
  let result = "";
  let lastIndex = 0;

  for (const match of matches) {
    result += text.slice(lastIndex, match.index);
    result += await replacer(...match);
    lastIndex = match.index + match[0].length;
  }

  result += text.slice(lastIndex);
  return result;
}

async function buildAndRender(fileMap, workspaceDirectory) {
  const [{ createBuilder }] = await Promise.all([import("vite")]);

  const builder = await createBuilder({
    root: workspaceDirectory,
    configFile: path.join(workspaceDirectory, "vite.config.ts"),
    logLevel: "silent",
    clearScreen: false,
  });
  await builder.buildApp();

  const serverEntryPath = path.join(workspaceDirectory, "dist", "server", "server.js");
  const imported = await import(`${pathToFileURL(serverEntryPath).toString()}?t=${Date.now()}`);
  const serverBuild = imported.default;

  if (!serverBuild?.fetch) {
    throw new Error("TanStack Start server build did not export a default fetch handler.");
  }

  const response = await serverBuild.fetch(new Request("http://tuto.local/"));
  const html = await response.text();

  if (!response.ok) {
    throw new Error(`TanStack Start render failed with HTTP ${response.status}.\n${html}`);
  }

  return inlineClientAssets(html, workspaceDirectory);
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
    const fileMap = sanitizeWorkspaceFiles(payload.files ?? []);
    const workspaceDirectory = path.join(workspaceRoot, randomUUID());

    await cleanupOldWorkspaces();
    await fs.mkdir(workspaceDirectory, { recursive: true });
    await ensureDependencyLink(workspaceDirectory);
    await ensureWorkspaceScaffold(fileMap, workspaceDirectory);
    await writeWorkspaceFiles(fileMap, workspaceDirectory);

    const html = await buildAndRender(fileMap, workspaceDirectory);

    result = {
      success: true,
      html,
      diagnostics: [
        createDiagnostic(
          "info",
          `Built with the real @tanstack/react-start Vite plugin in ${Math.round(
            performance.now() - startedAt,
          )}ms.`,
        ),
      ],
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    const diagnostics = normalizeBuildError(error);
    result = {
      success: false,
      html: buildFailurePreview(diagnostics),
      diagnostics,
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
