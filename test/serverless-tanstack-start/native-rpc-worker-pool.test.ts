import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, test } from "vitest";
import type {
  NativeRpcRequest,
  NativeRpcResult,
} from "../../lib/serverless-tanstack-start/native-rpc-protocol";
import {
  NativeRpcWorkerPool,
  type NativeWorkerArtifact,
} from "../../lib/serverless-tanstack-start/native-rpc-worker-pool";

const pools: NativeRpcWorkerPool[] = [];
const request: NativeRpcRequest = {
  headers: [],
  method: "POST",
  serverFnId: "test-server-fn",
  url: "http://tuto.local/server-fn",
};
const result: NativeRpcResult = {
  bodyBase64: "",
  headers: [],
  status: 200,
  statusText: "OK",
};

function artifact(revisionCharacter: string): NativeWorkerArtifact {
  return {
    kernelId: "test-kernel",
    revision: revisionCharacter.repeat(64),
    serverBundle: "",
  };
}

function fakeWorkerFactory() {
  let sequence = 0;
  return (workerArtifact: NativeWorkerArtifact, onExit: () => void) => ({
    alive: true,
    async execute() {
      return result;
    },
    async executeStream() {
      return {
        body: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        completed: Promise.resolve(),
        response: result,
      };
    },
    id: `fake-worker-${++sequence}`,
    revision: workerArtifact.revision,
    terminate() {
      this.alive = false;
      onExit();
    },
  });
}

afterEach(() => {
  for (const pool of pools.splice(0)) pool.shutdown();
});

test("keeps a revision worker busy until its response stream ends", async () => {
  let completeStream!: () => void;
  const streamCompleted = new Promise<void>((resolveStream) => {
    completeStream = resolveStream;
  });
  const pool = new NativeRpcWorkerPool({
    idleTtlMs: 60_000,
    maxWorkers: 1,
    workerFactory: (workerArtifact, onExit) => ({
      alive: true,
      async execute() {
        return result;
      },
      async executeStream() {
        return {
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("streamed"));
              controller.close();
            },
          }),
          completed: streamCompleted,
          response: result,
        };
      },
      id: "fake-stream-worker",
      revision: workerArtifact.revision,
      terminate() {
        this.alive = false;
        onExit();
      },
    }),
  });
  pools.push(pool);

  const execution = await pool.executeStream(artifact("s"), request);
  assert.equal(pool.inspect().busyWorkers, 1);
  assert.equal(await new Response(execution.body).text(), "streamed");
  assert.equal(pool.inspect().busyWorkers, 1);

  completeStream();
  await streamCompleted;
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  assert.equal(pool.inspect().busyWorkers, 0);
});

test("reuses a worker only for its pinned revision and evicts by LRU", async () => {
  const pool = new NativeRpcWorkerPool({
    idleTtlMs: 60_000,
    maxRequestsPerWorker: 10,
    maxWorkers: 1,
    workerFactory: fakeWorkerFactory(),
  });
  pools.push(pool);

  const first = await pool.execute(artifact("a"), request);
  const reused = await pool.execute(artifact("a"), request);
  const reassigned = await pool.execute(artifact("b"), request);

  assert.equal(reused.workerId, first.workerId);
  assert.equal(reused.workerReused, true);
  assert.notEqual(reassigned.workerId, first.workerId);
  assert.deepEqual(pool.inspect(), {
    busyWorkers: 0,
    maxWorkers: 1,
    retiredWorkers: 1,
    revisions: { [artifact("b").revision]: 1 },
    spawnedWorkers: 2,
    workers: 1,
  });
});

test("retires workers after their request cap", async () => {
  const pool = new NativeRpcWorkerPool({
    idleTtlMs: 60_000,
    maxRequestsPerWorker: 1,
    maxWorkers: 1,
    workerFactory: fakeWorkerFactory(),
  });
  pools.push(pool);

  const first = await pool.execute(artifact("c"), request);
  assert.equal(pool.inspect().workers, 0);
  const second = await pool.execute(artifact("c"), request);

  assert.notEqual(first.workerId, second.workerId);
  assert.equal(pool.inspect().retiredWorkers, 2);
});

test("kills a native child that exceeds the execution timeout", async () => {
  const pool = new NativeRpcWorkerPool({
    executionTimeoutMs: 25,
    idleTtlMs: 60_000,
    maxWorkers: 1,
    startupTimeoutMs: 2_000,
    workerPath: path.resolve(
      process.cwd(),
      "test",
      "fixtures",
      "native-rpc-hanging-worker.cjs",
    ),
  });
  pools.push(pool);

  await assert.rejects(
    pool.execute(artifact("d"), request),
    /exceeded the 25ms execution limit/i,
  );
  assert.equal(pool.inspect().workers, 0);
});
