import "server-only";

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { BuildDiagnostic, WorkspaceFile } from "@/lib/ide/types";

export type ServerlessExpressLogEntry = {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  timestamp: string;
};

export type ServerlessExpressResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  contentType: string;
};

export type ServerlessExpressRequestInput = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};

export type ServerlessExpressRequestResult = {
  success: boolean;
  diagnostics: BuildDiagnostic[];
  logs: ServerlessExpressLogEntry[];
  response: ServerlessExpressResponse | null;
  durationMs: number;
};

const runnerPath = resolve(
  process.cwd(),
  "lib",
  "serverless-express",
  "runtime-request-runner.cjs",
);

function spawnRequestRunner(
  files: WorkspaceFile[],
  request: ServerlessExpressRequestInput,
) {
  return new Promise<ServerlessExpressRequestResult>((resolveResult, rejectResult) => {
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
            stderr.trim() || `Stateless Express runner exited with code ${code ?? -1}.`,
          ),
        );
        return;
      }

      try {
        const result = JSON.parse(stdout) as ServerlessExpressRequestResult;
        resolveResult(result);
      } catch (error) {
        rejectResult(
          error instanceof Error
            ? error
            : new Error("Unable to parse stateless Express runner output."),
        );
      }
    });

    child.stdin.write(JSON.stringify({ files, request }));
    child.stdin.end();
  });
}

export async function runServerlessExpressRequest(
  files: WorkspaceFile[],
  request: ServerlessExpressRequestInput,
): Promise<ServerlessExpressRequestResult> {
  return spawnRequestRunner(files, request);
}
