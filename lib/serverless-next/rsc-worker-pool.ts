import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter, resolve } from "node:path";
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
  contentType?: string;
  error?: string;
  formState?: unknown;
  headers?: Array<[string, string]>;
  id: string;
  ok: boolean;
  proxyMatched?: boolean;
  proxyOutcome?: "next" | "redirect" | "response" | "rewrite";
  requestHeaders?: Array<[string, string]>;
  routePattern?: string | null;
  status?: number;
  statusText?: string;
  stylePaths?: string[];
  type?: undefined;
  url?: string;
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
  contentType: string;
  flight: Buffer;
  formState?: unknown;
  headers: Array<[string, string]>;
  routePattern: string | null;
  status: number;
  stylePaths: string[];
};

export type NextRouteHandlerWorkerResult = {
  body: Buffer;
  cacheMetrics: NextCacheMetrics;
  headers: Array<[string, string]>;
  routePattern: string | null;
  status: number;
  statusText: string;
};

export type NextProxyWorkerResult = {
  body: Buffer;
  headers: Array<[string, string]>;
  matched: boolean;
  outcome: "next" | "redirect" | "response" | "rewrite";
  requestHeaders: Array<[string, string]>;
  status: number;
  statusText: string;
  url: string;
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
        env: {
          ...process.env,
          NODE_PATH: [
            process.env.NODE_PATH,
            resolve(process.cwd(), "node_modules", "next", "dist", "compiled"),
          ]
            .filter(Boolean)
            .join(delimiter),
        },
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
    if (reply.bodyBase64 === undefined)
      throw new Error("Next RSC worker returned no Flight payload.");
    return {
      cacheMetrics: reply.cacheMetrics ?? {
        hits: 0,
        misses: 0,
        revalidations: 0,
        staleHits: 0,
        writes: 0,
      },
      contentType: reply.contentType ?? "text/x-component; charset=utf-8",
      flight: Buffer.from(reply.bodyBase64, "base64"),
      formState: reply.formState,
      headers: reply.headers ?? [],
      routePattern: reply.routePattern ?? null,
      status: reply.status ?? 200,
      stylePaths: reply.stylePaths ?? [],
    };
  }

  private routeHandlerResult(reply: WorkerReply): NextRouteHandlerWorkerResult {
    if (reply.bodyBase64 === undefined) {
      throw new Error("Next RSC worker returned no Route Handler payload.");
    }
    return {
      body: Buffer.from(reply.bodyBase64, "base64"),
      cacheMetrics: reply.cacheMetrics ?? {
        hits: 0,
        misses: 0,
        revalidations: 0,
        staleHits: 0,
        writes: 0,
      },
      headers: reply.headers ?? [],
      routePattern: reply.routePattern ?? null,
      status: reply.status ?? 200,
      statusText: reply.statusText ?? "",
    };
  }

  async render(
    artifact: NextRequestArtifact,
    url: string,
    headers: Array<[string, string]> = [],
  ) {
    if (!this.installed.has(artifact.generation)) {
      await this.send({ artifact, type: "install" });
      this.installed.add(artifact.generation);
    }
    const reply = await this.send({
      generation: artifact.generation,
      headers,
      type: "render",
      url,
    });
    return this.result(reply);
  }

  async renderLoading(
    artifact: NextRequestArtifact,
    url: string,
    headers: Array<[string, string]> = [],
  ) {
    if (!this.installed.has(artifact.generation)) {
      await this.send({ artifact, type: "install" });
      this.installed.add(artifact.generation);
    }
    return this.result(
      await this.send({
        generation: artifact.generation,
        headers,
        type: "loading",
        url,
      }),
    );
  }

  async invokeAction(
    artifact: NextRequestArtifact,
    input: {
      actionId: string;
      body: NextSerializedActionBody;
      headers: Array<[string, string]>;
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

  async invokeProgressiveAction(
    artifact: NextRequestArtifact,
    input: {
      body: NextSerializedActionBody;
      headers: Array<[string, string]>;
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
        type: "progressive-action",
      }),
    );
  }

  async invokeRouteHandler(
    artifact: NextRequestArtifact,
    input: {
      bodyBase64?: string;
      headers: Array<[string, string]>;
      method: string;
      url: string;
    },
  ) {
    if (!this.installed.has(artifact.generation)) {
      await this.send({ artifact, type: "install" });
      this.installed.add(artifact.generation);
    }
    return this.routeHandlerResult(
      await this.send({
        ...input,
        generation: artifact.generation,
        type: "route-handler",
      }),
    );
  }

  async invokeProxy(
    artifact: NextRequestArtifact,
    input: {
      bodyBase64?: string;
      headers: Array<[string, string]>;
      method: string;
      url: string;
    },
  ): Promise<NextProxyWorkerResult> {
    if (!this.installed.has(artifact.generation)) {
      await this.send({ artifact, type: "install" });
      this.installed.add(artifact.generation);
    }
    const reply = await this.send({
      ...input,
      generation: artifact.generation,
      type: "proxy",
    });
    if (
      reply.bodyBase64 === undefined ||
      reply.proxyMatched === undefined ||
      !reply.proxyOutcome ||
      !reply.requestHeaders ||
      !reply.url
    ) {
      throw new Error("Next RSC worker returned an incomplete proxy result.");
    }
    return {
      body: Buffer.from(reply.bodyBase64, "base64"),
      headers: reply.headers ?? [],
      matched: reply.proxyMatched,
      outcome: reply.proxyOutcome,
      requestHeaders: reply.requestHeaders,
      status: reply.status ?? 200,
      statusText: reply.statusText ?? "",
      url: reply.url,
    };
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
