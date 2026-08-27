import { resolveArtifactRequest } from "../../../../../lib/serverless-tanstack-start/artifact-request";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const resolution = await resolveArtifactRequest(request);
  if (!resolution.ok) {
    return new Response(resolution.message, {
      headers: { "cache-control": "no-store" },
      status: resolution.status,
    });
  }

  const kind = new URL(request.url).searchParams.get("kind");
  const requestedChunk = new URL(request.url).searchParams
    .get("name")
    ?.replace(/^\/+/, "");
  const body =
    kind === "client"
      ? resolution.artifact.ssrClientBundle
      : kind === "style"
        ? resolution.artifact.ssrCss
        : kind === "chunk" && requestedChunk
          ? (resolution.artifact.ssrClientChunks[requestedChunk] ?? null)
          : null;
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
