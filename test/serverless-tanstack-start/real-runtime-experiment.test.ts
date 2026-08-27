import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

test("runs a server function through the real Start client and server runtimes", () => {
  const child = spawnSync(
    process.execPath,
    ["scripts/experiment-tanstack-real-runtime.mjs"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        TUTO_EXPERIMENT_DEBUG: "0",
      },
      timeout: 120_000,
    },
  );

  assert.equal(
    child.status,
    0,
    child.stderr || child.stdout || "real Start runtime experiment failed",
  );

  const result = JSON.parse(child.stdout) as {
    success: boolean;
    transportCalls: number;
    result: unknown;
    officialEntrypoints: {
      client: boolean;
      serverRpc: boolean;
    };
    realRuntimeInputs: {
      client: boolean;
      server: boolean;
    };
  };

  assert.equal(result.success, true);
  assert.equal(result.transportCalls, 1);
  assert.deepEqual(result.officialEntrypoints, {
    client: true,
    serverRpc: true,
  });
  assert.deepEqual(result.realRuntimeInputs, {
    client: true,
    server: true,
  });
  assert.deepEqual(result.result, {
    message: "Hello Aung",
    source: "real-start-middleware",
  });
});
