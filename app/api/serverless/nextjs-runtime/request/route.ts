import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import type { BuildDiagnostic, WorkspaceFile } from "@/lib/ide/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const saltKey = Symbol.for("tuto.serverless-next.action-salt.v1");
const maxRequestBytes = 6 * 1024 * 1024;
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
      revision?: string;
      url?: string;
    };
    files?: WorkspaceFile[];
    request?: {
      body?: string;
      headers?: Record<string, string> | Array<[string, string]>;
      method?: string;
      path?: string;
    };
    workspaceKey?: string;
  };
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

export async function POST(request: Request) {
  let isActionRequest = false;
  try {
    if (
      process.env.VERCEL === "1" &&
      process.env.TUTO_NEXT_REQUEST_RUNTIME_ENABLED !== "1"
    ) {
      throw new Error(
        "The request-compiled Next checkpoint is disabled in production until student execution is behind Tuto's isolation boundary.",
      );
    }
    const payload = await readPayload(request);
    if (payload.action) {
      isActionRequest = true;
      const [{ getNextRequestArtifact }, { invokeNextServerAction }] =
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
      return invokeNextServerAction(artifact, {
        actionId: payload.action.actionId,
        body: payload.action.body as Parameters<
          typeof invokeNextServerAction
        >[1]["body"],
        url: payload.action.url,
      });
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
    const matchedHandler = routeManifest.matchNextRouteHandler(
      artifact.router,
      routeUrl,
    );
    if (!matchedHandler && method !== "GET") {
      throw new Error(
        "App Router page requests currently use GET. Use app/**/route.ts for other HTTP methods.",
      );
    }
    const response = matchedHandler
      ? await nextRuntime.invokeNextRouteHandler(artifact, {
          body: payload.request?.body,
          headers: payload.request?.headers,
          method,
          url,
        })
      : await nextRuntime.renderHydratableNextRequestArtifact(artifact, {
          actionEndpoint: request.url,
          url,
        });
    const responseBody = await response.text();
    const body = matchedHandler
      ? responseBody
      : injectPreviewBridge(responseBody);
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;

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
            message: `Router: ${artifact.router.routes.length} page route(s), ${artifact.router.handlers.length} Route Handler(s), ${Object.values(artifact.actionManifest).filter((reference) => reference.kind === "action").length} Server Action reference(s), ${Object.values(artifact.actionManifest).filter((reference) => reference.kind === "cache").length} Cache Component reference(s). Matched ${response.headers.get("x-tuto-next-route-pattern") ?? "404"}.`,
            timestamp: new Date().toISOString(),
          },
          {
            id: crypto.randomUUID(),
            level: "info",
            message: `Data cache: ${response.headers.get("x-tuto-next-cache") ?? "no cache operations"}.`,
            timestamp: new Date().toISOString(),
          },
        ],
        response: {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
          contentType:
            response.headers.get("content-type") ?? "text/html; charset=utf-8",
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
