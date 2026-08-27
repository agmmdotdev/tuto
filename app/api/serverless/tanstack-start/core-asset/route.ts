import { resolveArtifactAssetRequest } from "../../../../../lib/serverless-tanstack-start/artifact-request";
import type { TanstackStartArtifactAsset } from "../../../../../lib/serverless-tanstack-start/artifact-store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const kind = new URL(request.url).searchParams.get("kind");
  const requestedChunk = new URL(request.url).searchParams
    .get("name")
    ?.replace(/^\/+/, "");
  const asset: TanstackStartArtifactAsset | null =
    kind === "client"
      ? { kind: "client" }
      : kind === "style"
        ? requestedChunk
          ? { kind: "style-chunk", name: requestedChunk }
          : { kind: "style" }
        : kind === "chunk" && requestedChunk
          ? { kind: "client-chunk", name: requestedChunk }
          : null;
  if (!asset) {
    return new Response("Unknown preview asset.", {
      headers: { "cache-control": "no-store" },
      status: 404,
    });
  }
  const resolution = await resolveArtifactAssetRequest(request, asset);
  if (!resolution.ok) {
    return new Response(resolution.message, {
      headers: { "cache-control": "no-store" },
      status: resolution.status,
    });
  }
  const { body } = resolution;
  if (body === null) {
    return new Response("Unknown preview asset.", {
      headers: { "cache-control": "no-store" },
      status: 404,
    });
  }
  if (!body) {
    return new Response("Preview asset is unavailable.", {
      headers: { "cache-control": "no-store" },
      status: 404,
    });
  }

  return new Response(body, {
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "private, no-store",
      "content-type":
        kind === "client" || kind === "chunk"
          ? "text/javascript; charset=utf-8"
          : "text/css; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
