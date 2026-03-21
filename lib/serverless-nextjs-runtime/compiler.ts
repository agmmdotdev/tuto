import "server-only";

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { BuildDiagnostic, WorkspaceFile } from "@/lib/ide/types";

export type ServerlessNextjsRuntimeLogEntry = {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  timestamp: string;
};

export type ServerlessNextjsRuntimeResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  contentType: string;
};

export type ServerlessNextjsRuntimeRequestInput = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};

export type ServerlessNextjsRuntimeRequestResult = {
  success: boolean;
  diagnostics: BuildDiagnostic[];
  logs: ServerlessNextjsRuntimeLogEntry[];
  response: ServerlessNextjsRuntimeResponse | null;
  durationMs: number;
};

const runnerPath = resolve(
  process.cwd(),
  "lib",
  "serverless-nextjs-runtime",
  "runtime-request-runner.cjs",
);
const resultStartMarker = "__TUTO_SERVERLESS_NEXT_RESULT_START__";
const resultEndMarker = "__TUTO_SERVERLESS_NEXT_RESULT_END__";

function spawnRequestRunner(
  files: WorkspaceFile[],
  request: ServerlessNextjsRuntimeRequestInput,
) {
  return new Promise<ServerlessNextjsRuntimeRequestResult>((resolveResult, rejectResult) => {
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
          new Error(
            stderr.trim() ||
              `Stateless Next runtime runner exited with code ${code ?? -1}.`,
          ),
        );
        return;
      }

      try {
        const startIndex = stdout.lastIndexOf(resultStartMarker);
        const endIndex = stdout.lastIndexOf(resultEndMarker);

        if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
          throw new Error(stderr.trim() || "Unable to locate stateless Next runtime result payload.");
        }

        const jsonPayload = stdout
          .slice(startIndex + resultStartMarker.length, endIndex)
          .trim();
        const result = JSON.parse(jsonPayload) as ServerlessNextjsRuntimeRequestResult;
        resolveResult(result);
      } catch (error) {
        rejectResult(
          error instanceof Error
            ? error
            : new Error("Unable to parse stateless Next runtime output."),
        );
      }
    });

    child.stdin.write(JSON.stringify({ files, request }));
    child.stdin.end();
  });
}

export async function runServerlessNextjsRuntimeRequest(
  files: WorkspaceFile[],
  request: ServerlessNextjsRuntimeRequestInput,
): Promise<ServerlessNextjsRuntimeRequestResult> {
  return spawnRequestRunner(files, request);
}
