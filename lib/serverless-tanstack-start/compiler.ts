import "server-only";

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { BuildDiagnostic, WorkspaceFile } from "@/lib/ide/types";

export type ServerlessTanstackStartResult = {
  success: boolean;
  html: string | null;
  diagnostics: BuildDiagnostic[];
  durationMs: number;
};

const runnerPath = resolve(
  process.cwd(),
  "lib",
  "serverless-tanstack-start",
  "core-preview-runner.cjs",
);
const resultStartMarker = "__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_END__";

function spawnBuildRunner(files: WorkspaceFile[]) {
  return new Promise<ServerlessTanstackStartResult>((resolveResult, rejectResult) => {
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
              `TanStack Start runtime runner exited with code ${code ?? -1}.`,
          ),
        );
        return;
      }

      try {
        const startIndex = stdout.lastIndexOf(resultStartMarker);
        const endIndex = stdout.lastIndexOf(resultEndMarker);

        if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
          throw new Error(
            stderr.trim() || "Unable to locate TanStack Start result payload.",
          );
        }

        const jsonPayload = stdout
          .slice(startIndex + resultStartMarker.length, endIndex)
          .trim();
        resolveResult(JSON.parse(jsonPayload) as ServerlessTanstackStartResult);
      } catch (error) {
        rejectResult(
          error instanceof Error
            ? error
            : new Error("Unable to parse TanStack Start runtime output."),
        );
      }
    });

    child.stdin.write(JSON.stringify({ files }));
    child.stdin.end();
  });
}

export async function compileServerlessTanstackStartWorkspace(
  files: WorkspaceFile[],
): Promise<ServerlessTanstackStartResult> {
  return spawnBuildRunner(files);
}
