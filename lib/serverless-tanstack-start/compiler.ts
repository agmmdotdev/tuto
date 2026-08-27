import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { BuildDiagnostic, WorkspaceFile } from "@/lib/ide/types";
import {
  createWorkspaceRevision,
  getTanstackStartArtifact,
  putTanstackStartArtifact,
  type TanstackStartArtifact,
  type TanstackStartBuildMetrics,
} from "./artifact-cache";
import {
  getDurableTanstackStartArtifactSummary,
  putDurableTanstackStartArtifact,
  type TanstackStartArtifactSummary,
} from "./artifact-store";

export type ServerlessTanstackStartResult = {
  success: boolean;
  html: string | null;
  diagnostics: BuildDiagnostic[];
  durationMs: number;
  cacheStatus: "durable" | "hit" | "miss" | "shared";
  buildMetrics: TanstackStartBuildMetrics;
  revision: string;
};

type RunnerResult = TanstackStartArtifact;
type BuildOutcome =
  | { origin: "build"; result: RunnerResult }
  | { origin: "durable"; result: TanstackStartArtifactSummary };

const runnerPath = resolve(
  process.cwd(),
  "lib",
  "serverless-tanstack-start",
  "core-preview-runner.generated.cjs",
);
const resultStartMarker = "__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_END__";
const inFlightBuildsKey = Symbol.for("tuto.tanstack-start.in-flight-builds.v1");

function getInFlightBuilds() {
  const globals = globalThis as typeof globalThis & {
    [inFlightBuildsKey]?: Map<string, Promise<BuildOutcome>>;
  };
  globals[inFlightBuildsKey] ??= new Map();
  return globals[inFlightBuildsKey];
}

function durableStoreWarning(operation: "read" | "write", error: unknown) {
  return {
    id: randomUUID(),
    level: "warn" as const,
    message: `Durable TanStack artifact ${operation} failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
    timestamp: new Date().toISOString(),
  };
}

async function loadOrBuild(files: WorkspaceFile[], revision: string) {
  let readWarning: ReturnType<typeof durableStoreWarning> | undefined;

  try {
    const durable = await getDurableTanstackStartArtifactSummary(revision);
    if (durable) {
      return { origin: "durable", result: durable } satisfies BuildOutcome;
    }
  } catch (error) {
    readWarning = durableStoreWarning("read", error);
  }

  const result = await spawnBuildRunner(files, revision);
  if (readWarning) result.diagnostics.push(readWarning);
  if (result.success) {
    try {
      await putDurableTanstackStartArtifact(result);
    } catch (error) {
      result.diagnostics.push(durableStoreWarning("write", error));
    }
    putTanstackStartArtifact(result);
  }

  return { origin: "build", result } satisfies BuildOutcome;
}

function spawnBuildRunner(files: WorkspaceFile[], revision: string) {
  return new Promise<RunnerResult>((resolveResult, rejectResult) => {
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
        resolveResult(JSON.parse(jsonPayload) as RunnerResult);
      } catch (error) {
        rejectResult(
          error instanceof Error
            ? error
            : new Error("Unable to parse TanStack Start runtime output."),
        );
      }
    });

    child.stdin.write(JSON.stringify({ files, revision }));
    child.stdin.end();
  });
}

export async function compileServerlessTanstackStartWorkspace(
  files: WorkspaceFile[],
): Promise<ServerlessTanstackStartResult> {
  const revision = createWorkspaceRevision(files);
  const cached = getTanstackStartArtifact(revision);

  if (cached) {
    return {
      cacheStatus: "hit",
      buildMetrics: cached.buildMetrics,
      diagnostics: cached.diagnostics,
      durationMs: 0,
      html: cached.html,
      revision,
      success: cached.success,
    };
  }

  const inFlightBuilds = getInFlightBuilds();
  const existingBuild = inFlightBuilds.get(revision);
  const build = existingBuild ?? loadOrBuild(files, revision);
  if (!existingBuild) inFlightBuilds.set(revision, build);

  const outcome = await build.finally(() => {
    if (!existingBuild) inFlightBuilds.delete(revision);
  });
  const result = outcome.result;

  return {
    buildMetrics: result.buildMetrics,
    cacheStatus: existingBuild
      ? "shared"
      : outcome.origin === "durable"
        ? "durable"
        : "miss",
    diagnostics: result.diagnostics,
    durationMs: outcome.origin === "durable" ? 0 : result.durationMs,
    html: result.html,
    revision,
    success: result.success,
  };
}
