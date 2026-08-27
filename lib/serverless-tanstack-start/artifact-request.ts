import { timingSafeEqual } from "node:crypto";
import {
  getTanstackStartArtifact,
  putTanstackStartArtifact,
  type TanstackStartArtifact,
} from "./artifact-cache";
import {
  getDurableTanstackStartArtifact,
  getDurableTanstackStartArtifactAsset,
  getDurableTanstackStartArtifactMetadata,
  getDurableTanstackStartServerArtifact,
  getTanstackStartArtifactMetadata,
  type TanstackStartArtifactAsset,
  type TanstackStartArtifactAssetResult,
  type TanstackStartArtifactMetadata,
  type TanstackStartArtifactServerResult,
} from "./artifact-store";

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

export type ArtifactAssetRequestResolution =
  | {
      artifact: TanstackStartArtifactMetadata;
      artifactCache: "durable" | "hot";
      body: string | null;
      ok: true;
    }
  | {
      message: string;
      ok: false;
      status: number;
    };

export type ArtifactServerRequestResolution =
  | {
      artifact: TanstackStartArtifactServerResult;
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

type AuthorizedArtifactRequest =
  | {
      artifactCache: "durable" | "hot";
      hotArtifact: TanstackStartArtifact | null;
      metadata: TanstackStartArtifactMetadata;
      ok: true;
      revision: string;
    }
  | {
      message: string;
      ok: false;
      status: number;
    };

function durableStoreFailure(error: unknown) {
  return {
    message:
      error instanceof Error
        ? `Shared artifact storage is unavailable: ${error.message}`
        : "Shared artifact storage is unavailable.",
    ok: false as const,
    status: 503,
  };
}

function missingArtifact() {
  return {
    message:
      "This compiled revision is no longer available. Save or rebuild the preview and retry.",
    ok: false as const,
    status: 410,
  };
}

function artifactIdentityMatches(
  authorized: TanstackStartArtifactMetadata,
  selected: TanstackStartArtifactMetadata,
) {
  return (
    selected.revision === authorized.revision &&
    selected.kernelId === authorized.kernelId &&
    selected.rpcToken === authorized.rpcToken
  );
}

function changedArtifact() {
  return durableStoreFailure(
    new Error("Stored TanStack artifact changed during request authorization."),
  );
}

async function authorizeArtifactRequest(
  request: Request,
): Promise<AuthorizedArtifactRequest> {
  const url = new URL(request.url);
  const revision = url.searchParams.get("revision");
  if (!revision || !/^[a-f0-9]{64}$/.test(revision)) {
    return {
      message: "A valid compiled revision is required.",
      ok: false,
      status: 400,
    };
  }

  const hotArtifact = getTanstackStartArtifact(revision);
  let metadata: TanstackStartArtifactMetadata | null;
  if (hotArtifact) {
    metadata = getTanstackStartArtifactMetadata(hotArtifact);
  } else {
    try {
      metadata = await getDurableTanstackStartArtifactMetadata(revision);
    } catch (error) {
      return durableStoreFailure(error);
    }
  }
  if (!metadata) return missingArtifact();
  if (!matchesRpcToken(url.searchParams.get("token"), metadata.rpcToken)) {
    return {
      message: "Invalid preview RPC capability.",
      ok: false,
      status: 403,
    };
  }

  return {
    artifactCache: hotArtifact ? "hot" : "durable",
    hotArtifact,
    metadata,
    ok: true,
    revision,
  };
}

function hotAsset(
  artifact: TanstackStartArtifact,
  asset: TanstackStartArtifactAsset,
) {
  switch (asset.kind) {
    case "client":
      return artifact.ssrClientBundle;
    case "client-chunk":
      return artifact.ssrClientChunks[asset.name] ?? null;
    case "style":
      return artifact.ssrCss;
    case "style-chunk":
      return artifact.ssrCssChunks[asset.name] ?? null;
  }
}

export async function resolveArtifactRequest(
  request: Request,
): Promise<ArtifactRequestResolution> {
  const authorization = await authorizeArtifactRequest(request);
  if (!authorization.ok) return authorization;
  let artifact = authorization.hotArtifact;
  if (!artifact) {
    try {
      artifact = await getDurableTanstackStartArtifact(authorization.revision);
    } catch (error) {
      return durableStoreFailure(error);
    }
  }
  if (!artifact) return missingArtifact();
  if (!artifactIdentityMatches(authorization.metadata, artifact))
    return changedArtifact();
  if (authorization.artifactCache === "durable")
    putTanstackStartArtifact(artifact);

  return {
    artifact,
    artifactCache: authorization.artifactCache,
    ok: true,
  };
}

export async function resolveArtifactAssetRequest(
  request: Request,
  asset: TanstackStartArtifactAsset,
): Promise<ArtifactAssetRequestResolution> {
  const authorization = await authorizeArtifactRequest(request);
  if (!authorization.ok) return authorization;
  if (authorization.hotArtifact) {
    return {
      artifact: authorization.metadata,
      artifactCache: "hot",
      body: hotAsset(authorization.hotArtifact, asset),
      ok: true,
    };
  }

  let selected: TanstackStartArtifactAssetResult | null;
  try {
    selected = await getDurableTanstackStartArtifactAsset(
      authorization.revision,
      asset,
    );
  } catch (error) {
    return durableStoreFailure(error);
  }
  if (!selected) return missingArtifact();
  if (!artifactIdentityMatches(authorization.metadata, selected.artifact))
    return changedArtifact();
  return {
    artifact: selected.artifact,
    artifactCache: "durable",
    body: selected.body,
    ok: true,
  };
}

export async function resolveArtifactServerRequest(
  request: Request,
): Promise<ArtifactServerRequestResolution> {
  const authorization = await authorizeArtifactRequest(request);
  if (!authorization.ok) return authorization;
  if (authorization.hotArtifact) {
    return {
      artifact: {
        ...authorization.metadata,
        serverBundle: authorization.hotArtifact.serverBundle,
        serverChunks: authorization.hotArtifact.serverChunks,
      },
      artifactCache: "hot",
      ok: true,
    };
  }

  let artifact: TanstackStartArtifactServerResult | null;
  try {
    artifact = await getDurableTanstackStartServerArtifact(
      authorization.revision,
    );
  } catch (error) {
    return durableStoreFailure(error);
  }
  if (!artifact) return missingArtifact();
  if (!artifactIdentityMatches(authorization.metadata, artifact))
    return changedArtifact();
  return { artifact, artifactCache: "durable", ok: true };
}
