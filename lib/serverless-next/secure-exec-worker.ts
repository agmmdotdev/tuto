import { randomBytes, randomUUID, webcrypto } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import path from "node:path";
import type {
  NetworkAdapter,
  NodeRuntime,
  VirtualFileSystem,
} from "secure-exec";
import {
  getNextCacheAdapter,
  type NextCacheGetInput,
  type NextCacheLock,
  type NextCacheLockInput,
  type NextCacheRevalidateInput,
  type NextCacheSetInput,
} from "./cache-adapter";

type SecureExecModule = typeof import("secure-exec");

export type NextSecureWorkerKind = "rsc" | "ssr";

type SecureWorkspaceEntry = {
  active: number;
  installed: Set<string>;
  lastUsed: number;
  worker: Promise<NextSecureExecWorker>;
};

export type NextSecureWorkerReply = {
  error?: string;
  id: string;
  ok: boolean;
  [key: string]: unknown;
};

export type NextSecureWorkerStream = {
  errorInput(error: unknown): Promise<void>;
  final: Promise<unknown>;
  stream: ReadableStream<Uint8Array>;
  writeInput(chunk?: Uint8Array, done?: boolean): Promise<void>;
};

const runtimeRoot = "/root/tuto-next-runtime";
const maxBridgePayloadBytes = 32 * 1024 * 1024;
const maxCachePayloadBytes = 8 * 1024 * 1024;
const maxStudentFetchBytes = 8 * 1024 * 1024;
const maxStudentFetchRedirects = 5;
const studentFetchTimeoutMs = 10_000;

function secureWorkspaceLimit(value = process.env.TUTO_NEXT_SECURE_WORKERS) {
  if (value === undefined || value.trim() === "") return 2;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) {
    throw new Error(
      `TUTO_NEXT_SECURE_WORKERS must be an integer from 1 through 8; received ${JSON.stringify(value)}.`,
    );
  }
  return parsed;
}

function secureRequestTimeout(
  value = process.env.TUTO_NEXT_REQUEST_TIMEOUT_MS,
) {
  if (value === undefined || value.trim() === "") return 15_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 60_000) {
    throw new Error(
      `TUTO_NEXT_REQUEST_TIMEOUT_MS must be an integer from 100 through 60000; received ${JSON.stringify(value)}.`,
    );
  }
  return parsed;
}

function nextNetworkAllowlist(value = process.env.TUTO_NEXT_NETWORK_ALLOWLIST) {
  const origins = new Set<string>();
  for (const entry of value?.split(",") ?? []) {
    const candidate = entry.trim();
    if (!candidate) continue;
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(
        `TUTO_NEXT_NETWORK_ALLOWLIST only accepts HTTP(S) origins; received ${JSON.stringify(candidate)}.`,
      );
    }
    if (url.username || url.password || url.origin !== candidate.replace(/\/$/, "")) {
      throw new Error(
        `TUTO_NEXT_NETWORK_ALLOWLIST entries must be URL origins; received ${JSON.stringify(candidate)}.`,
      );
    }
    origins.add(url.origin);
  }
  return origins;
}

function isTestLoopback(url: URL) {
  return (
    process.env.NODE_ENV === "test" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost")
  );
}

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase().startsWith("::ffff:")
    ? address.slice(7)
    : address;
  if (isIP(normalized) === 4) {
    const [a, b, c] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:")
    );
  }
  return true;
}

async function assertPublicStudentUrl(url: URL) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error("Outbound request resolved to a private address.");
    }
    return;
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new Error("Outbound request resolved to a private address.");
  }
}

function studentUrlAllowed(rawUrl: string, allowedOrigins: Set<string>) {
  try {
    const url = new URL(rawUrl);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (allowedOrigins.has(url.origin) || isTestLoopback(url))
    );
  } catch {
    return false;
  }
}

async function studentFetch(
  rawUrl: string,
  options: { body?: string | null; headers?: Record<string, string>; method?: string },
  allowedOrigins: Set<string>,
) {
  if (Buffer.byteLength(options.body ?? "") > maxStudentFetchBytes) {
    throw new Error("Outbound request exceeded the student fetch limit.");
  }
  let url = rawUrl;
  let redirected = false;
  let requestOptions = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), studentFetchTimeoutMs);
  try {
    for (
      let redirectCount = 0;
      redirectCount <= maxStudentFetchRedirects;
      redirectCount++
    ) {
      if (!studentUrlAllowed(url, allowedOrigins)) {
        throw new Error(
          "Outbound URL is not present in TUTO_NEXT_NETWORK_ALLOWLIST.",
        );
      }
      const parsedUrl = new URL(url);
      if (!isTestLoopback(parsedUrl)) await assertPublicStudentUrl(parsedUrl);
      const response = await fetch(url, {
        body: requestOptions.body,
        headers: requestOptions.headers,
        method: requestOptions.method ?? "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) break;
        await response.body?.cancel();
        url = new URL(location, url).href;
        redirected = true;
        if ([301, 302, 303].includes(response.status)) {
          requestOptions = { ...requestOptions, body: null, method: "GET" };
        }
        continue;
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > maxStudentFetchBytes
      ) {
        await response.body?.cancel();
        throw new Error("Outbound response exceeded the student fetch limit.");
      }
      const chunks: Buffer[] = [];
      let received = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const bytes = Buffer.from(value);
            received += bytes.byteLength;
            if (received > maxStudentFetchBytes) {
              await reader.cancel();
              throw new Error(
                "Outbound response exceeded the student fetch limit.",
              );
            }
            chunks.push(bytes);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const bytes = Buffer.concat(chunks, received);
      const headers = Object.fromEntries(response.headers.entries());
      delete headers["content-encoding"];
      const contentType = response.headers.get("content-type") ?? "";
      const binary =
        contentType.includes("application/octet-stream") ||
        contentType.includes("application/gzip") ||
        contentType.startsWith("image/") ||
        contentType.startsWith("audio/") ||
        contentType.startsWith("video/");
      if (binary) headers["x-body-encoding"] = "base64";
      return {
        body: bytes.toString(binary ? "base64" : "utf8"),
        headers,
        ok: response.ok,
        redirected,
        status: response.status,
        statusText: response.statusText,
        url,
      };
    }
    throw new Error("Outbound request exceeded the redirect limit.");
  } finally {
    clearTimeout(timeout);
  }
}

function loadSecureExec() {
  const globals = globalThis as typeof globalThis & {
    __non_webpack_require__?: NodeJS.Require;
  };
  globals.__non_webpack_require__ ??= createRequire(
    path.join(process.cwd(), "package.json"),
  );
  return import("secure-exec") as Promise<SecureExecModule>;
}

function withPreferredExportCondition(
  value: unknown,
  condition: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      withPreferredExportCondition(entry, condition),
    );
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const rewritten = Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      withPreferredExportCondition(entry, condition),
    ]),
  );
  if (condition in record) {
    rewritten.default = withPreferredExportCondition(
      record[condition],
      condition,
    );
  }
  return rewritten;
}

function withReactServerCondition(
  filesystem: VirtualFileSystem,
): VirtualFileSystem {
  return new Proxy(filesystem, {
    get(target, property) {
      if (property === "readTextFile") {
        return async (filePath: string) => {
          const source = await target.readTextFile(filePath);
          if (
            filePath ===
            "/root/node_modules/next/dist/server/lib/patch-fetch.js"
          ) {
            const assignment =
              "globalThis.fetch = createPatchedFetcher(original, options);";
            const original =
              "const original = (0, _dedupefetch.createDedupeFetch)(globalThis.fetch);";
            if (!source.includes(assignment) || !source.includes(original)) {
              throw new Error(
                "The installed Next patch-fetch implementation no longer matches Tuto's SecureExec compatibility patch.",
              );
            }
            return source
              .replace(
                original,
                "const original = (0, _dedupefetch.createDedupeFetch)(globalThis.__TUTO_NEXT_ORIGIN_FETCH__ ?? globalThis.fetch);",
              )
              .replace(
                assignment,
                "globalThis.__TUTO_NEXT_PATCHED_FETCH__ = createPatchedFetcher(original, options);",
              );
          }
          if (
            filePath ===
            "/root/node_modules/next/dist/server/use-cache/use-cache-wrapper.js"
          ) {
            const performanceClock =
              "performance.timeOrigin + performance.now()";
            if (!source.includes(performanceClock)) {
              throw new Error(
                "The installed Next use-cache clock no longer matches Tuto's SecureExec compatibility patch.",
              );
            }
            return source.replaceAll(performanceClock, "Date.now()");
          }
          if (
            !filePath.startsWith("/root/node_modules/") ||
            !filePath.endsWith("/package.json")
          ) {
            return source;
          }
          const packageJson = JSON.parse(source) as Record<string, unknown>;
          if (!("exports" in packageJson) && !("imports" in packageJson)) {
            return source;
          }
          return JSON.stringify({
            ...packageJson,
            ...(packageJson.exports === undefined
              ? {}
              : {
                  exports: withPreferredExportCondition(
                    packageJson.exports,
                    "react-server",
                  ),
                }),
            ...(packageJson.imports === undefined
              ? {}
              : {
                  imports: withPreferredExportCondition(
                    packageJson.imports,
                    "react-server",
                  ),
                }),
          });
        };
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

function nextCompiledAliasPath(filePath: string) {
  for (const packageName of ["client-only", "server-only"]) {
    const packageRoot = `/root/node_modules/${packageName}`;
    if (filePath === packageRoot || filePath.startsWith(`${packageRoot}/`)) {
      return filePath.replace(
        packageRoot,
        `/root/node_modules/next/dist/compiled/${packageName}`,
      );
    }
  }
  return filePath;
}

function withNextCompiledAliases(
  filesystem: VirtualFileSystem,
): VirtualFileSystem {
  return new Proxy(filesystem, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        if (typeof args[0] === "string") {
          args[0] = nextCompiledAliasPath(args[0]);
        }
        return (member as (...values: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

function cacheOperation(
  operation: string,
  input: unknown,
  activeWorkspaceKey: string | undefined,
) {
  if (
    !input ||
    typeof input !== "object" ||
    !("workspaceKey" in input) ||
    (input as { workspaceKey?: unknown }).workspaceKey !== activeWorkspaceKey
  ) {
    throw new Error("The cache request is outside the active workspace.");
  }
  const adapter = getNextCacheAdapter();
  if (operation === "get") {
    return adapter.get(input as NextCacheGetInput);
  }
  if (operation === "set") {
    return adapter.set(input as NextCacheSetInput);
  }
  if (operation === "acquireLock") {
    return adapter.acquireLock(input as NextCacheLockInput);
  }
  if (operation === "releaseLock") {
    return adapter.releaseLock(input as NextCacheLock);
  }
  if (operation === "revalidateTags") {
    return adapter.revalidateTags(input as NextCacheRevalidateInput);
  }
  throw new Error(`Unsupported cache operation ${JSON.stringify(operation)}.`);
}

function responseShape(
  url: string,
  status: number,
  body: string,
  statusText = "",
) {
  return {
    body,
    headers: { "content-type": "application/json" },
    ok: status >= 200 && status < 300,
    redirected: false,
    status,
    statusText,
    url,
  };
}

function secureWorkerEntry(
  kind: NextSecureWorkerKind,
  cacheEndpoint: string,
  cryptoEndpoint: string,
) {
  const workerFile = `${runtimeRoot}/${kind}-runtime-worker.cjs`;
  return `
globalThis.__TUTO_NEXT_SECURE_EXEC__ = true;
${kind === "rsc" ? `globalThis.__TUTO_NEXT_CACHE_ENDPOINT__ = ${JSON.stringify(cacheEndpoint)};` : ""}
globalThis.__TUTO_NEXT_CRYPTO_ENDPOINT__ = ${JSON.stringify(cryptoEndpoint)};
const { handleMessage } = require(${JSON.stringify(workerFile)});
const http = require("node:http");
let queue = Promise.resolve();
const maxBodyBytes = ${maxBridgePayloadBytes};
const server = http.createServer((request, response) => {
  return new Promise((resolveRequest) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= maxBodyBytes) chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => {
      const run = async () => {
        let message;
        try {
          if (bytes > maxBodyBytes) throw new Error("SecureExec worker request is too large.");
          message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const result = await handleMessage(message);
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ ...result, id: message.id, ok: true }));
        } catch (error) {
          response.statusCode = 500;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({
            error: error instanceof Error ? (error.stack || error.message) : String(error),
            id: message && typeof message.id === "string" ? message.id : "unknown",
            ok: false,
          }));
        }
      };
      let parsedType;
      try {
        parsedType = JSON.parse(Buffer.concat(chunks).toString("utf8")).type;
      } catch {}
      if (["stream-cancel", "stream-error", "stream-pull", "stream-write"].includes(parsedType)) {
        resolveRequest(run());
      } else {
        queue = queue.then(run);
        resolveRequest(queue);
      }
    });
  });
});
server.listen(0, "127.0.0.1");
`;
}

export class NextSecureExecWorker {
  private activeWorkspaceKey: string | undefined;
  private address: string | undefined;
  private generations = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private runtime: NodeRuntime | undefined;
  private serverExecution: Promise<{ code: number; errorMessage?: string }> | undefined;
  private workspaceKey: string | undefined;
  private readonly timeoutMs = secureRequestTimeout();

  private constructor(private readonly kind: NextSecureWorkerKind) {}

  static async create(kind: NextSecureWorkerKind) {
    const worker = new NextSecureExecWorker(kind);
    await worker.start();
    return worker;
  }

  private async start() {
    const secureExec = await loadSecureExec();
    const filesystem = secureExec.createInMemoryFileSystem();
    const sourceRoot = path.resolve(process.cwd(), "lib", "serverless-next");
    const workerName = `${this.kind}-runtime-worker.cjs`;
    await filesystem.writeFile(
      `${runtimeRoot}/${workerName}`,
      await readFile(path.join(sourceRoot, workerName), "utf8"),
    );
    await filesystem.writeFile(
      `${runtimeRoot}/secure-node-compat.cjs`,
      await readFile(path.join(sourceRoot, "secure-node-compat.cjs"), "utf8"),
    );
    await filesystem.writeFile(
      `${runtimeRoot}/stream-runtime.cjs`,
      await readFile(path.join(sourceRoot, "stream-runtime.cjs"), "utf8"),
    );
    if (this.kind === "rsc") {
      await filesystem.writeFile(
        `${runtimeRoot}/cache-runtime.cjs`,
        await readFile(path.join(sourceRoot, "cache-runtime.cjs"), "utf8"),
      );
    }

    const cacheEndpoint = `https://tuto-cache.invalid/${randomBytes(32).toString("base64url")}`;
    const cryptoEndpoint = `https://tuto-crypto.invalid/${randomBytes(32).toString("base64url")}`;
    const activeWorkspaceKey = () => this.activeWorkspaceKey;
    const hostNetwork = secureExec.createDefaultNetworkAdapter();
    const allowedOrigins = nextNetworkAllowlist();
    let resolveAddress!: (address: string) => void;
    let rejectAddress!: (error: Error) => void;
    const address = new Promise<string>((resolve, reject) => {
      resolveAddress = resolve;
      rejectAddress = reject;
    });
    const networkAdapter: NetworkAdapter = {
      ...hostNetwork,
      async fetch(url, options) {
        if (url === cryptoEndpoint) {
          try {
            if ((options.body?.length ?? 0) > maxCachePayloadBytes) {
              throw new Error("The Web Crypto bridge request is too large.");
            }
            const request = JSON.parse(options.body ?? "null") as {
              input?: {
                algorithm?: string | { iv?: string; name?: string };
                data?: string;
                key?: string;
              };
              operation?: string;
            };
            const input = request.input;
            if (!input?.data || !request.operation) {
              throw new Error("The Web Crypto bridge request is malformed.");
            }
            const data = Buffer.from(input.data, "base64");
            let value: ArrayBuffer;
            if (request.operation === "digest") {
              value = await webcrypto.subtle.digest(
                String(input.algorithm),
                data,
              );
            } else {
              const algorithm = input.algorithm;
              if (
                !input.key ||
                !algorithm ||
                typeof algorithm === "string" ||
                algorithm.name !== "AES-GCM" ||
                !algorithm.iv
              ) {
                throw new Error("Only AES-GCM encryption is supported.");
              }
              const key = await webcrypto.subtle.importKey(
                "raw",
                Buffer.from(input.key, "base64"),
                "AES-GCM",
                false,
                [request.operation === "encrypt" ? "encrypt" : "decrypt"],
              );
              value = await (request.operation === "encrypt"
                ? webcrypto.subtle.encrypt(
                    {
                      name: "AES-GCM",
                      iv: Buffer.from(algorithm.iv, "base64"),
                    },
                    key,
                    data,
                  )
                : request.operation === "decrypt"
                  ? webcrypto.subtle.decrypt(
                      {
                        name: "AES-GCM",
                        iv: Buffer.from(algorithm.iv, "base64"),
                      },
                      key,
                      data,
                    )
                  : Promise.reject(
                      new Error("Unsupported Web Crypto operation."),
                    ));
            }
            return responseShape(
              url,
              200,
              JSON.stringify({
                ok: true,
                value: Buffer.from(value).toString("base64"),
              }),
            );
          } catch (error) {
            return responseShape(
              url,
              400,
              JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
                ok: false,
              }),
              "Bad Request",
            );
          }
        }
        if (url !== cacheEndpoint) {
          return studentFetch(url, options, allowedOrigins);
        }
        try {
          if ((options.body?.length ?? 0) > maxCachePayloadBytes) {
            throw new Error("The cache bridge request is too large.");
          }
          const request = JSON.parse(options.body ?? "null") as {
            input?: unknown;
            operation?: unknown;
          };
          if (typeof request.operation !== "string") {
            throw new Error("The cache bridge request is malformed.");
          }
          const value = await cacheOperation(
            request.operation,
            request.input,
            activeWorkspaceKey(),
          );
          return responseShape(url, 200, JSON.stringify({ ok: true, value }));
        } catch (error) {
          return responseShape(
            url,
            400,
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              ok: false,
            }),
            "Bad Request",
          );
        }
      },
      async httpServerListen(options) {
        try {
          const result = await hostNetwork.httpServerListen!(options);
          const bound = result.address;
          if (!bound) throw new Error("SecureExec returned no server address.");
          resolveAddress(`http://127.0.0.1:${bound.port}`);
          return result;
        } catch (error) {
          rejectAddress(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      },
    };

    const baseDriver = secureExec.createNodeDriver({
      filesystem,
      moduleAccess: { cwd: process.cwd() },
      networkAdapter,
      permissions: {
        childProcess: () => ({ allow: false }),
        env: ({ key, op }) => ({
          allow:
            op === "read" &&
            (key === "NODE_ENV" || key.startsWith("__NEXT_")),
        }),
        fs: ({ op, path: requestedPath }) => ({
          allow:
            op !== "write" &&
            op !== "mkdir" &&
            op !== "createDir" &&
            op !== "rm" &&
            op !== "rename" &&
            op !== "chmod" &&
            op !== "chown" &&
            op !== "link" &&
            op !== "symlink" &&
            op !== "truncate" &&
            op !== "utimes" &&
            (requestedPath === runtimeRoot ||
              requestedPath.startsWith(`${runtimeRoot}/`) ||
              requestedPath === "/root" ||
              requestedPath === "/root/node_modules" ||
              requestedPath.startsWith("/root/node_modules/")),
        }),
        network: ({ hostname, op, url }) => ({
          allow:
            (op === "listen" && hostname === "127.0.0.1") ||
            (op === "fetch" &&
              (url === cacheEndpoint ||
                url === cryptoEndpoint ||
                (typeof url === "string" &&
                  studentUrlAllowed(url, allowedOrigins)))),
        }),
      },
      processConfig: {
        cwd: runtimeRoot,
        env: {
          NODE_ENV: "production",
          __NEXT_CACHE_COMPONENTS: "true",
          __NEXT_USE_CACHE: "true",
        },
      },
    });
    if (baseDriver.filesystem) {
      baseDriver.filesystem = withNextCompiledAliases(baseDriver.filesystem);
      if (this.kind === "rsc") {
        baseDriver.filesystem = withReactServerCondition(baseDriver.filesystem);
      }
    }
    const runtime = new secureExec.NodeRuntime({
      memoryLimit: 256,
      payloadLimits: {
        base64TransferBytes: maxBridgePayloadBytes,
        jsonPayloadBytes: maxBridgePayloadBytes,
      },
      resourceBudgets: {
        maxBridgeCalls: 100_000,
        maxChildProcesses: 0,
        maxHandles: 32,
        maxOutputBytes: 64 * 1024,
        maxTimers: 1_024,
      },
      runtimeDriverFactory: secureExec.createNodeRuntimeDriverFactory(),
      systemDriver: baseDriver,
    });
    this.runtime = runtime;
    this.serverExecution = runtime.exec(
      secureWorkerEntry(this.kind, cacheEndpoint, cryptoEndpoint),
      {
        cwd: runtimeRoot,
        filePath: `${runtimeRoot}/entry.cjs`,
      },
    );
    this.address = await Promise.race([
      address,
      this.serverExecution.then((result) => {
        throw new Error(
          result.errorMessage ??
            `The SecureExec ${this.kind.toUpperCase()} worker exited with code ${result.code}.`,
        );
      }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("The SecureExec worker did not become ready.")),
          10_000,
        );
      }),
    ]);
  }

  send(message: Record<string, unknown>) {
    const operation = this.queue.then(() => this.sendOne(message));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private sendControl(message: Record<string, unknown>) {
    return this.sendOne(message);
  }

  async openStream(
    message: Record<string, unknown>,
  ): Promise<NextSecureWorkerReply & NextSecureWorkerStream> {
    const reply = await this.send(message);
    if (typeof reply.streamId !== "string") {
      throw new Error(
        `The SecureExec ${this.kind.toUpperCase()} worker returned no response stream.`,
      );
    }
    const streamId = reply.streamId;
    const inputStreamId =
      typeof reply.inputStreamId === "string" ? reply.inputStreamId : undefined;
    const generation =
      typeof message.generation === "string" ? message.generation : undefined;
    let resolveFinal!: (value: unknown) => void;
    let rejectFinal!: (error: unknown) => void;
    let settled = false;
    let idleTimeout: NodeJS.Timeout | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const final = new Promise<unknown>((resolve, reject) => {
      resolveFinal = resolve;
      rejectFinal = reject;
    });
    void final.catch(() => undefined);
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      if (idleTimeout) clearTimeout(idleTimeout);
      resolveFinal(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (idleTimeout) clearTimeout(idleTimeout);
      rejectFinal(error);
    };
    const armIdleTimeout = () => {
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        const error = new Error(
          `The SecureExec ${this.kind.toUpperCase()} response stream was idle for ${this.timeoutMs}ms.`,
        );
        void this.sendControl({
          generation,
          reason: error.message,
          streamId,
          type: "stream-cancel",
        }).catch(() => undefined);
        fail(error);
        streamController?.error(error);
      }, this.timeoutMs);
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamController = controller;
      },
      pull: async (controller) => {
        if (idleTimeout) clearTimeout(idleTimeout);
        try {
          const next = await this.sendControl({
            generation,
            streamId,
            type: "stream-pull",
          });
          if (next.streamDone === true) {
            finish(next.streamFinal);
            controller.close();
            return;
          }
          if (typeof next.streamChunkBase64 !== "string") {
            throw new Error("The SecureExec worker returned an invalid stream chunk.");
          }
          controller.enqueue(Buffer.from(next.streamChunkBase64, "base64"));
          armIdleTimeout();
        } catch (error) {
          fail(error);
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        if (idleTimeout) clearTimeout(idleTimeout);
        try {
          await this.sendControl({
            generation,
            reason: typeof reason === "string" ? reason : "Host cancelled response stream.",
            streamId,
            type: "stream-cancel",
          });
          finish({ cancelled: true });
        } catch (error) {
          fail(error);
          throw error;
        }
      },
    });
    const writeInput = async (chunk?: Uint8Array, done = false) => {
      if (!inputStreamId) {
        throw new Error("The SecureExec worker stream has no request body channel.");
      }
      await this.sendControl({
        generation,
        inputStreamId,
        streamChunkBase64: chunk ? Buffer.from(chunk).toString("base64") : undefined,
        streamDone: done,
        type: "stream-write",
      });
    };
    const errorInput = async (error: unknown) => {
      if (!inputStreamId) return;
      await this.sendControl({
        error: error instanceof Error ? error.message : String(error),
        generation,
        inputStreamId,
        type: "stream-error",
      });
    };
    return { ...reply, errorInput, final, stream, writeInput };
  }

  private async sendOne(message: Record<string, unknown>) {
    if (!this.address || !this.runtime) {
      throw new Error("The SecureExec Next worker is not running.");
    }
    const id = randomUUID();
    const artifact = message.artifact as
      | { generation?: unknown; workspaceKey?: unknown }
      | undefined;
    if (
      message.type === "install" &&
      typeof artifact?.generation === "string" &&
      typeof artifact.workspaceKey === "string"
    ) {
      if (this.workspaceKey && this.workspaceKey !== artifact.workspaceKey) {
        throw new Error(
          "A SecureExec Next worker cannot execute more than one workspace.",
        );
      }
      this.workspaceKey = artifact.workspaceKey;
      this.generations.set(artifact.generation, artifact.workspaceKey);
    }
    const generation =
      typeof message.generation === "string"
        ? message.generation
        : typeof artifact?.generation === "string"
          ? artifact.generation
          : undefined;
    this.activeWorkspaceKey = generation
      ? this.generations.get(generation)
      : undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.address, {
        body: JSON.stringify({ ...message, id }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      const responseBody = await response.text();
      if (!responseBody) {
        throw new Error(
          `The SecureExec ${this.kind.toUpperCase()} worker returned an empty HTTP ${response.status} response.`,
        );
      }
      const reply = JSON.parse(responseBody) as NextSecureWorkerReply;
      if (!response.ok || !reply.ok) {
        throw new Error(
          reply.error ?? `The SecureExec ${this.kind.toUpperCase()} worker failed.`,
        );
      }
      return reply;
    } catch (error) {
      if (controller.signal.aborted) {
        await this.close();
        throw new Error(
          `The SecureExec ${this.kind.toUpperCase()} worker request timed out.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.activeWorkspaceKey = undefined;
    }
  }

  async close() {
    const runtime = this.runtime;
    this.runtime = undefined;
    this.address = undefined;
    this.generations.clear();
    this.workspaceKey = undefined;
    if (!runtime) return;
    await runtime.terminate();
    await this.serverExecution?.catch(() => undefined);
    this.serverExecution = undefined;
  }

  get running() {
    return this.runtime !== undefined && this.address !== undefined;
  }
}

export class NextSecureExecWorkspacePool {
  private allocationQueue: Promise<void> = Promise.resolve();
  private readonly artifacts = new Map<
    string,
    { generation: string; workspaceKey: string }
  >();
  private readonly available = new Set<() => void>();
  private readonly generationWorkspaces = new Map<string, string>();
  private readonly limit = secureWorkspaceLimit();
  private readonly workers = new Map<string, SecureWorkspaceEntry>();

  constructor(private readonly kind: NextSecureWorkerKind) {}

  private signalAvailable() {
    for (const resolve of this.available) resolve();
    this.available.clear();
  }

  private waitForAvailable() {
    return new Promise<void>((resolve) => this.available.add(resolve));
  }

  private allocate(workspaceKey: string) {
    let resolveEntry!: (entry: SecureWorkspaceEntry) => void;
    let rejectEntry!: (error: unknown) => void;
    const result = new Promise<SecureWorkspaceEntry>((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });
    const operation = this.allocationQueue.then(async () => {
      for (;;) {
        const existing = this.workers.get(workspaceKey);
        if (existing) {
          if (existing.active > 0) {
            await this.waitForAvailable();
            continue;
          }
          existing.active += 1;
          existing.lastUsed = Date.now();
          resolveEntry(existing);
          return;
        }
        if (this.workers.size < this.limit) {
          const entry: SecureWorkspaceEntry = {
            active: 1,
            installed: new Set(),
            lastUsed: Date.now(),
            worker: NextSecureExecWorker.create(this.kind),
          };
          this.workers.set(workspaceKey, entry);
          resolveEntry(entry);
          return;
        }
        const idle = [...this.workers.entries()]
          .filter(([, entry]) => entry.active === 0)
          .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0];
        if (!idle) {
          await this.waitForAvailable();
          continue;
        }
        this.workers.delete(idle[0]);
        await idle[1].worker.then(
          (worker) => worker.close(),
          () => undefined,
        );
      }
    });
    this.allocationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    void operation.catch(rejectEntry);
    return result;
  }

  private release(entry: SecureWorkspaceEntry) {
    entry.active -= 1;
    entry.lastUsed = Date.now();
    if (entry.active === 0) this.signalAvailable();
  }

  async send(message: Record<string, unknown>) {
    const artifact = message.artifact as
      | { generation?: unknown; workspaceKey?: unknown }
      | undefined;
    if (
      message.type === "install" &&
      typeof artifact?.generation === "string" &&
      typeof artifact.workspaceKey === "string"
    ) {
      const previous = this.generationWorkspaces.get(artifact.generation);
      if (previous && previous !== artifact.workspaceKey) {
        throw new Error(
          `Next generation ${artifact.generation} belongs to multiple workspaces.`,
        );
      }
      this.artifacts.set(artifact.generation, {
        ...artifact,
        generation: artifact.generation,
        workspaceKey: artifact.workspaceKey,
      });
      this.generationWorkspaces.set(
        artifact.generation,
        artifact.workspaceKey,
      );
    }
    const generation =
      typeof message.generation === "string"
        ? message.generation
        : typeof artifact?.generation === "string"
          ? artifact.generation
          : undefined;
    const workspaceKey = generation
      ? this.generationWorkspaces.get(generation)
      : undefined;
    if (!generation || !workspaceKey) {
      throw new Error("SecureExec Next messages require an installed generation.");
    }
    const entry = await this.allocate(workspaceKey);
    try {
      const worker = await entry.worker;
      if (!entry.installed.has(generation)) {
        const storedArtifact = this.artifacts.get(generation);
        if (!storedArtifact) {
          throw new Error(`Next generation ${generation} has no stored artifact.`);
        }
        const reply = await worker.send({
          artifact: storedArtifact,
          type: "install",
        });
        entry.installed.add(generation);
        if (message.type === "install") return reply;
      }
      return worker.send(message);
    } catch (error) {
      const worker = await entry.worker.catch(() => undefined);
      if (!worker?.running && this.workers.get(workspaceKey) === entry) {
        this.workers.delete(workspaceKey);
      }
      throw error;
    } finally {
      this.release(entry);
    }
  }

  async openStream(message: Record<string, unknown>) {
    const generation =
      typeof message.generation === "string" ? message.generation : undefined;
    const workspaceKey = generation
      ? this.generationWorkspaces.get(generation)
      : undefined;
    if (!generation || !workspaceKey) {
      throw new Error("SecureExec Next streams require an installed generation.");
    }
    const entry = await this.allocate(workspaceKey);
    try {
      const worker = await entry.worker;
      if (!entry.installed.has(generation)) {
        const storedArtifact = this.artifacts.get(generation);
        if (!storedArtifact) {
          throw new Error(`Next generation ${generation} has no stored artifact.`);
        }
        await worker.send({ artifact: storedArtifact, type: "install" });
        entry.installed.add(generation);
      }
      const opened = await worker.openStream(message);
      void opened.final.then(
        () => this.release(entry),
        () => this.release(entry),
      );
      return opened;
    } catch (error) {
      const worker = await entry.worker.catch(() => undefined);
      if (!worker?.running && this.workers.get(workspaceKey) === entry) {
        this.workers.delete(workspaceKey);
      }
      this.release(entry);
      throw error;
    }
  }

  statsForTests() {
    return {
      limit: this.limit,
      workspaces: [...this.workers.keys()],
    };
  }

  async close() {
    await this.allocationQueue;
    const entries = [...this.workers.values()];
    this.workers.clear();
    this.artifacts.clear();
    this.generationWorkspaces.clear();
    this.signalAvailable();
    await Promise.all(
      entries.map((entry) =>
        entry.worker.then(
          (worker) => worker.close(),
          () => undefined,
        ),
      ),
    );
  }
}
