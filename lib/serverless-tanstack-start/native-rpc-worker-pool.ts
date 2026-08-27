import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  NativeRpcRequest,
  NativeRpcResult,
  NativeWorkerCommand,
  NativeWorkerMessage,
} from "./native-rpc-protocol";

export type NativeWorkerArtifact = {
  kernelId: string;
  revision: string;
  serverBundle: string;
};

export type NativeRpcWorkerExecution = {
  result: NativeRpcResult;
  workerId: string;
  workerRequest: number;
  workerReused: boolean;
};

type WorkerLike = {
  alive: boolean;
  execute(request: NativeRpcRequest): Promise<NativeRpcResult>;
  id: string;
  revision: string;
  terminate(reason?: string): void;
};

type WorkerFactory = (
  artifact: NativeWorkerArtifact,
  onExit: () => void,
) => WorkerLike;

type PoolEntry = {
  busy: boolean;
  completedRequests: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastUsed: number;
  worker: WorkerLike;
};

export type NativeRpcWorkerPoolOptions = {
  executionTimeoutMs?: number;
  idleTtlMs?: number;
  maxRequestsPerWorker?: number;
  maxResponseBytes?: number;
  maxWorkers?: number;
  startupTimeoutMs?: number;
  workerFactory?: WorkerFactory;
  workerPath?: string;
};

const defaultExecutionTimeoutMs = 10_000;
const defaultIdleTtlMs = 60_000;
const defaultMaxRequestsPerWorker = 50;
const defaultMaxResponseBytes = 3_000_000;
const defaultMaxWorkers = 4;
const defaultStartupTimeoutMs = 15_000;
const globalPoolKey = Symbol.for(
  "tuto.tanstack-start.native-rpc-worker-pool.v1",
);

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function environmentInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return positiveInteger(value, fallback);
}

class NativeRpcChildWorker implements WorkerLike {
  alive = true;
  readonly id = randomUUID();
  readonly revision: string;
  private readonly child: ChildProcess;
  private readonly executionTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly onExit: () => void;
  private readonly ready: Promise<void>;
  private readyReject?: (error: Error) => void;
  private readyResolve?: () => void;
  private stderr = "";
  private pending?: {
    id: string;
    reject(error: Error): void;
    resolve(result: NativeRpcResult): void;
    timeout: ReturnType<typeof setTimeout>;
  };

  constructor({
    artifact,
    executionTimeoutMs,
    maxResponseBytes,
    onExit,
    startupTimeoutMs,
    workerPath,
  }: {
    artifact: NativeWorkerArtifact;
    executionTimeoutMs: number;
    maxResponseBytes: number;
    onExit: () => void;
    startupTimeoutMs: number;
    workerPath: string;
  }) {
    this.executionTimeoutMs = executionTimeoutMs;
    this.maxOutputBytes = maxResponseBytes;
    this.onExit = onExit;
    this.revision = artifact.revision;
    this.child = spawn(process.execPath, [workerPath], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
    });
    const startupTimeout = setTimeout(() => {
      this.fail(new Error("TanStack RPC worker startup timed out."), true);
    }, startupTimeoutMs);
    startupTimeout.unref();

    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
      if (Buffer.byteLength(this.stderr) > this.maxOutputBytes) {
        this.fail(new Error("TanStack RPC worker output is too large."), true);
      }
    });
    this.child.on("message", (message: NativeWorkerMessage) => {
      if (message.type === "ready") {
        clearTimeout(startupTimeout);
        this.readyResolve?.();
        this.readyResolve = undefined;
        this.readyReject = undefined;
        return;
      }
      if (message.type === "result" && this.pending?.id === message.id) {
        const pending = this.pending;
        this.pending = undefined;
        clearTimeout(pending.timeout);
        pending.resolve(message.result);
        return;
      }
      if (message.type === "error") {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        if (message.id && this.pending?.id === message.id) {
          const pending = this.pending;
          this.pending = undefined;
          clearTimeout(pending.timeout);
          pending.reject(error);
        }
        if (message.fatal || !message.id) this.fail(error, true);
      }
    });
    this.child.once("error", (error) => this.fail(error, true));
    this.child.once("exit", (code, signal) => {
      clearTimeout(startupTimeout);
      if (this.alive) {
        const details = this.stderr.trim();
        this.fail(
          new Error(
            details ||
              `TanStack RPC worker exited (${signal ?? `code ${code ?? -1}`}).`,
          ),
          false,
        );
      }
      this.onExit();
    });
    this.child.once("spawn", () => {
      this.send({
        artifact,
        maxResponseBytes,
        type: "initialize",
      });
    });
  }

  private send(command: NativeWorkerCommand) {
    if (!this.alive || !this.child.connected) {
      throw new Error("TanStack RPC worker is not connected.");
    }
    this.child.send(command);
  }

  private fail(error: Error, kill: boolean) {
    if (!this.alive) return;
    this.alive = false;
    this.readyReject?.(error);
    this.readyReject = undefined;
    this.readyResolve = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(error);
      this.pending = undefined;
    }
    if (kill) this.child.kill("SIGKILL");
  }

  async execute(request: NativeRpcRequest) {
    await this.ready;
    if (!this.alive) throw new Error("TanStack RPC worker is unavailable.");
    if (this.pending) throw new Error("TanStack RPC worker is already busy.");
    const id = randomUUID();

    return new Promise<NativeRpcResult>((resolveResult, rejectResult) => {
      const timeout = setTimeout(() => {
        this.fail(
          new Error(
            `TanStack server function exceeded the ${this.executionTimeoutMs}ms execution limit.`,
          ),
          true,
        );
      }, this.executionTimeoutMs);
      timeout.unref();
      this.pending = {
        id,
        reject: rejectResult,
        resolve: resolveResult,
        timeout,
      };
      try {
        this.send({ id, request, type: "execute" });
      } catch (error) {
        this.fail(
          error instanceof Error ? error : new Error(String(error)),
          true,
        );
      }
    });
  }

  terminate() {
    if (!this.alive) return;
    this.alive = false;
    this.readyReject?.(new Error("TanStack RPC worker was retired."));
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(new Error("TanStack RPC worker was retired."));
      this.pending = undefined;
    }
    if (this.child.connected) {
      this.child.send({ type: "shutdown" } satisfies NativeWorkerCommand);
      const forceKill = setTimeout(() => this.child.kill("SIGKILL"), 500);
      forceKill.unref();
    } else {
      this.child.kill("SIGKILL");
    }
  }
}

export class NativeRpcWorkerPool {
  private readonly entries = new Set<PoolEntry>();
  private readonly idleTtlMs: number;
  private readonly maxRequestsPerWorker: number;
  private readonly maxWorkers: number;
  private readonly workerFactory: WorkerFactory;
  private readonly waiters = new Set<() => void>();
  private retiredWorkers = 0;
  private spawnedWorkers = 0;

  constructor(options: NativeRpcWorkerPoolOptions = {}) {
    const executionTimeoutMs = positiveInteger(
      options.executionTimeoutMs,
      defaultExecutionTimeoutMs,
    );
    const maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      defaultMaxResponseBytes,
    );
    const startupTimeoutMs = positiveInteger(
      options.startupTimeoutMs,
      defaultStartupTimeoutMs,
    );
    const workerPath =
      options.workerPath ??
      resolve(
        process.cwd(),
        "lib",
        "serverless-tanstack-start",
        "native-rpc-runner.generated.cjs",
      );
    this.idleTtlMs = positiveInteger(options.idleTtlMs, defaultIdleTtlMs);
    this.maxRequestsPerWorker = positiveInteger(
      options.maxRequestsPerWorker,
      defaultMaxRequestsPerWorker,
    );
    this.maxWorkers = positiveInteger(options.maxWorkers, defaultMaxWorkers);
    this.workerFactory =
      options.workerFactory ??
      ((artifact, onExit) =>
        new NativeRpcChildWorker({
          artifact,
          executionTimeoutMs,
          maxResponseBytes,
          onExit,
          startupTimeoutMs,
          workerPath,
        }));
  }

  private notifyWaiters() {
    for (const resolveWaiter of this.waiters) resolveWaiter();
    this.waiters.clear();
  }

  private waitForWorker() {
    return new Promise<void>((resolveWaiter) => {
      this.waiters.add(resolveWaiter);
    });
  }

  private retire(entry: PoolEntry, reason: string) {
    if (!this.entries.delete(entry)) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.retiredWorkers += 1;
    entry.worker.terminate(reason);
    this.notifyWaiters();
  }

  private spawnEntry(artifact: NativeWorkerArtifact) {
    const entryRef: { current?: PoolEntry } = {};
    const worker = this.workerFactory(artifact, () => {
      if (entryRef.current) this.retire(entryRef.current, "worker exited");
    });
    const entry: PoolEntry = {
      busy: true,
      completedRequests: 0,
      lastUsed: Date.now(),
      worker,
    };
    entryRef.current = entry;
    this.entries.add(entry);
    this.spawnedWorkers += 1;
    return entry;
  }

  private async acquire(artifact: NativeWorkerArtifact): Promise<PoolEntry> {
    while (true) {
      for (const entry of this.entries) {
        if (!entry.worker.alive) this.retire(entry, "worker unavailable");
      }
      const reusable = [...this.entries].find(
        (entry) => !entry.busy && entry.worker.revision === artifact.revision,
      );
      if (reusable) {
        reusable.busy = true;
        if (reusable.idleTimer) clearTimeout(reusable.idleTimer);
        reusable.idleTimer = undefined;
        return reusable;
      }
      if (this.entries.size < this.maxWorkers) {
        return this.spawnEntry(artifact);
      }
      const evictable = [...this.entries]
        .filter((entry) => !entry.busy)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (evictable) {
        this.retire(evictable, "LRU slot reassignment");
        continue;
      }
      await this.waitForWorker();
    }
  }

  async execute(
    artifact: NativeWorkerArtifact,
    request: NativeRpcRequest,
  ): Promise<NativeRpcWorkerExecution> {
    const entry = await this.acquire(artifact);
    const workerRequest = entry.completedRequests + 1;
    const workerReused = entry.completedRequests > 0;

    try {
      const result = await entry.worker.execute(request);
      entry.completedRequests += 1;
      return {
        result,
        workerId: entry.worker.id,
        workerRequest,
        workerReused,
      };
    } catch (error) {
      this.retire(entry, "execution failed");
      throw error;
    } finally {
      if (this.entries.has(entry)) {
        entry.busy = false;
        entry.lastUsed = Date.now();
        if (entry.completedRequests >= this.maxRequestsPerWorker) {
          this.retire(entry, "request limit reached");
        } else {
          entry.idleTimer = setTimeout(
            () => this.retire(entry!, "idle TTL reached"),
            this.idleTtlMs,
          );
          entry.idleTimer.unref();
          this.notifyWaiters();
        }
      }
    }
  }

  inspect() {
    const revisions = new Map<string, number>();
    let busyWorkers = 0;
    for (const entry of this.entries) {
      if (entry.busy) busyWorkers += 1;
      revisions.set(
        entry.worker.revision,
        (revisions.get(entry.worker.revision) ?? 0) + 1,
      );
    }
    return {
      busyWorkers,
      maxWorkers: this.maxWorkers,
      retiredWorkers: this.retiredWorkers,
      revisions: Object.fromEntries(revisions),
      spawnedWorkers: this.spawnedWorkers,
      workers: this.entries.size,
    };
  }

  shutdown() {
    for (const entry of [...this.entries]) {
      this.retire(entry, "pool shutdown");
    }
  }
}

function createConfiguredPool() {
  return new NativeRpcWorkerPool({
    executionTimeoutMs: environmentInteger(
      "TUTO_TANSTACK_WORKER_EXECUTION_TIMEOUT_MS",
      defaultExecutionTimeoutMs,
    ),
    idleTtlMs: environmentInteger(
      "TUTO_TANSTACK_WORKER_IDLE_TTL_MS",
      defaultIdleTtlMs,
    ),
    maxRequestsPerWorker: environmentInteger(
      "TUTO_TANSTACK_WORKER_MAX_REQUESTS",
      defaultMaxRequestsPerWorker,
    ),
    maxResponseBytes: environmentInteger(
      "TUTO_TANSTACK_WORKER_MAX_RESPONSE_BYTES",
      defaultMaxResponseBytes,
    ),
    maxWorkers: environmentInteger(
      "TUTO_TANSTACK_WORKER_POOL_SIZE",
      defaultMaxWorkers,
    ),
    startupTimeoutMs: environmentInteger(
      "TUTO_TANSTACK_WORKER_STARTUP_TIMEOUT_MS",
      defaultStartupTimeoutMs,
    ),
  });
}

export function getNativeRpcWorkerPool() {
  const globals = globalThis as typeof globalThis & {
    [globalPoolKey]?: NativeRpcWorkerPool;
  };
  globals[globalPoolKey] ??= createConfiguredPool();
  return globals[globalPoolKey];
}

export function clearNativeRpcWorkerPoolForTests() {
  const globals = globalThis as typeof globalThis & {
    [globalPoolKey]?: NativeRpcWorkerPool;
  };
  globals[globalPoolKey]?.shutdown();
  delete globals[globalPoolKey];
}
