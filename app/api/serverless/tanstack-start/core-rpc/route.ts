import { resolveArtifactServerRequest } from "../../../../../lib/serverless-tanstack-start/artifact-request";
import type { NativeRpcRequest } from "../../../../../lib/serverless-tanstack-start/native-rpc-protocol";
import { getNativeRpcWorkerPool } from "../../../../../lib/serverless-tanstack-start/native-rpc-worker-pool";
import { ServerRuntimeSourceError } from "../../../../../lib/serverless-tanstack-start/server-runtime-store";

export const runtime = "nodejs";

const maxRequestBytes = 1_250_000;
const diagnosticHeaders = [
  "x-tuto-artifact-cache",
  "x-tuto-worker-id",
  "x-tuto-worker-request",
  "x-tuto-worker-reused",
];

function corsHeadersFor(request: Request) {
  const origin = request.headers.get("origin");
  const requestedHeaders = request.headers.get(
    "access-control-request-headers",
  );

  return {
    ...(origin ? { "access-control-allow-credentials": "true" } : {}),
    "access-control-allow-headers":
      requestedHeaders ?? "content-type,x-tsr-serverfn",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-origin": origin ?? "*",
    "access-control-expose-headers": diagnosticHeaders.join(","),
    "cache-control": "no-store",
    vary: "Origin, Access-Control-Request-Headers",
  };
}

async function handleNativeRpc(request: Request) {
  const corsHeaders = corsHeadersFor(request);

  try {
    const url = new URL(request.url);
    const revision = url.searchParams.get("revision");
    const serverFnId = url.searchParams.get("id");

    if (!revision || !/^[a-f0-9]{64}$/.test(revision) || !serverFnId) {
      return new Response(
        "Both revision and server function id are required.",
        {
          headers: corsHeaders,
          status: 400,
        },
      );
    }

    const resolution = await resolveArtifactServerRequest(request);
    if (!resolution.ok) {
      return new Response(resolution.message, {
        headers: corsHeaders,
        status: resolution.status,
      });
    }
    const { artifact, artifactCache } = resolution;
    if (!artifact.serverFnIds.includes(serverFnId)) {
      return new Response("Unknown server function for this revision.", {
        headers: corsHeaders,
        status: 404,
      });
    }

    const requestBody =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : Buffer.from(await request.arrayBuffer());
    if (requestBody && requestBody.byteLength > maxRequestBytes) {
      return new Response("Server function request is too large.", {
        headers: corsHeaders,
        status: 413,
      });
    }
    const body = requestBody?.toString("base64");
    const nativeHeaders = new Headers(request.headers);
    const forwardedOrigin = nativeHeaders.get("origin");
    if (forwardedOrigin)
      nativeHeaders.set("x-tuto-forwarded-origin", forwardedOrigin);
    nativeHeaders.set("origin", url.origin);
    nativeHeaders.set("sec-fetch-site", "same-origin");
    const nativeRequest: NativeRpcRequest = {
      ...(body ? { bodyBase64: body } : {}),
      headers: [...nativeHeaders.entries()],
      method: request.method,
      serverFnId,
      url: request.url,
    };
    const execution = await getNativeRpcWorkerPool().execute(
      resolution.runtime,
      nativeRequest,
    );
    const result = execution.result;
    const headers = new Headers(result.headers);
    const responseVary = headers.get("vary");
    for (const [name, value] of Object.entries(corsHeaders)) {
      if (name === "vary") continue;
      headers.set(name, value);
    }
    headers.set(
      "vary",
      [responseVary, corsHeaders.vary].filter(Boolean).join(", "),
    );
    headers.set(
      "access-control-expose-headers",
      [
        ...diagnosticHeaders,
        ...[...headers.keys()].filter(
          (name) =>
            name !== "set-cookie" && !name.startsWith("access-control-"),
        ),
      ]
        .filter((name, index, names) => names.indexOf(name) === index)
        .join(","),
    );
    headers.set("x-tuto-artifact-cache", artifactCache);
    headers.set("x-tuto-worker-id", execution.workerId);
    headers.set("x-tuto-worker-request", String(execution.workerRequest));
    headers.set("x-tuto-worker-reused", String(execution.workerReused));
    headers.delete("content-length");

    return new Response(Buffer.from(result.bodyBase64, "base64"), {
      headers,
      status: result.status,
      statusText: result.statusText,
    });
  } catch (error) {
    const unavailable = error instanceof ServerRuntimeSourceError;
    return new Response(
      error instanceof Error
        ? unavailable
          ? `Shared artifact storage is unavailable: ${error.message}`
          : error.message
        : "Unable to execute TanStack server function.",
      { headers: corsHeaders, status: unavailable ? 503 : 500 },
    );
  }
}

export const GET = handleNativeRpc;
export const POST = handleNativeRpc;

export function OPTIONS(request: Request) {
  return new Response(null, { headers: corsHeadersFor(request), status: 204 });
}
