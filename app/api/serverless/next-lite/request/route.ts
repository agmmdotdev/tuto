import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { BuildDiagnostic, WorkspaceFile } from "@/lib/ide/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const maxFiles = 80;
const maxFileBytes = 512 * 1024;
const maxTotalBytes = 4 * 1024 * 1024;

type NextLiteRequestInput = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
};

function createDiagnostic(message: string, filePath?: string): BuildDiagnostic {
  return {
    id: crypto.randomUUID(),
    level: "error",
    message,
    timestamp: new Date().toISOString(),
    filePath,
  };
}

function normalizeWorkspacePath(filePath: string) {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const parts = normalizedPath.split("/");

  if (
    normalizedPath.startsWith("/") ||
    /^[a-z]:\//i.test(normalizedPath) ||
    parts.some((part) => part === ".." || part === "")
  ) {
    throw new Error(`Invalid workspace file path: ${filePath}`);
  }

  return normalizedPath;
}

async function materializeWorkspace(files: WorkspaceFile[]) {
  if (files.length > maxFiles) {
    throw new Error(`Too many workspace files. The Next Lite runner accepts ${maxFiles} files.`);
  }

  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tuto-next-lite-"));
  let totalBytes = 0;

  for (const file of files) {
    const normalizedPath = normalizeWorkspacePath(file.path);
    const contentBytes = Buffer.byteLength(file.content, "utf8");
    totalBytes += contentBytes;

    if (contentBytes > maxFileBytes) {
      throw new Error(`Workspace file is too large: ${file.path}`);
    }

    if (totalBytes > maxTotalBytes) {
      throw new Error("Workspace snapshot is too large for the Next Lite runner.");
    }

    const targetFile = path.join(workspaceRoot, normalizedPath);
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(targetFile, file.content, "utf8");
  }

  return workspaceRoot;
}

function createRenderRequest(input: NextLiteRequestInput) {
  const method = (input.method ?? "GET").toUpperCase();
  const pathname = input.path?.startsWith("/") ? input.path : `/${input.path ?? ""}`;
  const requestUrl = new URL(pathname || "/", "http://next-lite.local");
  const headers = new Headers(input.headers ?? {});

  return new Request(requestUrl, {
    body: method === "GET" || method === "HEAD" ? undefined : input.body ?? "",
    headers,
    method,
  });
}

function normalizeErrorDiagnostics(error: unknown): BuildDiagnostic[] {
  const fallbackMessage = "Unable to run the Next Lite preview.";

  if (error && typeof error === "object" && "errors" in error) {
    const errors = (error as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.map((entry) => {
        const value = entry as {
          text?: string;
          location?: { file?: string; line?: number; column?: number };
        };
        return {
          ...createDiagnostic(value.text ?? fallbackMessage, value.location?.file),
          line: value.location?.line,
          column: value.location?.column,
        };
      });
    }
  }

  return [createDiagnostic(error instanceof Error ? error.message : fallbackMessage)];
}

export async function POST(request: Request) {
  let workspaceRoot: string | null = null;

  try {
    const payload = (await request.json()) as {
      files?: WorkspaceFile[];
      request?: NextLiteRequestInput;
    };
    workspaceRoot = await materializeWorkspace(payload.files ?? []);
    const outDir = path.join(workspaceRoot, ".next-lite");
    const startedAt = performance.now();
    const { buildNextLiteApp, loadNextLiteRenderer } = await import(
      "@/lib/serverless-nextjs-runtime/next-lite"
    );
    const artifact = await buildNextLiteApp({
      outDir,
      workspaceRoot,
    });
    const renderer = await loadNextLiteRenderer(artifact);
    const response = await renderer.renderNextLiteRequest(
      createRenderRequest(payload.request ?? {}),
    );
    const body = await response.text();
    const durationMs = Math.round(performance.now() - startedAt);
    const contentType =
      response.headers.get("content-type") ?? "text/plain; charset=utf-8";

    return NextResponse.json(
      {
        success: response.status < 500,
        diagnostics: [],
        logs: [
          {
            level: "info",
            kind: "stdout",
            message: `Compiled ${artifact.routes.length} route(s) with Next Lite in ${durationMs}ms.`,
            timestamp: new Date().toISOString(),
          },
        ],
        response: {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
          contentType,
        },
      },
      {
        headers: {
          "cache-control": "no-store",
        },
        status: response.status < 500 ? 200 : 422,
      },
    );
  } catch (error) {
    const diagnostics = normalizeErrorDiagnostics(error);
    const message = diagnostics[0]?.message ?? "Unable to run the Next Lite preview.";

    return NextResponse.json(
      {
        success: false,
        diagnostics,
        logs: [],
        response: null,
        error: message,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
        status: 400,
      },
    );
  } finally {
    if (workspaceRoot) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}
