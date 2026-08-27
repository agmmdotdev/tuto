import { timingSafeEqual } from "node:crypto";
import {
  getTanstackStartArtifact,
  putTanstackStartArtifact,
  type TanstackStartArtifact,
} from "./artifact-cache";
import { getDurableTanstackStartArtifact } from "./artifact-store";

export type ArtifactRequestResolution =
  | {
      artifact: TanstackStartArtifact;
      artifactCache: "durable" | "hot";
      ok: true;
    }
  | {
      message: string;
      ok: false;
      status: number;
    };

function matchesRpcToken(actual: string | null, expected: string) {
  if (!actual || !/^[A-Za-z0-9_-]{43}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export async function resolveArtifactRequest(
  request: Request,
): Promise<ArtifactRequestResolution> {
  const url = new URL(request.url);
  const revision = url.searchParams.get("revision");

  if (!revision || !/^[a-f0-9]{64}$/.test(revision)) {
    return {
      message: "A valid compiled revision is required.",
      ok: false,
      status: 400,
    };
  }

  let artifact = getTanstackStartArtifact(revision);
  let artifactCache: "durable" | "hot" = "hot";
  if (!artifact) {
    try {
      artifact = await getDurableTanstackStartArtifact(revision);
    } catch (error) {
      return {
        message:
          error instanceof Error
            ? `Shared artifact storage is unavailable: ${error.message}`
            : "Shared artifact storage is unavailable.",
        ok: false,
        status: 503,
      };
    }
    if (artifact) {
      artifactCache = "durable";
      putTanstackStartArtifact(artifact);
    }
  }
  if (!artifact) {
    return {
      message:
        "This compiled revision is no longer available. Save or rebuild the preview and retry.",
      ok: false,
      status: 410,
    };
  }
  if (!matchesRpcToken(url.searchParams.get("token"), artifact.rpcToken)) {
    return {
      message: "Invalid preview RPC capability.",
      ok: false,
      status: 403,
    };
  }

  return { artifact, artifactCache, ok: true };
}
