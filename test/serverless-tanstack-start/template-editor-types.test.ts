import assert from "node:assert/strict";
import path from "node:path";
import ts from "typescript";
import { test } from "vitest";
import { getServerlessTanstackStartTemplate } from "../../lib/ide/templates";
import { materializeTanstackRouteTree } from "../../lib/ide/tanstack-route-tree";
import type { WorkspaceFile } from "../../lib/ide/types";

type VirtualProgram = {
  program: ts.Program;
  virtualRoot: string;
};

function normalizePath(filePath: string) {
  return filePath.replaceAll("\\", "/");
}

function toVirtualPath(root: string, workspacePath: string) {
  return normalizePath(path.join(root, ...workspacePath.split("/")));
}

function createTemplateProgram(files: WorkspaceFile[]): VirtualProgram {
  const virtualRoot = path.resolve(".tmp", "tanstack-template-editor-types");
  const supportFilePath = toVirtualPath(virtualRoot, "src/monaco-env.d.ts");
  const virtualFiles = new Map<string, string>([
    [
      supportFilePath,
      [
        'declare module "*.css";',
        "interface ImportMeta { readonly env: Record<string, string | undefined>; }",
      ].join("\n"),
    ],
  ]);

  for (const file of files) {
    if (!["ts", "tsx", "js", "jsx"].includes(file.language)) {
      continue;
    }

    virtualFiles.set(toVirtualPath(virtualRoot, file.path), file.content);
  }

  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    baseUrl: normalizePath(virtualRoot),
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    paths: {
      "@tanstack/react-router": ["src/tanstack-router-editor-shim.tsx"],
      "@tanstack/react-start": ["src/tanstack-router-editor-shim.tsx"],
      "@tanstack/router-core": ["src/tanstack-router-editor-shim.tsx"],
    },
    resolveJsonModule: true,
    skipLibCheck: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  };
  const defaultHost = ts.createCompilerHost(compilerOptions);
  const host: ts.CompilerHost = {
    ...defaultHost,
    directoryExists(directoryPath) {
      const normalized = normalizePath(directoryPath);

      if (
        normalized === normalizePath(virtualRoot) ||
        [...virtualFiles.keys()].some((filePath) => filePath.startsWith(`${normalized}/`))
      ) {
        return true;
      }

      return defaultHost.directoryExists?.(directoryPath) ?? false;
    },
    fileExists(filePath) {
      return virtualFiles.has(normalizePath(filePath)) || defaultHost.fileExists(filePath);
    },
    getCurrentDirectory() {
      return normalizePath(virtualRoot);
    },
    getSourceFile(filePath, languageVersion, onError, shouldCreateNewSourceFile) {
      const normalized = normalizePath(filePath);
      const source = virtualFiles.get(normalized);

      if (typeof source === "string") {
        return ts.createSourceFile(normalized, source, languageVersion, true);
      }

      return defaultHost.getSourceFile(
        filePath,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
    readFile(filePath) {
      return virtualFiles.get(normalizePath(filePath)) ?? defaultHost.readFile(filePath);
    },
  };

  return {
    program: ts.createProgram([...virtualFiles.keys()], compilerOptions, host),
    virtualRoot: normalizePath(virtualRoot),
  };
}

function formatDiagnostic(diagnostic: ts.Diagnostic, virtualRoot: string) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

  if (!diagnostic.file || typeof diagnostic.start !== "number") {
    return `TS${diagnostic.code}: ${message}`;
  }

  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const filePath = normalizePath(diagnostic.file.fileName).replace(`${virtualRoot}/`, "");

  return `${filePath}:${position.line + 1}:${position.character + 1} TS${diagnostic.code}: ${message}`;
}

test("TanStack Start template has no editor-facing TypeScript diagnostics", () => {
  const template = getServerlessTanstackStartTemplate();

  assert.ok(template, "expected TanStack Start template");

  const files = materializeTanstackRouteTree(template.files);
  const { program, virtualRoot } = createTemplateProgram(files);
  const formattedDiagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) =>
      normalizePath(diagnostic.file?.fileName ?? "").startsWith(virtualRoot),
    )
    .map((diagnostic) => formatDiagnostic(diagnostic, virtualRoot));

  assert.deepEqual(formattedDiagnostics, []);
});

test("TanStack Start editor shim exposes server function and control-flow APIs", () => {
  const template = getServerlessTanstackStartTemplate();

  assert.ok(template, "expected TanStack Start template");

  const files = materializeTanstackRouteTree(template.files);
  const shim = files.find((file) => file.path === "src/tanstack-router-editor-shim.tsx");

  assert.ok(shim, "expected generated editor shim");
  assert.match(shim.content, /export function createServerFn/);
  assert.match(shim.content, /export function createMiddleware/);
  assert.match(shim.content, /export function redirect/);
  assert.match(shim.content, /export function notFound\(_options: NotFoundOptions/);
});
