import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { NextRequestArtifact } from "./artifact";
import {
  getNextCacheAdapter,
  type NextCacheGetInput,
  type NextCacheMetrics,
  type NextCacheRevalidateInput,
  type NextCacheSetInput,
} from "./cache-adapter";

type WorkerReply = {
  bodyBase64?: string;
  cacheMetrics?: NextCacheMetrics;
  error?: string;
  id: string;
  ok: boolean;
  routePattern?: string | null;
  status?: number;
  type?: undefined;
};

type WorkerCacheRequest = {
  input: NextCacheGetInput | NextCacheRevalidateInput | NextCacheSetInput;
  operation: "get" | "revalidateTags" | "set";
  requestId: string;
  type: "cache-request";
};

export type NextSerializedActionBody =
  | { kind: "string"; value: string }
  | {
      entries: Array<
        | { kind: "string"; name: string; value: string }
        | {
            contentType: string;
            filename: string;
            kind: "file";
            name: string;
            value: string;
          }
      >;
      kind: "form-data";
    };

export type NextFlightWorkerResult = {
  cacheMetrics: NextCacheMetrics;
  flight: Buffer;
  routePattern: string | null;
  status: number;
};

type Pending = {
  reject(error: Error): void;
  resolve(value: WorkerReply): void;
  timeout: NodeJS.Timeout;
};

const workerPath = resolve(
  /* turbopackIgnore: true */ process.cwd(),
  "lib",
  "serverless-next",
  "rsc-runtime-worker.cjs",
);
const workerTimeoutMs = 15_000;

export class NextRscWorkerPool {
  private child: ChildProcess | undefined;
  private installed = new Set<string>();
  private pending = new Map<string, Pending>();

  private async handleCacheRequest(
    child: ChildProcess,
    message: WorkerCacheRequest,
  ) {
    try {
      const adapter = getNextCacheAdapter();
      const value =
        message.operation === "get"
          ? await adapter.get(message.input as NextCacheGetInput)
          : message.operation === "set"
            ? await adapter.set(message.input as NextCacheSetInput)
            : await adapter.revalidateTags(
                message.input as NextCacheRevalidateInput,
              );
      child.send({
        ok: true,
        requestId: message.requestId,
        type: "cache-response",
        value,
      });
    } catch (error) {
      child.send({
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        requestId: message.requestId,
        type: "cache-response",
      });
    }
  }

  private getChild() {
    if (this.child?.connected) return this.child;
    const child = spawn(
      process.execPath,
      ["--conditions=react-server", "--max-old-space-size=256", workerPath],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    child.on("message", (message: WorkerReply | WorkerCacheRequest) => {
      if (message.type === "cache-request") {
        void this.handleCacheRequest(child, message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message);
      else
        pending.reject(new Error(message.error ?? "Next RSC worker failed."));
    });
    child.once("exit", (code) => {
      const error = new Error(
        `Next RSC worker exited with code ${code ?? -1}.`,
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
      this.installed.clear();
      this.child = undefined;
    });
    this.child = child;
    return child;
  }

  private send(message: Record<string, unknown>) {
    const child = this.getChild();
    const id = randomUUID();
    return new Promise<WorkerReply>((resolveReply, rejectReply) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectReply(new Error("Next RSC worker request timed out."));
        this.child?.kill();
      }, workerTimeoutMs);
      this.pending.set(id, {
        reject: rejectReply,
        resolve: resolveReply,
        timeout,
      });
      child.send({ ...message, id }, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        rejectReply(error);
      });
    });
  }

  private result(reply: WorkerReply): NextFlightWorkerResult {
    if (!reply.bodyBase64)
      throw new Error("Next RSC worker returned no Flight payload.");
    return {
      cacheMetrics: reply.cacheMetrics ?? {
        hits: 0,
        misses: 0,
        revalidations: 0,
        staleHits: 0,
        writes: 0,
      },
      flight: Buffer.from(reply.bodyBase64, "base64"),
      routePattern: reply.routePattern ?? null,
      status: reply.status ?? 200,
    };
  }

  async render(artifact: NextRequestArtifact, url: string) {
    if (!this.installed.has(artifact.generation)) {
      await this.send({ artifact, type: "install" });
      this.installed.add(artifact.generation);
    }
    const reply = await this.send({
      generation: artifact.generation,
      type: "render",
      url,
    });
    return this.result(reply);
  }

  async invokeAction(
    artifact: NextRequestArtifact,
    input: {
      actionId: string;
      body: NextSerializedActionBody;
      url: string;
    },
  ) {
    if (!this.installed.has(artifact.generation)) {
      await this.send({ artifact, type: "install" });
      this.installed.add(artifact.generation);
    }
    return this.result(
      await this.send({
        ...input,
        generation: artifact.generation,
        type: "action",
      }),
    );
  }

  async close() {
    const child = this.child;
    this.child = undefined;
    this.installed.clear();
    if (!child) return;
    child.disconnect();
    child.kill();
  }
}

const poolKey = Symbol.for("tuto.serverless-next.rsc-worker-pool.v1");

export function getNextRscWorkerPool() {
  const globals = globalThis as typeof globalThis & {
    [poolKey]?: NextRscWorkerPool;
  };
  globals[poolKey] ??= new NextRscWorkerPool();
  return globals[poolKey];
}

export async function closeNextRscWorkerPoolForTests() {
  const globals = globalThis as typeof globalThis & {
    [poolKey]?: NextRscWorkerPool;
  };
  await globals[poolKey]?.close();
  delete globals[poolKey];
}
