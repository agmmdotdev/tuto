import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { NextRequestArtifact } from "./artifact";
import { getNextExecutionMode } from "./execution-mode";
import { NextSecureExecWorkspacePool } from "./secure-exec-worker";

type WorkerReply = {
  error?: string;
  html?: string;
  id: string;
  inputStreamId?: string;
  ok: boolean;
  streamChunkBase64?: string;
  streamDone?: boolean;
  streamFinal?: unknown;
  streamId?: string;
};

type OpenedWorkerStream = WorkerReply & {
  errorInput(error: unknown): Promise<void>;
  final: Promise<unknown>;
  stream: ReadableStream<Uint8Array>;
  writeInput(chunk?: Uint8Array, done?: boolean): Promise<void>;
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
  "ssr-runtime-worker.cjs",
);
const workerTimeoutMs = 15_000;

export class NextSsrWorkerPool {
  private child: ChildProcess | undefined;
  private readonly executionMode = getNextExecutionMode();
  private installed = new Set<string>();
  private pending = new Map<string, Pending>();
  private secureWorkers: NextSecureExecWorkspacePool | undefined;

  private getChild() {
    if (this.child?.connected) return this.child;
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=256", workerPath],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    child.on("message", (message: WorkerReply) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message);
      else
        pending.reject(new Error(message.error ?? "Next SSR worker failed."));
    });
    child.once("exit", (code) => {
      const error = new Error(
        `Next SSR worker exited with code ${code ?? -1}.`,
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
    if (this.executionMode === "secure-exec") {
      this.secureWorkers ??= new NextSecureExecWorkspacePool("ssr");
      return this.secureWorkers.send(message) as Promise<WorkerReply>;
    }
    const child = this.getChild();
    const id = randomUUID();
    return new Promise<WorkerReply>((resolveReply, rejectReply) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectReply(new Error("Next SSR worker request timed out."));
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

  private async openStream(
    message: Record<string, unknown>,
  ): Promise<OpenedWorkerStream> {
    if (this.executionMode === "secure-exec") {
      this.secureWorkers ??= new NextSecureExecWorkspacePool("ssr");
      return this.secureWorkers.openStream(message) as Promise<OpenedWorkerStream>;
    }
    const reply = await this.send(message);
    if (
      typeof reply.streamId !== "string" ||
      typeof reply.inputStreamId !== "string"
    ) {
      throw new Error("Next SSR worker returned an incomplete stream channel.");
    }
    const streamId = reply.streamId;
    const inputStreamId = reply.inputStreamId;
    const generation = message.generation;
    let resolveFinal!: (value: unknown) => void;
    let rejectFinal!: (error: unknown) => void;
    const final = new Promise<unknown>((resolve, reject) => {
      resolveFinal = resolve;
      rejectFinal = reject;
    });
    void final.catch(() => undefined);
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const next = await this.send({
            generation,
            streamId,
            type: "stream-pull",
          });
          if (next.streamDone) {
            resolveFinal(next.streamFinal);
            controller.close();
          } else if (typeof next.streamChunkBase64 === "string") {
            controller.enqueue(Buffer.from(next.streamChunkBase64, "base64"));
          } else {
            throw new Error("Next SSR worker returned an invalid stream chunk.");
          }
        } catch (error) {
          rejectFinal(error);
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        try {
          await this.send({
            generation,
            reason: typeof reason === "string" ? reason : "Host cancelled response stream.",
            streamId,
            type: "stream-cancel",
          });
          resolveFinal({ cancelled: true });
        } catch (error) {
          rejectFinal(error);
        }
      },
    });
    return {
      ...reply,
      errorInput: async (error) => {
        await this.send({
          error: error instanceof Error ? error.message : String(error),
          generation,
          inputStreamId,
          type: "stream-error",
        });
      },
      final,
      stream,
      writeInput: async (chunk, done = false) => {
        await this.send({
          generation,
          inputStreamId,
          streamChunkBase64: chunk
            ? Buffer.from(chunk).toString("base64")
            : undefined,
          streamDone: done,
          type: "stream-write",
        });
      },
    };
  }

  async render(
    artifact: NextRequestArtifact,
    flight: Buffer,
    formState?: unknown,
    url = "/",
  ) {
    if (!this.installed.has(artifact.generation)) {
      await this.send({ artifact, type: "install" });
      this.installed.add(artifact.generation);
    }
    const reply = await this.send({
      bodyBase64: flight.toString("base64"),
      formState,
      generation: artifact.generation,
      type: "render",
      url,
    });
    if (typeof reply.html !== "string") {
      throw new Error("Next SSR worker returned no HTML payload.");
    }
    return reply.html;
  }

  async renderStream(
    artifact: NextRequestArtifact,
    flight: ReadableStream<Uint8Array>,
    formState?: unknown,
    url = "/",
  ) {
    if (!this.installed.has(artifact.generation)) {
      await this.send({ artifact, type: "install" });
      this.installed.add(artifact.generation);
    }
    const opened = await this.openStream({
      formState,
      generation: artifact.generation,
      type: "render-stream",
      url,
    });
    const flightReader = flight.getReader();
    const pump = (async () => {
      try {
        for (;;) {
          const chunk = await flightReader.read();
          if (chunk.done) {
            await opened.writeInput(undefined, true);
            return;
          }
          await opened.writeInput(chunk.value, false);
        }
      } catch (error) {
        await opened.errorInput(error).catch(() => undefined);
        throw error;
      }
    })();
    void pump.catch(() => undefined);
    const outputReader = opened.stream.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await outputReader.read();
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await Promise.allSettled([
          outputReader.cancel(reason),
          flightReader.cancel(reason),
          opened.errorInput(reason),
        ]);
      },
    });
    const final = Promise.all([opened.final, pump]);
    void final.catch(() => undefined);
    return {
      final,
      stream,
    };
  }

  async close() {
    const secureWorkers = this.secureWorkers;
    this.secureWorkers = undefined;
    await secureWorkers?.close();
    const child = this.child;
    this.child = undefined;
    this.installed.clear();
    if (!child) return;
    child.disconnect();
    child.kill();
  }
}

const poolKey = Symbol.for("tuto.serverless-next.ssr-worker-pool.v2");

export function getNextSsrWorkerPool() {
  const globals = globalThis as typeof globalThis & {
    [poolKey]?: NextSsrWorkerPool;
  };
  globals[poolKey] ??= new NextSsrWorkerPool();
  return globals[poolKey];
}

export async function closeNextSsrWorkerPoolForTests() {
  const globals = globalThis as typeof globalThis & {
    [poolKey]?: NextSsrWorkerPool;
  };
  await globals[poolKey]?.close();
  delete globals[poolKey];
}
