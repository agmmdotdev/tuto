export type NextExecutionMode = "child-process" | "secure-exec";

export function getNextExecutionMode(
  environment: NodeJS.ProcessEnv = process.env,
): NextExecutionMode {
  const configured = environment.TUTO_NEXT_EXECUTION_MODE?.trim();
  if (configured === "secure-exec" || configured === "child-process") {
    return configured;
  }
  if (configured) {
    throw new Error(
      `Unsupported TUTO_NEXT_EXECUTION_MODE ${JSON.stringify(configured)}. Expected "child-process" or "secure-exec".`,
    );
  }
  return "child-process";
}

export function assertNextProductionExecutionIsolated(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const mode = getNextExecutionMode(environment);
  if (environment.VERCEL === "1" && mode !== "secure-exec") {
    throw new Error(
      'The request-compiled Next runtime requires TUTO_NEXT_EXECUTION_MODE="secure-exec" on Vercel. Node child processes contain crashes but are not a security boundary for student code.',
    );
  }
  return mode;
}

