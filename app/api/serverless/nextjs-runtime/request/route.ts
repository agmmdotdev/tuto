import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import type { BuildDiagnostic, WorkspaceFile } from "@/lib/ide/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const saltKey = Symbol.for("tuto.serverless-next.action-salt.v1");
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

export async function POST(request: Request) {
  try {
    if (
      process.env.VERCEL === "1" &&
      process.env.TUTO_NEXT_REQUEST_RUNTIME_ENABLED !== "1"
    ) {
      throw new Error(
        "The request-compiled Next checkpoint is disabled in production until student execution is behind Tuto's isolation boundary.",
      );
    }
    const payload = (await request.json()) as {
      files?: WorkspaceFile[];
      request?: { method?: string; path?: string };
      workspaceKey?: string;
    };
    const method = (payload.request?.method ?? "GET").toUpperCase();
    const pathname = payload.request?.path ?? "/";
    if (method !== "GET" || pathname !== "/") {
      throw new Error(
        "This checkpoint currently executes GET /. Nested routes, Route Handlers, and mutations are the next compatibility slices.",
      );
    }

    const startedAt = performance.now();
    const [
      { compileNextRequestWorkspaceWithStatus },
      { renderHydratableNextRequestArtifact },
    ] = await Promise.all([
      import("@/lib/serverless-next/compiler"),
      import("@/lib/serverless-next/runtime"),
    ]);
    const { artifact, artifactCache } =
      await compileNextRequestWorkspaceWithStatus(payload.files ?? [], {
        serverReferenceHashSalt: serverReferenceHashSalt(),
        workspaceKey: payload.workspaceKey ?? "next-request-workspace",
      });
    const response = await renderHydratableNextRequestArtifact(artifact);
    const body = injectPreviewBridge(await response.text());
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
