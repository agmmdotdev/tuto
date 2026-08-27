import {
  getTanstackStartArtifact,
  putTanstackStartArtifact,
} from "../../../../../lib/serverless-tanstack-start/artifact-cache";
import { getDurableTanstackStartArtifact } from "../../../../../lib/serverless-tanstack-start/artifact-store";
import type { NativeRpcRequest } from "../../../../../lib/serverless-tanstack-start/native-rpc-protocol";
import { getNativeRpcWorkerPool } from "../../../../../lib/serverless-tanstack-start/native-rpc-worker-pool";

export const runtime = "nodejs";

const maxRequestBytes = 1_250_000;
const corsHeaders = {
  "access-control-allow-headers": "content-type,x-tsr-serverfn",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-origin": "*",
  "access-control-expose-headers":
    "x-tuto-artifact-cache,x-tuto-worker-id,x-tuto-worker-request,x-tuto-worker-reused",
  "cache-control": "no-store",
};

async function handleNativeRpc(request: Request) {
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

    let artifact = getTanstackStartArtifact(revision);
    let artifactCache = "hot";
    if (!artifact) {
      try {
        artifact = await getDurableTanstackStartArtifact(revision);
      } catch (error) {
        return new Response(
          error instanceof Error
            ? `Shared artifact storage is unavailable: ${error.message}`
            : "Shared artifact storage is unavailable.",
          { headers: corsHeaders, status: 503 },
        );
      }
      if (artifact) {
        artifactCache = "durable";
        putTanstackStartArtifact(artifact);
      }
    }
    if (!artifact) {
      return new Response(
        "This compiled revision is no longer available. Save or rebuild the preview and retry.",
        { headers: corsHeaders, status: 410 },
      );
    }
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
    const nativeRequest: NativeRpcRequest = {
      ...(body ? { bodyBase64: body } : {}),
      headers: [...request.headers.entries()],
      method: request.method,
      url: request.url,
    };
    const execution = await getNativeRpcWorkerPool().execute(
      {
        kernelId: artifact.kernelId,
        revision: artifact.revision,
        serverBundle: artifact.serverBundle,
      },
      nativeRequest,
    );
    const result = execution.result;
    const headers = new Headers(result.headers);
    for (const [name, value] of Object.entries(corsHeaders))
      headers.set(name, value);
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
    return new Response(
      error instanceof Error
        ? error.message
        : "Unable to execute TanStack server function.",
      { headers: corsHeaders, status: 500 },
    );
  }
}

export const GET = handleNativeRpc;
export const POST = handleNativeRpc;

export function OPTIONS() {
  return new Response(null, { headers: corsHeaders, status: 204 });
}
