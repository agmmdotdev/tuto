import { after } from "next/server";
import { executeNativeArtifactRequest } from "../../../../../lib/serverless-tanstack-start/native-request-host";
import { resolveArtifactDocumentRequest } from "../../../../../lib/serverless-tanstack-start/artifact-request";
import { resolveIncrementalStaticRegeneration } from "../../../../../lib/serverless-tanstack-start/isr-runtime";

export const runtime = "nodejs";

const previewBridgeScript = `<script>
(() => {
  const source = "tuto-serverless-preview-log";
  const text = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const send = (level, args) => parent?.postMessage({
    source,
    level,
    message: args.map(text).join(" "),
    timestamp: new Date().toISOString(),
  }, "*");
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level];
    console[level] = (...args) => {
      send(level, args);
      return original.apply(console, args);
    };
  }
  addEventListener("error", (event) => send("error", [event.message]));
  addEventListener("unhandledrejection", (event) => send("error", [event.reason]));
})();
</script>`;

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const targetPath = requestUrl.searchParams.get("path") ?? "/";
  const prerendered = await resolveArtifactDocumentRequest(request, targetPath);
  let response: Response;
  if (!prerendered.ok) {
    response = new Response(prerendered.message, {
      headers: { "cache-control": "no-store" },
      status: prerendered.status,
    });
  } else if (prerendered.body !== null) {
    const isr =
      prerendered.kind === "route" && prerendered.outputPath
        ? await resolveIncrementalStaticRegeneration(
            request,
            {
              ...prerendered,
              body: prerendered.body,
              kind: "route",
              outputPath: prerendered.outputPath,
            },
            {
              schedule(operation) {
                try {
                  after(operation);
                } catch {
                  queueMicrotask(() =>
                    void operation().catch(() => undefined),
                  );
                }
              },
            },
          )
        : null;
    const headers = new Headers({
      "cache-control":
        isr?.cacheControl ?? "private, max-age=31536000, immutable",
      "content-type": "text/html; charset=utf-8",
      "x-tuto-artifact-cache": prerendered.artifactCache,
      "x-tuto-prerender-kind": prerendered.kind ?? "route",
      "x-tuto-prerender-output": prerendered.outputPath ?? "",
    });
    if (isr) {
      headers.set("x-tuto-isr-generated-at", String(isr.generatedAt));
      headers.set("x-tuto-isr-status", isr.status);
    }
    response = new Response(isr?.body ?? prerendered.body, { headers });
  } else {
    response = await executeNativeArtifactRequest(request, {
      acceptHtml: true,
      shell: requestUrl.searchParams.get("shell") === "true",
    });
  }
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/html")
  ) {
    return response;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let tail = "";
  let injected = false;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush(controller) {
        tail += decoder.decode();
        controller.enqueue(
          encoder.encode(
            injected
              ? tail
              : tail.replace("</body>", `${previewBridgeScript}</body>`),
          ),
        );
      },
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });
        if (injected) {
          controller.enqueue(encoder.encode(text));
          return;
        }

        tail += text;
        const bodyIndex = tail.indexOf("</body>");
        if (bodyIndex >= 0) {
          controller.enqueue(
            encoder.encode(
              `${tail.slice(0, bodyIndex)}${previewBridgeScript}${tail.slice(bodyIndex)}`,
            ),
          );
          tail = "";
          injected = true;
          return;
        }

        const safeLength = Math.max(0, tail.length - "</body>".length + 1);
        if (safeLength > 0) {
          controller.enqueue(encoder.encode(tail.slice(0, safeLength)));
          tail = tail.slice(safeLength);
        }
      },
    }),
  );

  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}
