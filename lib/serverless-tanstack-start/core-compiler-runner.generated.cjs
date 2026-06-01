"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var core_compiler_runner_exports = {};
module.exports = __toCommonJS(core_compiler_runner_exports);
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const {
  transformStartServerFunctions
} = require("./server-functions-transform.generated.cjs");
const resultStartMarker = "__TUTO_TANSTACK_START_CORE_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_RESULT_END__";
const maxFileCount = 64;
const maxFileSize = 22e4;
const maxTotalSize = 125e4;
function createDiagnostic(level, message, details = {}) {
  return {
    id: randomUUID(),
    level,
    message,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    ...details
  };
}
function normalizeWorkspacePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\/+/, "");
}
function sanitizeWorkspaceFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("At least one file is required.");
  }
  if (files.length > maxFileCount) {
    throw new Error("Too many files for the TanStack Start core compiler.");
  }
  const map = /* @__PURE__ */ new Map();
  let totalSize = 0;
  for (const file of files) {
    const normalizedPath = normalizeWorkspacePath(file.path);
    if (!normalizedPath || normalizedPath.includes("..") || normalizedPath.startsWith(".") || path.posix.isAbsolute(normalizedPath)) {
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
      throw new Error("Workspace snapshot is too large for the TanStack Start core compiler.");
    }
    map.set(normalizedPath, file.content);
  }
  return map;
}
function normalizeBuildError(error) {
  const message = [error?.message, error?.stack].filter(Boolean).join("\n");
  return [createDiagnostic("error", message || "TanStack Start core compiler failed.")];
}
async function compileWithStartCore(files) {
  const fileMap = sanitizeWorkspaceFiles(files);
  const root = path.join(process.cwd(), ".tmp", "tanstack-start-core-virtual");
  const transform = await transformStartServerFunctions(fileMap, { root });
  return {
    serverFnsById: transform.serverFnsById,
    transformed: {
      client: Object.fromEntries(transform.clientFiles),
      server: Object.fromEntries(transform.serverFiles),
      serverSplits: Object.fromEntries(transform.serverSplits)
    },
    resolverModule: transform.resolverModule
  };
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
    const compiled = await compileWithStartCore(payload.files ?? []);
    result = {
      success: true,
      ...compiled,
      diagnostics: [
        createDiagnostic(
          "info",
          `Compiled with @tanstack/start-plugin-core internals in ${Math.round(
            performance.now() - startedAt
          )}ms.`
        )
      ],
      durationMs: Math.round(performance.now() - startedAt)
    };
  } catch (error) {
    result = {
      success: false,
      diagnostics: normalizeBuildError(error),
      durationMs: Math.round(performance.now() - startedAt)
    };
  }
  process.stdout.write(
    `
${resultStartMarker}
${JSON.stringify(result)}
${resultEndMarker}
`
  );
}
main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
