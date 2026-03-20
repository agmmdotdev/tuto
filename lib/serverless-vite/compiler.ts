import "server-only";

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { BuildDiagnostic, WorkspaceFile } from "@/lib/ide/types";

type ServerlessCompileResult = {
  success: boolean;
  html: string;
  diagnostics: BuildDiagnostic[];
  durationMs: number;
};

const runnerPath = resolve(
  process.cwd(),
  "lib",
  "serverless-vite",
  "runtime-compiler-runner.cjs",
);

function spawnCompileRunner(files: WorkspaceFile[]) {
  return new Promise<ServerlessCompileResult>((resolveResult, rejectResult) => {
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
          new Error(stderr.trim() || `Stateless compiler exited with code ${code ?? -1}.`),
        );
        return;
      }

      try {
        const result = JSON.parse(stdout) as ServerlessCompileResult;
        resolveResult(result);
      } catch (error) {
        rejectResult(
          error instanceof Error
            ? error
            : new Error("Unable to parse stateless compiler output."),
        );
      }
    });

    child.stdin.write(JSON.stringify({ files }));
    child.stdin.end();
  });
}

export async function compileServerlessWorkspace(
  files: WorkspaceFile[],
): Promise<ServerlessCompileResult> {
  return spawnCompileRunner(files);
}
