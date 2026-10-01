import type { NextNavigationRequest } from "@/lib/serverless-next/navigation";
import { randomBytes } from "node:crypto";
import { nextPrefetchKey, nextPrefetchTickets } from "@/lib/serverless-next/prefetch";
import { matchNextRoute, matchNextRouteHandler } from "@/lib/serverless-next/route-manifest";
import { NextResponse } from "next/server";
import type { BuildDiagnostic, WorkspaceFile } from "@/lib/ide/types";
import { assertNextProductionExecutionIsolated } from "@/lib/serverless-next/execution-mode";

export const runtime = "nodejs";
export const maxDuration = 60;

const saltKey = Symbol.for("tuto.serverless-next.action-salt.v1");
const previewKey = Symbol.for("tuto.serverless-next.preview-capabilities.v1");
const maxRequestBytes = 6 * 1024 * 1024;
const maxPreviewCapabilities = 128;
const previewCapabilityTtlMs = 5 * 60 * 1_000;
const previewBridgeScript = `<script>
(() => {
  const previewSource = "tuto-serverless-nextjs-runtime-preview-log";
  const toText = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const send = (level, args) => window.parent?.postMessage({
    source: previewSource,
    level,
    message: args.map(toText).join(" "),
    timestamp: new Date().toISOString(),
  }, "*");
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level];
    console[level] = (...args) => {
      send(level, args);
      return original.apply(console, args);
    };
  }
  window.addEventListener("error", (event) => send("error", [event.message]));
  window.addEventListener("unhandledrejection", (event) => send("error", [event.reason]));
})();
</script>`;

function serverReferenceHashSalt() {
  const configured = process.env.TUTO_NEXT_SERVER_REFERENCE_HASH_SALT?.trim();
  if (configured) return configured;
  const globals = globalThis as typeof globalThis & { [saltKey]?: string };
  globals[saltKey] ??= randomBytes(32).toString("base64url");
  return globals[saltKey];
}

function diagnostic(message: string): BuildDiagnostic {
  return {
    id: crypto.randomUUID(),
    level: "error",
    message,
    timestamp: new Date().toISOString(),
  };
}

function injectPreviewBridge(html: string) {
  return html.includes("</body>")
    ? html.replace("</body>", () => `${previewBridgeScript}</body>`)
    : `${html}${previewBridgeScript}`;
}

type PreviewCapability = {
  expiresAt: number;
  navigationSequence?: number;
  navigationSession?: string;
  headers: Array<[string, string]>;
  revision: string;
  url: string;
};

function previewCapabilities() {
  const globals = globalThis as typeof globalThis & {
    [previewKey]?: Map<string, PreviewCapability>;
  };
  globals[previewKey] ??= new Map();
  return globals[previewKey];
}

function issuePreviewCapability(capability: Omit<PreviewCapability, "expiresAt">) {
  const capabilities = previewCapabilities();
  const token = randomBytes(24).toString("base64url");
  capabilities.set(token, {
    ...capability,
    expiresAt: Date.now() + previewCapabilityTtlMs,
  });
  while (capabilities.size > maxPreviewCapabilities) {
    capabilities.delete(capabilities.keys().next().value!);
  }
  return token;
}

function resolvePreviewCapability(token: string | null) {
  if (!token) return undefined;
  const capabilities = previewCapabilities();
  const capability = capabilities.get(token);
  if (!capability) return undefined;
  if (capability.expiresAt <= Date.now()) {
    capabilities.delete(token);
    return undefined;
  }
  capabilities.delete(token);
  capabilities.set(token, capability);
  return capability;
}

function injectPreviewBridgeStream(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffered += decoder.decode(chunk, { stream: true });
        const bodyClose = buffered.indexOf("</body>");
        const lastOpeningBracket = buffered.lastIndexOf("<");
        const lastClosingBracket = buffered.lastIndexOf(">");
        const emitLength =
          bodyClose >= 0
            ? bodyClose
            : lastOpeningBracket > lastClosingBracket
              ? lastOpeningBracket
              : buffered.length;
        if (emitLength <= 0) return;
        controller.enqueue(encoder.encode(buffered.slice(0, emitLength)));
        buffered = buffered.slice(emitLength);
      },
      flush(controller) {
        buffered += decoder.decode();
        controller.enqueue(encoder.encode(injectPreviewBridge(buffered)));
      },
    }),
  );
}

async function readPayload(request: Request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxRequestBytes) {
    throw new Error(
      "The Next runtime request exceeds the 6 MiB checkpoint limit.",
    );
  }
  return JSON.parse(text) as {
    action?: {
      actionId?: string;
      body?: unknown;
      headers?: Record<string, string> | Array<[string, string]>;
      revision?: string;
      url?: string;
    };
    navigation?: NextNavigationRequest & {
      revision: string;
      url: string;
      sequence?: number;
      prefetch?: boolean;
      prefetchOwner?: string;
      prefetchTicket?: string;
      prefetchMode?: "auto" | "full";
      prefetchShell?: boolean;
      headers?: Record<string, string>;
    };
    files?: WorkspaceFile[];
    request?: {
      body?: string;
      headers?: Record<string, string> | Array<[string, string]>;
      method?: string;
      path?: string;
      loading?: boolean;
    };
    workspaceKey?: string;
    streamPreview?: boolean;
  };
}

function virtualizeActionCookies(response: Response) {
  const headers = new Headers(response.headers);
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.get("set-cookie")
        ? [headers.get("set-cookie")!]
        : [];
  headers.delete("set-cookie");
  if (setCookies.length > 0) {
    headers.set(
      "x-tuto-next-virtual-set-cookie",
      Buffer.from(JSON.stringify(setCookies)).toString("base64"),
    );
  }
  headers.set(
    "access-control-expose-headers",
    "location, x-action-redirect, x-tuto-next-virtual-set-cookie, x-tuto-next-prefetch",
  );
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function OPTIONS() {
  return new Response(null, {
    headers: {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-origin": "*",
    },
    status: 204,
  });
}

export async function GET(request: Request) {
  try {
    assertNextProductionExecutionIsolated();
    const capability = resolvePreviewCapability(
      new URL(request.url).searchParams.get("preview"),
    );
    if (!capability) {
      return new Response("The preview capability is invalid or expired.", {
        headers: { "cache-control": "no-store" },
        status: 410,
      });
    }
    const [{ getNextRequestArtifact }, nextRuntime] = await Promise.all([
      import("../../../../../lib/serverless-next/artifact"),
      import("../../../../../lib/serverless-next/runtime"),
    ]);
    const artifact = getNextRequestArtifact(capability.revision);
    if (!artifact) {
      return new Response("The preview generation is no longer hot.", {
        headers: { "cache-control": "no-store" },
        status: 409,
      });
    }
    capability.navigationSession = randomBytes(16).toString("base64url");
    capability.navigationSequence = 0;
    const actionEndpoint = new URL(request.url);
    actionEndpoint.searchParams.set("navigationSession", capability.navigationSession);
    let response = await nextRuntime.executeNextRequestArtifact(artifact, {
      actionEndpoint: actionEndpoint.href,
      headers: capability.headers,
      hydrate: true,
      method: "GET",
      stream: true,
      url: capability.url,
    });
    if (
      response.body &&
      (response.headers.get("content-type") ?? "").startsWith("text/html")
    ) {
      response = new Response(injectPreviewBridgeStream(response.body), {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    }
    response.headers.set("cache-control", "no-store");
    return virtualizeActionCookies(response);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), {
      headers: { "cache-control": "no-store" },
      status: 400,
    });
  }
}

export async function POST(request: Request) {
  let isActionRequest = false;
  try {
    const executionMode = assertNextProductionExecutionIsolated();
    const { configureNextCacheAdapterFromEnvironment } =
      await import("../../../../../lib/serverless-next/durable-cache-adapter");
    configureNextCacheAdapterFromEnvironment();
    const contentType = request.headers.get("content-type") ?? "";
    if (
      contentType.startsWith("multipart/form-data") ||
      contentType.startsWith("application/x-www-form-urlencoded")
    ) {
      isActionRequest = true;
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
        throw new Error(
          "The Next runtime request exceeds the 6 MiB checkpoint limit.",
        );
      }
      const formBody = await request.arrayBuffer();
      if (formBody.byteLength > maxRequestBytes) {
        throw new Error(
          "The Next runtime request exceeds the 6 MiB checkpoint limit.",
        );
      }
      const formData = await new Request(request.url, {
        body: formBody,
        headers: { "content-type": contentType },
        method: "POST",
      }).formData();
      const revision = formData.get("$TUTO_NEXT_REVISION");
      const url = formData.get("$TUTO_NEXT_URL");
      if (typeof revision !== "string" || typeof url !== "string") {
        throw new Error(
          "The progressive Server Action form is missing its pinned generation metadata.",
        );
      }
      const routeUrl = new URL(url, "http://next.local");
      if (routeUrl.origin !== "http://next.local") {
        throw new Error(
          "The progressive Server Action URL must stay inside the workspace.",
        );
      }
      formData.delete("$TUTO_NEXT_REVISION");
      formData.delete("$TUTO_NEXT_URL");
      const [artifactModule, nextRuntime] = await Promise.all([
        import("../../../../../lib/serverless-next/artifact"),
        import("../../../../../lib/serverless-next/runtime"),
      ]);
      const artifact = artifactModule.getNextRequestArtifact(revision);
      if (!artifact) {
        return new Response(
          "The Server Action generation is no longer hot. Render the workspace again.",
          {
            headers: {
              "cache-control": "no-store",
              "content-type": "text/plain; charset=utf-8",
            },
            status: 409,
          },
        );
      }
      nextPrefetchTickets.invalidate(artifact);
      let response;
      try { response = await nextRuntime.executeNextProgressiveActionArtifact(
        artifact,
        {
          actionEndpoint: request.url,
          body: await nextRuntime.serializeNextActionBody(formData),
          headers: request.headers,
          url: `${routeUrl.pathname}${routeUrl.search}`,
        },
      ); } finally { nextPrefetchTickets.invalidate(artifact); }
      if (
        (response.headers.get("content-type") ?? "").startsWith("text/html")
      ) {
        response = new Response(injectPreviewBridge(await response.text()), {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        });
      }
      return virtualizeActionCookies(response);
    }
    const payload = await readPayload(request);
    if (payload.navigation) {
      isActionRequest = true;
      if (typeof payload.navigation.revision !== "string" || typeof payload.navigation.url !== "string") {
        throw new Error("The preview navigation request is incomplete.");
      }
      const [{ getNextRequestArtifact }, { executeNextRequestArtifact }] = await Promise.all([
        import("../../../../../lib/serverless-next/artifact"),
        import("../../../../../lib/serverless-next/runtime"),
      ]);
      const artifact = getNextRequestArtifact(payload.navigation.revision);
      if (!artifact) return new Response("The preview generation is no longer hot. Render the workspace again.", {
        headers: { "access-control-allow-origin": "*", "cache-control": "no-store" }, status: 409,
      });
      const url = new URL(payload.navigation.url, "http://next.local");
      if (url.origin !== "http://next.local") throw new Error("Preview navigation must stay inside the workspace.");
      const navigation = payload.navigation;
      const owner = navigation.prefetchOwner;
      const prefetchMode = navigation.prefetchMode ?? "full";
      if (!["auto", "full"].includes(prefetchMode)) throw new Error("Invalid preview prefetch mode.");
      const cacheKey = nextPrefetchKey(artifact.revision, navigation.url, navigation.headers ?? {}, navigation.state, prefetchMode);
      if (navigation.prefetch) {
        if (typeof owner !== "string" || owner.length > 128 || !["push", "replace"].includes(navigation.kind)) {
          throw new Error("Invalid preview prefetch request.");
        }
        // Opt-in page rendering only. Never invoke GET handlers, assets or proxy
        // middleware speculatively, or apply prefetch cookies to the document.
        if (artifact.router.proxy || matchNextRouteHandler(artifact.router, url) ||
          artifact.staticAssets[url.pathname] || !matchNextRoute(artifact.router, url)) {
          return new Response(null, {status:204, headers:{"access-control-allow-origin":"*", "cache-control":"no-store"}});
        }
        request.signal.throwIfAborted();
        const epoch = nextPrefetchTickets.epoch(artifact);
        let response: Response | undefined;
        let kind: "shell" | "full" = "full";
        if (prefetchMode === "auto") {
          const {getNextRscWorkerPool} = await import("@/lib/serverless-next/rsc-worker-pool");
          const shell = await getNextRscWorkerPool().renderPrefetchShell(artifact, url.pathname + url.search,
            [...new Headers(navigation.headers).entries()], navigation);
          if (shell.status !== 204) {
            kind = "shell";
            response = new Response(Uint8Array.from(shell.flight), {status:shell.status,
              headers:{"content-type":shell.contentType}});
          }
        }
        response ??= await executeNextRequestArtifact(artifact, {
          headers:navigation.headers, navigation, stream:true, url:url.pathname + url.search,
        });
        let body = new Uint8Array();
        if (response.body) {
          const reader = response.body.getReader();
          const abort = () => {void reader.cancel().catch(() => {});};
          request.signal.addEventListener("abort", abort, {once:true});
          const chunks: Uint8Array[] = [];
          let length = 0;
          try {
            for (;;) {
              request.signal.throwIfAborted();
              const chunk = await reader.read();
              request.signal.throwIfAborted();
              if (chunk.done) break;
              length += chunk.value.byteLength;
              if (length > nextPrefetchTickets.maxEntryBytes) break;
              chunks.push(chunk.value);
            }
          } finally { request.signal.removeEventListener("abort", abort); await reader.cancel(); }
          if (length <= nextPrefetchTickets.maxEntryBytes) {
            body = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {body.set(chunk, offset); offset += chunk.byteLength;}
          }
        }
        const text = new TextDecoder().decode(body);
        const ticket = response.status === 200 && body.length &&
          response.headers.get("content-type")?.startsWith("text/x-component") &&
          !response.headers.has("set-cookie") && !response.headers.has("location") &&
          !/(?:^|\n)[0-9a-f]+:E\{/.test(text)
          ? nextPrefetchTickets.put({artifact, owner, key:cacheKey, epoch, body, kind,
            headers:[...response.headers.entries()], status:response.status}) : null;
        return ticket ? Response.json({ticket, kind, ttlMs:nextPrefetchTickets.ttlMs}, {
          headers:{"access-control-allow-origin":"*", "cache-control":"no-store"},
        }) : new Response(null, {status:204, headers:{"access-control-allow-origin":"*", "cache-control":"no-store"}});
      }
      if (navigation.kind === "refresh") nextPrefetchTickets.invalidate(artifact);
      const cached = typeof navigation.prefetchTicket === "string" && typeof owner === "string" &&
        ["push", "replace"].includes(navigation.kind)
        ? nextPrefetchTickets.take(navigation.prefetchTicket, artifact, owner, cacheKey) : null;
      // Validate the shell before display. This provisional response must not
      // advance the reload capability, apply cookies or replace fresh page work.
      if (navigation.prefetchShell === true) {
        return cached?.kind === "shell"
          ? new Response(Uint8Array.from(cached.body), {status:cached.status, headers:{
              ...Object.fromEntries(cached.headers), "access-control-allow-origin":"*", "cache-control":"no-store",
              "x-tuto-next-prefetch":"shell-hit",
              "access-control-expose-headers":"x-tuto-next-prefetch",
            }})
          : new Response(null, {status:204, headers:{"access-control-allow-origin":"*", "cache-control":"no-store", "x-tuto-next-prefetch":"miss", "access-control-expose-headers":"x-tuto-next-prefetch"}});
      }
      let response: Response;
      try {
        response = cached && cached.kind !== "shell" ? new Response(Uint8Array.from(cached.body), {headers:cached.headers, status:cached.status})
          : await executeNextRequestArtifact(artifact, {
            headers:navigation.headers, navigation, stream:true, url:url.pathname + url.search,
          });
      } finally { if (navigation.kind === "refresh") nextPrefetchTickets.invalidate(artifact); }
      response.headers.set("x-tuto-next-prefetch", cached && cached.kind !== "shell" ? "hit" : "miss");
      const token = new URL(request.url).searchParams.get("preview");
      const capability = resolvePreviewCapability(token);
      const sequence = payload.navigation.sequence;
      if (capability?.revision === artifact.revision &&
          capability.navigationSession === new URL(request.url).searchParams.get("navigationSession") && Number.isSafeInteger(sequence) &&
          sequence! > (capability.navigationSequence ?? 0) &&
          (response.headers.get("content-type") ?? "").startsWith("text/x-component")) {
        // Native iframe reloads must hard-render the current virtual URL, without soft slot history.
        capability.url = url.pathname + url.search;
        capability.headers = [...new Headers(payload.navigation.headers).entries()];
        capability.navigationSequence = sequence;
      }
      response.headers.set("access-control-allow-origin", "*");
      response.headers.set("cache-control", "no-store");
      const streamed = response.body ? new Response(response.body.pipeThrough(new TransformStream(), {signal:request.signal}), {
        headers:response.headers, status:response.status, statusText:response.statusText,
      }) : response;
      return virtualizeActionCookies(streamed);
    }
    if (payload.action) {
      isActionRequest = true;
      const [{ getNextRequestArtifact }, { executeNextServerActionArtifact }] =
        await Promise.all([
          import("../../../../../lib/serverless-next/artifact"),
          import("../../../../../lib/serverless-next/runtime"),
        ]);
      if (
        !payload.action.actionId ||
        !payload.action.revision ||
        !payload.action.body ||
        typeof payload.action.url !== "string"
      ) {
        throw new Error("The Server Action request is incomplete.");
      }
      const artifact = getNextRequestArtifact(payload.action.revision);
      if (!artifact) {
        return new Response(
          "The Server Action generation is no longer hot. Render the workspace again.",
          {
            headers: {
              "access-control-allow-origin": "*",
              "cache-control": "no-store",
              "content-type": "text/plain; charset=utf-8",
            },
            status: 409,
          },
        );
      }
      nextPrefetchTickets.invalidate(artifact);
      try { return virtualizeActionCookies(
        await executeNextServerActionArtifact(artifact, {
          actionId: payload.action.actionId,
          body: payload.action.body as Parameters<
            typeof executeNextServerActionArtifact
          >[1]["body"],
          headers: payload.action.headers,
          url: payload.action.url,
        }),
      ); } finally { nextPrefetchTickets.invalidate(artifact); }
    }
    const method = (payload.request?.method ?? "GET").toUpperCase();
    const pathname = payload.request?.path ?? "/";
    const routeUrl = new URL(pathname, "http://next.local");
    if (routeUrl.origin !== "http://next.local") {
      throw new Error(
        "The Next request path must be relative to the workspace.",
      );
    }

    const startedAt = performance.now();
    const [compiler, nextRuntime, routeManifest] = await Promise.all([
      import("../../../../../lib/serverless-next/compiler"),
      import("../../../../../lib/serverless-next/runtime"),
      import("../../../../../lib/serverless-next/route-manifest"),
    ]);
    const { artifact, artifactCache } =
      await compiler.compileNextRequestWorkspaceWithStatus(
        payload.files ?? [],
        {
          serverReferenceHashSalt: serverReferenceHashSalt(),
          workspaceKey: payload.workspaceKey ?? "next-request-workspace",
        },
      );
    const url = `${routeUrl.pathname}${routeUrl.search}`;
    const directHandler = routeManifest.matchNextRouteHandler(
      artifact.router,
      routeUrl,
    );
    const directAsset = artifact.staticAssets[routeUrl.pathname];
    const streamPreview =
      payload.streamPreview === true &&
      method === "GET" &&
      !payload.request?.loading &&
      !directAsset;
    const response = streamPreview
      ? new Response("Preview body is delivered by the streaming URL.", {
          headers: {
            "cache-control": "private, no-store",
            "content-type": directHandler
              ? "application/octet-stream"
              : "text/html; charset=utf-8",
            "x-tuto-next-cache": "streaming-preview",
            "x-tuto-next-generation": artifact.generation,
            "x-tuto-next-proxy": artifact.router.proxy
              ? "deferred-to-stream"
              : "absent",
            "x-tuto-next-runtime-kind": directHandler
              ? "route-handler"
              : "page",
          },
        })
      : await nextRuntime.executeNextRequestArtifact(artifact, {
          actionEndpoint: request.url,
          body: payload.request?.body,
          headers: payload.request?.headers,
          hydrate: true,
          loading: payload.request?.loading,
          method,
          url,
        });
    const responseBody = await response.text();
    const body =
      !streamPreview &&
      (response.headers.get("x-tuto-next-runtime-kind") === "page" ||
        response.headers.get("x-tuto-next-runtime-kind") === "page-loading")
        ? injectPreviewBridge(responseBody)
        : responseBody;
    const runtimeKind = response.headers.get("x-tuto-next-runtime-kind");
    const previewUrl =
      method === "GET" &&
      (runtimeKind === "page" || runtimeKind === "route-handler")
        ? `${new URL(request.url).pathname}?preview=${encodeURIComponent(
            issuePreviewCapability({
              headers: [...new Headers(payload.request?.headers).entries()],
              revision: artifact.revision,
              url,
            }),
          )}`
        : undefined;
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const parallelBranches = artifact.router.parallelRoutes.reduce(
      (count, slot) => count + slot.routes.length + (slot.default ? 1 : 0),
      0,
    );

    return NextResponse.json(
      {
        success: true,
        diagnostics: [],
        durationMs,
        logs: [
          {
            id: crypto.randomUUID(),
            level: "info",
            message:
              artifactCache === "hot"
                ? `Reused generation ${artifact.generation} from the hot artifact cache in ${durationMs}ms.`
                : `Compiled generation ${artifact.generation} with Next ${artifact.nextVersion} SWC in ${artifact.buildMetrics.durationMs}ms; request completed in ${durationMs}ms.`,
            timestamp: new Date().toISOString(),
          },
          {
            id: crypto.randomUUID(),
            level: "info",
            message: `Transforms: server ${artifact.buildMetrics.serverTransforms} (${artifact.buildMetrics.serverTransformCacheHits} cached), browser ${artifact.buildMetrics.browserTransforms} (${artifact.buildMetrics.browserTransformCacheHits} cached). Shared kernel ${artifact.kernelId}.`,
            timestamp: new Date().toISOString(),
          },
          {
            id: crypto.randomUUID(),
            level: "info",
            message: `Router: ${artifact.router.routes.length} canonical page route(s), ${parallelBranches} parallel branch(es), ${artifact.router.interceptions.length} interception(s), ${artifact.router.handlers.length} Route Handler(s), ${Object.values(artifact.actionManifest).filter((reference) => reference.kind === "action").length} Server Action reference(s), ${Object.values(artifact.actionManifest).filter((reference) => reference.kind === "cache").length} Cache Component reference(s), ${Object.keys(artifact.styles).length} stylesheet(s), ${Object.keys(artifact.staticAssets).length} public asset(s). Matched ${response.headers.get("x-tuto-next-route-pattern") ?? "404"}.`,
            timestamp: new Date().toISOString(),
          },
          {
            id: crypto.randomUUID(),
            level: "info",
            message: `Execution: ${executionMode === "secure-exec" ? "SecureExec V8 isolate" : "trusted local Node child process"}.`,
            timestamp: new Date().toISOString(),
          },
          {
            id: crypto.randomUUID(),
            level: "info",
            message: `Data cache: ${response.headers.get("x-tuto-next-cache") ?? "no cache operations"}.`,
            timestamp: new Date().toISOString(),
          },
          {
            id: crypto.randomUUID(),
            level: "info",
            message: `Proxy: ${response.headers.get("x-tuto-next-proxy") ?? "absent"}. Runtime result: ${response.headers.get("x-tuto-next-runtime-kind") ?? "unknown"}.`,
            timestamp: new Date().toISOString(),
          },
        ],
        response: {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
          contentType:
            response.headers.get("content-type") ?? "text/html; charset=utf-8",
          previewUrl,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to execute the request-compiled Next workspace.";
    if (isActionRequest) {
      return new Response(message, {
        headers: {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        },
        status: 400,
      });
    }
    return NextResponse.json(
      {
        success: false,
        diagnostics: [diagnostic(message)],
        logs: [],
        response: null,
        error: message,
      },
      { headers: { "cache-control": "no-store" }, status: 400 },
    );
  }
}
