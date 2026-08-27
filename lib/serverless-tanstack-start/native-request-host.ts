import { resolveArtifactServerRequest } from "./artifact-request";
import type { NativeRpcRequest } from "./native-rpc-protocol";
import { getNativeRpcWorkerPool } from "./native-rpc-worker-pool";

const maxRequestBytes = 1_250_000;

async function readRequestBody(request: Request) {
  if (!request.body) return { body: undefined, tooLarge: false } as const;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxRequestBytes) {
        await reader.cancel("Preview request body is too large.");
        return { body: undefined, tooLarge: true } as const;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return {
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    tooLarge: false,
  } as const;
}

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

function rewriteSameOriginRedirect(
  headers: Headers,
  requestUrl: URL,
  targetUrl: URL,
) {
  const location = headers.get("location");
  if (!location) return;

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(location, targetUrl);
  } catch {
    return;
  }
  if (redirectUrl.origin !== targetUrl.origin) return;

  const gatewayUrl = new URL(requestUrl);
  gatewayUrl.searchParams.set(
    "path",
    `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`,
  );
  headers.set(
    "location",
    `${gatewayUrl.pathname}${gatewayUrl.search}${gatewayUrl.hash}`,
  );
}

export async function executeNativeArtifactRequest(
  request: Request,
  options: { acceptHtml?: boolean } = {},
) {
  const requestUrl = new URL(request.url);
  const targetUrl = resolveTargetUrl(requestUrl);
  if (!targetUrl) {
    return new Response("Invalid preview request path.", {
      headers: { "cache-control": "no-store" },
      status: 400,
    });
  }

  const resolution = await resolveArtifactServerRequest(request);
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

  const method = request.method.toUpperCase();
  const bodyResult =
    method === "GET" || method === "HEAD"
      ? ({ body: undefined, tooLarge: false } as const)
      : await readRequestBody(request);
  if (bodyResult.tooLarge) {
    return new Response("Preview request body is too large.", {
      headers: { "cache-control": "no-store" },
      status: 413,
    });
  }

  const requestHeaders = new Headers(request.headers);
  if (options.acceptHtml) requestHeaders.set("accept", "text/html");
  requestHeaders.set("origin", targetUrl.origin);
  requestHeaders.set("sec-fetch-site", "same-origin");
  requestHeaders.delete("content-length");
  const nativeRequest: NativeRpcRequest = {
    ...(bodyResult.body
      ? { bodyBase64: bodyResult.body.toString("base64") }
      : {}),
    headers: [...requestHeaders.entries()],
    method,
    url: targetUrl.toString(),
  };
  let execution;
  try {
    execution = await getNativeRpcWorkerPool().executeStream(
      {
        kernelId: resolution.artifact.kernelId,
        revision: resolution.artifact.revision,
        serverBundle: resolution.artifact.serverBundle,
        serverChunks: resolution.artifact.serverChunks,
      },
      nativeRequest,
    );
  } catch (error) {
    return new Response(
      error instanceof Error
        ? `Preview request failed: ${error.message}`
        : "Preview request failed.",
      { headers: { "cache-control": "no-store" }, status: 500 },
    );
  }
  const headers = new Headers(execution.response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-tuto-artifact-cache", resolution.artifactCache);
  headers.set("x-tuto-worker-id", execution.workerId);
  headers.set("x-tuto-worker-request", String(execution.workerRequest));
  headers.set("x-tuto-worker-reused", String(execution.workerReused));
  headers.delete("content-length");
  rewriteSameOriginRedirect(headers, requestUrl, targetUrl);

  return new Response(execution.body, {
    headers,
    status: execution.response.status,
    statusText: execution.response.statusText,
  });
}
