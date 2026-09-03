import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter, resolve } from "node:path";
import type { NextRequestArtifact } from "./artifact";
import { getNextExecutionMode } from "./execution-mode";
import { compileNextProxyMatchers } from "./proxy-matchers";
import { NextSecureExecWorkspacePool } from "./secure-exec-worker";
import {
  getNextCacheAdapter,
  type NextCacheGetInput,
  type NextCacheLock,
  type NextCacheLockInput,
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
  proxyConfig?: unknown;
  requestHeaders?: Array<[string, string]>;
  routePattern?: string | null;
  status?: number;
  statusText?: string;
  streamChunkBase64?: string;
  streamDone?: boolean;
  streamFinal?: unknown;
  streamId?: string;
  stylePaths?: string[];
  type?: undefined;
  url?: string;
};

type WorkerCacheRequest = {
  input:
    | NextCacheGetInput
    | NextCacheLock
    | NextCacheLockInput
    | NextCacheRevalidateInput
    | NextCacheSetInput;
  operation: "acquireLock" | "get" | "releaseLock" | "revalidateTags" | "set";
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

export type NextFlightStreamWorkerResult = Omit<
  NextFlightWorkerResult,
  "flight"
> & {
  final: Promise<unknown>;
  flight: ReadableStream<Uint8Array>;
};

export type NextRouteHandlerWorkerResult = {
  body: Buffer;
  cacheMetrics: NextCacheMetrics;
  headers: Array<[string, string]>;
  routePattern: string | null;
  status: number;
  statusText: string;
};

export type NextRouteHandlerStreamWorkerResult = Omit<
  NextRouteHandlerWorkerResult,
  "body"
> & {
  body: ReadableStream<Uint8Array>;
  final: Promise<unknown>;
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
  private readonly executionMode = getNextExecutionMode();
  private installed = new Set<string>();
  private pending = new Map<string, Pending>();
  private proxyMatchers = new Map<string, unknown[] | null>();
  private secureWorkers: NextSecureExecWorkspacePool | undefined;

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
            : message.operation === "acquireLock"
              ? await adapter.acquireLock(message.input as NextCacheLockInput)
              : message.operation === "releaseLock"
                ? await adapter.releaseLock(message.input as NextCacheLock)
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
    if (this.executionMode === "secure-exec") {
      this.secureWorkers ??= new NextSecureExecWorkspacePool("rsc");
      return this.secureWorkers.send(message) as Promise<WorkerReply>;
    }
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

  private async openStream(message: Record<string, unknown>) {
    if (this.executionMode === "secure-exec") {
      this.secureWorkers ??= new NextSecureExecWorkspacePool("rsc");
      return this.secureWorkers.openStream(message);
    }
    const reply = await this.send(message);
    if (typeof reply.streamId !== "string") {
      throw new Error("Next RSC worker returned no response stream.");
    }
    const streamId = reply.streamId;
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
            throw new Error("Next RSC worker returned an invalid stream chunk.");
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
    return { ...reply, final, stream };
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

  async renderStream(
    artifact: NextRequestArtifact,
    url: string,
    headers: Array<[string, string]> = [],
  ): Promise<NextFlightStreamWorkerResult> {
    if (!this.installed.has(artifact.generation)) {
      await this.send({ artifact, type: "install" });
      this.installed.add(artifact.generation);
    }
    const reply = await this.openStream({
      generation: artifact.generation,
      headers,
      type: "render-stream",
      url,
    });
    return {
      cacheMetrics: (reply.cacheMetrics as NextCacheMetrics | undefined) ?? {
        hits: 0,
        misses: 0,
        revalidations: 0,
        staleHits: 0,
        writes: 0,
      },
      contentType:
        typeof reply.contentType === "string"
          ? reply.contentType
          : "text/x-component; charset=utf-8",
      final: reply.final,
      flight: reply.stream,
      headers: (reply.headers as Array<[string, string]> | undefined) ?? [],
      routePattern:
        typeof reply.routePattern === "string" ? reply.routePattern : null,
      status: typeof reply.status === "number" ? reply.status : 200,
      stylePaths: (reply.stylePaths as string[] | undefined) ?? [],
    };
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

  async invokeRouteHandlerStream(
    artifact: NextRequestArtifact,
    input: {
      bodyBase64?: string;
      headers: Array<[string, string]>;
      method: string;
      url: string;
    },
  ): Promise<NextRouteHandlerStreamWorkerResult> {
    if (!this.installed.has(artifact.generation)) {
      await this.send({ artifact, type: "install" });
      this.installed.add(artifact.generation);
    }
    const reply = await this.openStream({
      ...input,
      generation: artifact.generation,
      type: "route-handler-stream",
    });
    return {
      body: reply.stream,
      cacheMetrics: (reply.cacheMetrics as NextCacheMetrics | undefined) ?? {
        hits: 0,
        misses: 0,
        revalidations: 0,
        staleHits: 0,
        writes: 0,
      },
      final: reply.final,
      headers: (reply.headers as Array<[string, string]> | undefined) ?? [],
      routePattern:
        typeof reply.routePattern === "string" ? reply.routePattern : null,
      status: typeof reply.status === "number" ? reply.status : 200,
      statusText:
        typeof reply.statusText === "string" ? reply.statusText : "",
    };
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
    let proxyMatchers: unknown[] | null | undefined;
    if (this.executionMode === "secure-exec") {
      proxyMatchers = this.proxyMatchers.get(artifact.generation);
      if (proxyMatchers === undefined) {
        const config = await this.send({
          generation: artifact.generation,
          type: "proxy-config",
        });
        proxyMatchers = compileNextProxyMatchers(config.proxyConfig);
        this.proxyMatchers.set(artifact.generation, proxyMatchers);
      }
    }
    const reply = await this.send({
      ...input,
      generation: artifact.generation,
      ...(proxyMatchers === undefined ? {} : { proxyMatchers }),
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
    const secureWorkers = this.secureWorkers;
    this.secureWorkers = undefined;
    await secureWorkers?.close();
    const child = this.child;
    this.child = undefined;
    this.installed.clear();
    this.proxyMatchers.clear();
    if (!child) return;
    child.disconnect();
    child.kill();
  }
}

const poolKey = Symbol.for("tuto.serverless-next.rsc-worker-pool.v2");

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
