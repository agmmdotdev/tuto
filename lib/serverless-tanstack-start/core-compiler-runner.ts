import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  transformStartServerFunctions,
} from "./server-functions-transform";

type BuildDiagnosticLevel = "info" | "warning" | "error";

type BuildDiagnostic = {
  id: string;
  level: BuildDiagnosticLevel;
  message: string;
  timestamp: string;
};

type WorkspaceFileInput = {
  path: string;
  content: string;
};

type WorkspaceFileMap = Map<string, string>;

type CompilerPayload = {
  files?: WorkspaceFileInput[];
};

type CompilerSuccess = {
  success: true;
  serverFnsById: unknown;
  transformed: {
    client: Record<string, string>;
    server: Record<string, string>;
    serverSplits: Record<string, string>;
  };
  resolverModule: string;
  diagnostics: BuildDiagnostic[];
  durationMs: number;
};

type CompilerFailure = {
  success: false;
  diagnostics: BuildDiagnostic[];
  durationMs: number;
};

const resultStartMarker = "__TUTO_TANSTACK_START_CORE_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_RESULT_END__";
const maxFileCount = 64;
const maxFileSize = 220_000;
const maxTotalSize = 1_250_000;

function createDiagnostic(
  level: BuildDiagnosticLevel,
  message: string,
): BuildDiagnostic {
  return {
    id: randomUUID(),
    level,
    message,
    timestamp: new Date().toISOString(),
  };
}

function normalizeWorkspacePath(filePath: string) {
  return filePath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function sanitizeWorkspaceFiles(files: unknown): WorkspaceFileMap {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("At least one file is required.");
  }

  if (files.length > maxFileCount) {
    throw new Error("Too many files for the TanStack Start core compiler.");
  }

  const map: WorkspaceFileMap = new Map();
  let totalSize = 0;

  for (const file of files as WorkspaceFileInput[]) {
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
      throw new Error("Workspace snapshot is too large for the TanStack Start core compiler.");
    }

    map.set(normalizedPath, file.content);
  }

  return map;
}

function normalizeBuildError(error: unknown) {
  const message =
    error instanceof Error
      ? [error.message, error.stack].filter(Boolean).join("\n")
      : String(error);

  return [createDiagnostic("error", message || "TanStack Start core compiler failed.")];
}

async function compileWithStartCore(files: unknown) {
  const fileMap = sanitizeWorkspaceFiles(files);
  const root = path.join(process.cwd(), ".tmp", "tanstack-start-core-virtual");
  const transform = await transformStartServerFunctions(fileMap, { root });

  return {
    serverFnsById: transform.serverFnsById,
    transformed: {
      client: Object.fromEntries(transform.clientFiles),
      server: Object.fromEntries(transform.serverFiles),
      serverSplits: Object.fromEntries(transform.serverSplits),
    },
    resolverModule: transform.resolverModule,
  };
}

async function readInput(): Promise<CompilerPayload> {
  let input = "";

  for await (const chunk of process.stdin) {
    input += chunk.toString("utf8");
  }

  return JSON.parse(input) as CompilerPayload;
}

async function main() {
  const startedAt = performance.now();
  let result: CompilerSuccess | CompilerFailure;

  try {
    const payload = await readInput();
    const compiled = await compileWithStartCore(payload.files ?? []);
    const durationMs = Math.round(performance.now() - startedAt);

    result = {
      success: true,
      ...compiled,
      diagnostics: [
        createDiagnostic(
          "info",
          `Compiled with @tanstack/start-plugin-core internals in ${durationMs}ms.`,
        ),
      ],
      durationMs,
    };
  } catch (error) {
    result = {
      success: false,
      diagnostics: normalizeBuildError(error),
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  process.stdout.write(
    `\n${resultStartMarker}\n${JSON.stringify(result)}\n${resultEndMarker}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
