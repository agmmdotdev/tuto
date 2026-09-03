import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { NextRequestArtifact } from "./artifact";

type WorkerReply = {
  error?: string;
  html?: string;
  id: string;
  ok: boolean;
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
  private installed = new Set<string>();
  private pending = new Map<string, Pending>();

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

  async close() {
    const child = this.child;
    this.child = undefined;
    this.installed.clear();
    if (!child) return;
    child.disconnect();
    child.kill();
  }
}

const poolKey = Symbol.for("tuto.serverless-next.ssr-worker-pool.v1");

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
