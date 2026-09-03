import { randomBytes } from "node:crypto";
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
    ? html.replace("</body>", `${previewBridgeScript}</body>`)
    : `${html}${previewBridgeScript}`;
}

type PreviewCapability = {
  expiresAt: number;
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
    "location, x-action-redirect, x-tuto-next-virtual-set-cookie",
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
    let response = await nextRuntime.executeNextRequestArtifact(artifact, {
      actionEndpoint: request.url,
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
      let response = await nextRuntime.executeNextProgressiveActionArtifact(
        artifact,
        {
          actionEndpoint: request.url,
          body: await nextRuntime.serializeNextActionBody(formData),
          headers: request.headers,
          url: `${routeUrl.pathname}${routeUrl.search}`,
        },
      );
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
      return virtualizeActionCookies(
        await executeNextServerActionArtifact(artifact, {
          actionId: payload.action.actionId,
          body: payload.action.body as Parameters<
            typeof executeNextServerActionArtifact
          >[1]["body"],
          headers: payload.action.headers,
          url: payload.action.url,
        }),
      );
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
