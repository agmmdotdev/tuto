import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { WorkspaceFile } from "@/lib/ide/types";

export const runtime = "nodejs";

const runnerPath = resolve(
  process.cwd(),
  "lib",
  "serverless-tanstack-start",
  "core-rpc-runner.generated.cjs",
);
const resultStartMarker = "__TUTO_TANSTACK_START_CORE_RPC_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_RPC_RESULT_END__";
const corsHeaders = {
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
};

function runCoreRpc(payload: {
  id?: string;
  payload?: unknown;
  files?: WorkspaceFile[];
}) {
  return new Promise<{
    success: boolean;
    result?: unknown;
    context?: unknown;
    error?: string;
  }>((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [runnerPath], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectResult);
    child.once("exit", (code) => {
      if (code !== 0) {
        rejectResult(
          new Error(stderr.trim() || `TanStack core RPC exited with code ${code ?? -1}.`),
        );
        return;
      }

      try {
        const startIndex = stdout.lastIndexOf(resultStartMarker);
        const endIndex = stdout.lastIndexOf(resultEndMarker);

        if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
          throw new Error(stderr.trim() || "Unable to locate TanStack core RPC result.");
        }

        const jsonPayload = stdout
          .slice(startIndex + resultStartMarker.length, endIndex)
          .trim();
        resolveResult(JSON.parse(jsonPayload));
      } catch (error) {
        rejectResult(
          error instanceof Error
            ? error
            : new Error("Unable to parse TanStack core RPC output."),
        );
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      id?: string;
      payload?: unknown;
      files?: WorkspaceFile[];
    };
    const result = await runCoreRpc(payload);

    return NextResponse.json(result, {
      headers: corsHeaders,
      status: result.success ? 200 : 422,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to execute TanStack server function.";

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      {
        headers: corsHeaders,
        status: 400,
      },
    );
  }
}

export function OPTIONS() {
  return new Response(null, {
    headers: corsHeaders,
    status: 204,
  });
}
