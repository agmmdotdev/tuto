import { resolveArtifactRequest } from "../../../../../lib/serverless-tanstack-start/artifact-request";
import type { NativeRpcRequest } from "../../../../../lib/serverless-tanstack-start/native-rpc-protocol";
import { getNativeRpcWorkerPool } from "../../../../../lib/serverless-tanstack-start/native-rpc-worker-pool";

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

function resolveTargetUrl(requestUrl: URL) {
  const targetPath = requestUrl.searchParams.get("path") ?? "/";
  if (
    !targetPath.startsWith("/") ||
    targetPath.startsWith("//") ||
    targetPath.length > 2_048
  ) {
    return null;
  }

  const targetUrl = new URL(targetPath, requestUrl.origin);
  return targetUrl.origin === requestUrl.origin ? targetUrl : null;
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const targetUrl = resolveTargetUrl(requestUrl);
  if (!targetUrl) {
    return new Response("Invalid preview document path.", {
      headers: { "cache-control": "no-store" },
      status: 400,
    });
  }

  const resolution = await resolveArtifactRequest(request);
  if (!resolution.ok) {
    return new Response(resolution.message, {
      headers: { "cache-control": "no-store" },
      status: resolution.status,
    });
  }
  if (!resolution.artifact.serverBundle) {
    return new Response("This revision does not contain a server router.", {
      headers: { "cache-control": "no-store" },
      status: 422,
    });
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("accept", "text/html");
  requestHeaders.set("origin", targetUrl.origin);
  requestHeaders.set("sec-fetch-site", "same-origin");
  const nativeRequest: NativeRpcRequest = {
    headers: [...requestHeaders.entries()],
    method: "GET",
    url: targetUrl.toString(),
  };
  const execution = await getNativeRpcWorkerPool().execute(
    {
      kernelId: resolution.artifact.kernelId,
      revision: resolution.artifact.revision,
      serverBundle: resolution.artifact.serverBundle,
    },
    nativeRequest,
  );
  const result = execution.result;
  const headers = new Headers(result.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-tuto-artifact-cache", resolution.artifactCache);
  headers.set("x-tuto-worker-id", execution.workerId);
  headers.set("x-tuto-worker-request", String(execution.workerRequest));
  headers.set("x-tuto-worker-reused", String(execution.workerReused));
  headers.delete("content-length");
  const resultBody = Buffer.from(result.bodyBase64, "base64");
  const body = headers.get("content-type")?.includes("text/html")
    ? Buffer.from(
        resultBody
          .toString("utf8")
          .replace("</body>", `${previewBridgeScript}</body>`),
      )
    : resultBody;

  return new Response(body, {
    headers,
    status: result.status,
    statusText: result.statusText,
  });
}
