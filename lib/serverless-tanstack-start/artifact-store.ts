import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import kernelManifest from "./kernel-manifest.generated.json";
import {
  createTanstackStartDeploymentManifest,
  type TanstackStartArtifact,
  type TanstackStartPrerenderedOutput,
} from "./artifact-cache";
import type {
  ServerRuntimeArtifact,
  ServerRuntimeSource,
} from "./server-runtime-store";

type LegacyArtifactEnvelopePayload = {
  artifact: TanstackStartArtifact;
  createdAt: number;
  expiresAt: number;
  version: 3;
};

type ArtifactBlobDescriptor = {
  bytes: number;
  hash: string;
};

type ArtifactSourceManifest = {
  html: ArtifactBlobDescriptor;
  prerenderedDocuments?: Record<string, ArtifactBlobDescriptor>;
  serverBundle: ArtifactBlobDescriptor;
  serverChunks: Record<string, ArtifactBlobDescriptor>;
  ssrClientBundle: ArtifactBlobDescriptor;
  ssrClientChunks: Record<string, ArtifactBlobDescriptor>;
  ssrCss: ArtifactBlobDescriptor;
  ssrCssChunks: Record<string, ArtifactBlobDescriptor>;
  staticServerFunctions?: Record<string, ArtifactBlobDescriptor>;
};

type TanstackStartPrerenderedMetadata = Omit<
  TanstackStartPrerenderedOutput,
  "documents"
>;

type ArtifactManifest = Omit<
  TanstackStartArtifact,
  | "html"
  | "prerendered"
  | "serverBundle"
  | "serverChunks"
  | "ssrClientBundle"
  | "ssrClientChunks"
  | "ssrCss"
  | "ssrCssChunks"
  | "staticServerFunctions"
> & {
  prerendered?: TanstackStartPrerenderedMetadata;
  sources: ArtifactSourceManifest;
};

export type TanstackStartArtifactMetadata = Omit<
  TanstackStartArtifact,
  | "html"
  | "prerendered"
  | "serverBundle"
  | "serverChunks"
  | "ssrClientBundle"
  | "ssrClientChunks"
  | "ssrCss"
  | "ssrCssChunks"
  | "staticServerFunctions"
> & {
  prerendered?: TanstackStartPrerenderedMetadata;
};

export type TanstackStartArtifactDocumentResult = {
  artifact: TanstackStartArtifactMetadata;
  body: string | null;
};

export type TanstackStartArtifactAsset =
  | { kind: "client" }
  | { kind: "client-chunk"; name: string }
  | { kind: "deployment-manifest" }
  | { kind: "static-server-function"; name: string }
  | { kind: "style" }
  | { kind: "style-chunk"; name: string };

export type TanstackStartArtifactAssetResult = {
  artifact: TanstackStartArtifactMetadata;
  body: string | null;
};

export type TanstackStartArtifactServerResult =
  TanstackStartArtifactMetadata & {
    serverBundle: string;
    serverChunks: Record<string, string>;
  };

export type TanstackStartArtifactServerRuntimeResult =
  TanstackStartArtifactMetadata & {
    runtime: ServerRuntimeArtifact;
  };

export type TanstackStartArtifactSummary = TanstackStartArtifactMetadata & {
  html: string;
};

type ContentAddressedEnvelopePayload = {
  artifact: ArtifactManifest;
  createdAt: number;
  expiresAt: number;
  version: 4;
};

type ArtifactEnvelopePayload =
  | ContentAddressedEnvelopePayload
  | LegacyArtifactEnvelopePayload;

type ArtifactEnvelope = ArtifactEnvelopePayload & {
  integrity: string;
};

export type ArtifactBlobStore = {
  delete(key: string): Promise<void>;
  get(key: string): Promise<string | null>;
  getStream?(key: string): Promise<AsyncIterable<Uint8Array> | null>;
  put(key: string, value: string, contentType?: string): Promise<void>;
};

export type TanstackStartArtifactStore = {
  get(revision: string): Promise<TanstackStartArtifact | null>;
  getAsset?(
    revision: string,
    asset: TanstackStartArtifactAsset,
  ): Promise<TanstackStartArtifactAssetResult | null>;
  getMetadata?(revision: string): Promise<TanstackStartArtifactMetadata | null>;
  getPrerenderedDocument?(
    revision: string,
    outputPath: string,
  ): Promise<TanstackStartArtifactDocumentResult | null>;
  getServer?(
    revision: string,
  ): Promise<TanstackStartArtifactServerResult | null>;
  getServerRuntime?(
    revision: string,
  ): Promise<TanstackStartArtifactServerRuntimeResult | null>;
  getSummary?(revision: string): Promise<TanstackStartArtifactSummary | null>;
  put(artifact: TanstackStartArtifact): Promise<void>;
};

export type TanstackStartArtifactStoreOptions = {
  blobCacheMaxBytes?: number;
  blobConcurrency?: number;
  blobStore: ArtifactBlobStore;
  maxBytes?: number;
  prefix?: string;
  signingKey: string;
  ttlMs?: number;
};

type FilesystemStoreOptions = Omit<
  TanstackStartArtifactStoreOptions,
  "blobStore"
> & {
  root: string;
};

type S3StoreOptions = Omit<TanstackStartArtifactStoreOptions, "blobStore"> & {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  region?: string;
  secretAccessKey: string;
  sessionToken?: string;
};

const defaultTtlMs = 60 * 60 * 1000;
const defaultMaxBytes = 16 * 1024 * 1024;
const defaultBlobCacheMaxBytes = 32 * 1024 * 1024;
const defaultBlobConcurrency = 8;
const defaultManifestCacheEntries = 64;
const defaultPrefix = "tanstack-start/artifacts";
const configuredStoreKey = Symbol.for("tuto.tanstack-start.durable-store.v2");
let testStore: TanstackStartArtifactStore | null | undefined;

function payloadJson(payload: ArtifactEnvelopePayload) {
  return JSON.stringify(payload);
}

function integrity(payload: ArtifactEnvelopePayload, signingKey: string) {
  return createHmac("sha256", signingKey)
    .update(payloadJson(payload))
    .digest("hex");
}

function equalIntegrity(left: unknown, right: string) {
  if (
    typeof left !== "string" ||
    !/^[a-f0-9]{64}$/.test(left) ||
    !/^[a-f0-9]{64}$/.test(right)
  )
    return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function sha256(source: string) {
  return createHash("sha256").update(source).digest("hex");
}

function sourceDescriptor(source: string): ArtifactBlobDescriptor {
  return {
    bytes: Buffer.byteLength(source),
    hash: sha256(source),
  };
}

class ArtifactBlobCache {
  private readonly entries = new Map<string, string>();
  private readonly maxBytes: number;
  private totalBytes = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get(hash: string) {
    const source = this.entries.get(hash);
    if (source === undefined) return undefined;
    this.entries.delete(hash);
    this.entries.set(hash, source);
    return source;
  }

  set(hash: string, source: string) {
    const bytes = Buffer.byteLength(source);
    if (bytes > this.maxBytes) return;
    const existing = this.entries.get(hash);
    if (existing !== undefined) {
      this.totalBytes -= Buffer.byteLength(existing);
      this.entries.delete(hash);
    }
    this.entries.set(hash, source);
    this.totalBytes += bytes;
    while (this.totalBytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as
        | [string, string]
        | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.totalBytes -= Buffer.byteLength(oldest[1]);
    }
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from(
    { length: Math.min(values.length, concurrency) },
    async () => {
      while (!failed && nextIndex < values.length) {
        const index = nextIndex++;
        try {
          results[index] = await operation(values[index]!);
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    },
  );
  await Promise.all(workers);
  if (failed) throw failure;
  return results;
}

function readPositiveInteger(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePrefix(prefix = defaultPrefix) {
  const segments = prefix.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._-]+$/.test(segment),
    )
  ) {
    throw new Error("Invalid TanStack artifact object prefix.");
  }
  return segments.join("/");
}

function objectKey(prefix: string, revision: string) {
  if (!/^[a-f0-9]{64}$/.test(revision)) {
    throw new Error("Invalid TanStack Start artifact revision.");
  }
  return `${prefix}/${kernelManifest.id}/${revision}.json`;
}

function blobObjectKey(prefix: string, hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("Invalid TanStack Start artifact blob hash.");
  }
  return `${prefix}/${kernelManifest.id}/blobs/${hash}.blob`;
}

function prerenderedOutputPathIsValid(value: string) {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    value.endsWith(".html") &&
    value.length <= 2_048 &&
    !value.split("/").includes("..")
  );
}

function prerenderedRoutePathIsValid(value: string) {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("#") ||
    value.length > 2_048
  ) {
    return false;
  }
  try {
    return new URL(value, "http://localhost").origin === "http://localhost";
  } catch {
    return false;
  }
}

function staticServerFunctionPathIsValid(value: string) {
  return /^\/__tsr\/staticServerFnCache\/[a-f0-9]{40}\.json$/.test(value);
}

function staticServerFunctionsAreValid(value: unknown) {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object") return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 64 &&
    entries.every(
      ([cachePath, body]) =>
        staticServerFunctionPathIsValid(cachePath) &&
        typeof body === "string" &&
        Buffer.byteLength(body) <= 3_000_000,
    )
  );
}

function isrDocumentsAreValid(
  value: unknown,
  output: TanstackStartPrerenderedOutput,
) {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object") return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 64 &&
    entries.every(([outputPath, rawPolicy]) => {
      if (
        !prerenderedOutputPathIsValid(outputPath) ||
        !Object.hasOwn(output.documents, outputPath) ||
        rawPolicy === null ||
        typeof rawPolicy !== "object"
      ) {
        return false;
      }
      const policy = rawPolicy as NonNullable<
        TanstackStartPrerenderedOutput["isr"]
      >[string];
      const requestHeaders = policy.requestHeaders;
      return (
        typeof policy.cacheControl === "string" &&
        policy.cacheControl.length > 0 &&
        policy.cacheControl.length <= 2_048 &&
        Number.isSafeInteger(policy.generatedAt) &&
        policy.generatedAt >= 0 &&
        Number.isSafeInteger(policy.maxRedirects) &&
        policy.maxRedirects >= 0 &&
        policy.maxRedirects <= 20 &&
        requestHeaders !== null &&
        typeof requestHeaders === "object" &&
        Object.entries(requestHeaders).length <= 64 &&
        Object.entries(requestHeaders).every(
          ([name, headerValue]) =>
            /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) &&
            typeof headerValue === "string" &&
            headerValue.length <= 8_192,
        ) &&
        Number.isSafeInteger(policy.revalidateSeconds) &&
        policy.revalidateSeconds >= 0 &&
        prerenderedRoutePathIsValid(policy.routePath) &&
        output.routes[policy.routePath] === outputPath &&
        Array.isArray(policy.staticServerFunctionPaths) &&
        policy.staticServerFunctionPaths.length <= 64 &&
        policy.staticServerFunctionPaths.every(
          staticServerFunctionPathIsValid,
        ) &&
        Number.isSafeInteger(policy.staleWhileRevalidateSeconds) &&
        policy.staleWhileRevalidateSeconds >= 0
      );
    })
  );
}

function prerenderedOutputIsValid(value: unknown) {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object") return false;
  const output = value as TanstackStartPrerenderedOutput;
  if (
    output.documents === null ||
    typeof output.documents !== "object" ||
    output.routes === null ||
    typeof output.routes !== "object"
  ) {
    return false;
  }
  const documents = Object.entries(output.documents);
  const routes = Object.entries(output.routes);
  if (documents.length > 64 || routes.length > 64) return false;
  if (
    !documents.every(
      ([outputPath, html]) =>
        prerenderedOutputPathIsValid(outputPath) && typeof html === "string",
    ) ||
    !routes.every(
      ([routePath, outputPath]) =>
        prerenderedRoutePathIsValid(routePath) &&
        prerenderedOutputPathIsValid(outputPath) &&
        Object.hasOwn(output.documents, outputPath),
    )
  ) {
    return false;
  }
  if (!isrDocumentsAreValid(output.isr, output)) return false;
  return (
    output.shell === undefined ||
    (prerenderedOutputPathIsValid(output.shell) &&
      Object.hasOwn(output.documents, output.shell))
  );
}

function deploymentManifestIsValid(
  value: unknown,
  prerendered: TanstackStartPrerenderedOutput | undefined,
  staticServerFunctions: Record<string, string> | undefined,
) {
  if (value === undefined) return true;
  if (!prerendered || value === null || typeof value !== "object") return false;
  return (
    JSON.stringify(value) ===
    JSON.stringify(
      createTanstackStartDeploymentManifest(prerendered, staticServerFunctions),
    )
  );
}

function artifactIsValid(
  artifact: unknown,
  revision: string,
): artifact is TanstackStartArtifact {
  if (artifact === null || typeof artifact !== "object") return false;
  const candidate = artifact as TanstackStartArtifact;
  const clientChunksAreValid =
    candidate.ssrClientChunks !== null &&
    typeof candidate.ssrClientChunks === "object" &&
    Object.entries(candidate.ssrClientChunks).every(
      ([name, value]) =>
        /^chunks\/[A-Za-z0-9_-]+\.js$/.test(name) && typeof value === "string",
    );
  const cssChunksAreValid =
    candidate.ssrCssChunks !== null &&
    typeof candidate.ssrCssChunks === "object" &&
    Object.entries(candidate.ssrCssChunks).every(
      ([name, value]) =>
        /^chunks\/[A-Za-z0-9_-]+\.css$/.test(name) && typeof value === "string",
    );
  const serverChunksAreValid =
    candidate.serverChunks !== null &&
    typeof candidate.serverChunks === "object" &&
    Object.entries(candidate.serverChunks).every(
      ([name, value]) =>
        /^chunks\/[A-Za-z0-9_-]+\.js$/.test(name) && typeof value === "string",
    );
  const routeManifestIsValid =
    candidate.routeManifest !== null &&
    typeof candidate.routeManifest === "object" &&
    Object.values(candidate.routeManifest).every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        Array.isArray(entry.preloads) &&
        entry.preloads.every((preload) => typeof preload === "string") &&
        (entry.css === undefined ||
          (Array.isArray(entry.css) &&
            entry.css.every((stylesheet) => typeof stylesheet === "string"))),
    );

  return (
    candidate.success === true &&
    candidate.revision === revision &&
    candidate.kernelId === kernelManifest.id &&
    typeof candidate.rpcToken === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(candidate.rpcToken) &&
    typeof candidate.html === "string" &&
    typeof candidate.ssrClientBundle === "string" &&
    clientChunksAreValid &&
    cssChunksAreValid &&
    serverChunksAreValid &&
    routeManifestIsValid &&
    prerenderedOutputIsValid(candidate.prerendered) &&
    deploymentManifestIsValid(
      candidate.deploymentManifest,
      candidate.prerendered,
      candidate.staticServerFunctions,
    ) &&
    staticServerFunctionsAreValid(candidate.staticServerFunctions) &&
    typeof candidate.ssrCss === "string" &&
    typeof candidate.serverBundle === "string" &&
    Array.isArray(candidate.serverFnIds) &&
    candidate.serverFnIds.every((id) => typeof id === "string")
  );
}

function artifactMetadata(
  artifact: TanstackStartArtifactMetadata,
): TanstackStartArtifactMetadata {
  return {
    buildMetrics: artifact.buildMetrics,
    diagnostics: artifact.diagnostics,
    ...(artifact.deploymentManifest
      ? { deploymentManifest: artifact.deploymentManifest }
      : {}),
    durationMs: artifact.durationMs,
    kernelId: artifact.kernelId,
    ...(artifact.prerendered
      ? {
          prerendered: {
            ...(artifact.prerendered.isr
              ? { isr: artifact.prerendered.isr }
              : {}),
            routes: artifact.prerendered.routes,
            ...(artifact.prerendered.shell
              ? { shell: artifact.prerendered.shell }
              : {}),
          },
        }
      : {}),
    revision: artifact.revision,
    routeManifest: artifact.routeManifest,
    rpcToken: artifact.rpcToken,
    serverFnIds: artifact.serverFnIds,
    success: artifact.success,
  };
}

function artifactAssetBody(
  artifact: TanstackStartArtifact,
  asset: TanstackStartArtifactAsset,
) {
  switch (asset.kind) {
    case "client":
      return artifact.ssrClientBundle;
    case "client-chunk":
      return artifact.ssrClientChunks[asset.name] ?? null;
    case "deployment-manifest":
      return artifact.deploymentManifest
        ? JSON.stringify(artifact.deploymentManifest)
        : null;
    case "static-server-function":
      return artifact.staticServerFunctions?.[asset.name] ?? null;
    case "style":
      return artifact.ssrCss;
    case "style-chunk":
      return artifact.ssrCssChunks[asset.name] ?? null;
  }
}

function artifactAssetDescriptor(
  manifest: ArtifactManifest,
  asset: TanstackStartArtifactAsset,
) {
  switch (asset.kind) {
    case "client":
      return manifest.sources.ssrClientBundle;
    case "client-chunk":
      return manifest.sources.ssrClientChunks[asset.name] ?? null;
    case "deployment-manifest":
      return null;
    case "static-server-function":
      return manifest.sources.staticServerFunctions?.[asset.name] ?? null;
    case "style":
      return manifest.sources.ssrCss;
    case "style-chunk":
      return manifest.sources.ssrCssChunks[asset.name] ?? null;
  }
}

function inlineServerRuntime(
  artifact: Pick<
    TanstackStartArtifact,
    "kernelId" | "revision" | "serverBundle" | "serverChunks"
  >,
): ServerRuntimeArtifact {
  return {
    kernelId: artifact.kernelId,
    revision: artifact.revision,
    serverBundle: artifact.serverBundle,
    serverChunks: artifact.serverChunks,
  };
}

function descriptorIsValid(value: unknown): value is ArtifactBlobDescriptor {
  if (value === null || typeof value !== "object") return false;
  const descriptor = value as ArtifactBlobDescriptor;
  return (
    Number.isSafeInteger(descriptor.bytes) &&
    descriptor.bytes >= 0 &&
    typeof descriptor.hash === "string" &&
    /^[a-f0-9]{64}$/.test(descriptor.hash)
  );
}

function descriptorRecordIsValid(
  value: unknown,
  extension: "css" | "js",
): value is Record<string, ArtifactBlobDescriptor> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.entries(value).every(
      ([name, descriptor]) =>
        new RegExp(`^chunks/[A-Za-z0-9_-]+\\.${extension}$`).test(name) &&
        descriptorIsValid(descriptor),
    )
  );
}

function createArtifactManifest(artifact: TanstackStartArtifact) {
  const {
    html,
    prerendered,
    serverBundle,
    serverChunks,
    ssrClientBundle,
    ssrClientChunks,
    ssrCss,
    ssrCssChunks,
    staticServerFunctions,
    ...metadata
  } = artifact;
  const blobs = new Map<string, string>();
  const describe = (source: string) => {
    const descriptor = sourceDescriptor(source);
    blobs.set(descriptor.hash, source);
    return descriptor;
  };
  const describeRecord = (sources: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(sources)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, source]) => [name, describe(source)]),
    );

  return {
    blobs,
    manifest: {
      ...metadata,
      ...(prerendered
        ? {
            prerendered: {
              ...(prerendered.isr ? { isr: prerendered.isr } : {}),
              routes: prerendered.routes,
              ...(prerendered.shell ? { shell: prerendered.shell } : {}),
            },
          }
        : {}),
      sources: {
        html: describe(html),
        ...(prerendered
          ? { prerenderedDocuments: describeRecord(prerendered.documents) }
          : {}),
        serverBundle: describe(serverBundle),
        serverChunks: describeRecord(serverChunks),
        ssrClientBundle: describe(ssrClientBundle),
        ssrClientChunks: describeRecord(ssrClientChunks),
        ssrCss: describe(ssrCss),
        ssrCssChunks: describeRecord(ssrCssChunks),
        ...(staticServerFunctions
          ? { staticServerFunctions: describeRecord(staticServerFunctions) }
          : {}),
      },
    } satisfies ArtifactManifest,
  };
}

function artifactManifestIsValid(
  value: unknown,
  revision: string,
): value is ArtifactManifest {
  if (value === null || typeof value !== "object") return false;
  const manifest = value as ArtifactManifest;
  const sources = manifest.sources;
  if (
    sources === null ||
    typeof sources !== "object" ||
    Boolean(manifest.prerendered) !== Boolean(sources.prerenderedDocuments) ||
    !descriptorIsValid(sources.html) ||
    (sources.prerenderedDocuments !== undefined &&
      !(
        sources.prerenderedDocuments !== null &&
        typeof sources.prerenderedDocuments === "object" &&
        Object.entries(sources.prerenderedDocuments).every(
          ([outputPath, descriptor]) =>
            prerenderedOutputPathIsValid(outputPath) &&
            descriptorIsValid(descriptor),
        )
      )) ||
    !descriptorIsValid(sources.serverBundle) ||
    !descriptorRecordIsValid(sources.serverChunks, "js") ||
    !descriptorIsValid(sources.ssrClientBundle) ||
    !descriptorRecordIsValid(sources.ssrClientChunks, "js") ||
    !descriptorIsValid(sources.ssrCss) ||
    !descriptorRecordIsValid(sources.ssrCssChunks, "css") ||
    (sources.staticServerFunctions !== undefined &&
      !(
        sources.staticServerFunctions !== null &&
        typeof sources.staticServerFunctions === "object" &&
        Object.entries(sources.staticServerFunctions).every(
          ([cachePath, descriptor]) =>
            staticServerFunctionPathIsValid(cachePath) &&
            descriptorIsValid(descriptor),
        )
      ))
  ) {
    return false;
  }

  const metadata = Object.fromEntries(
    Object.entries(manifest).filter(([name]) => name !== "sources"),
  );
  return artifactIsValid(
    {
      ...metadata,
      html: "",
      ...(manifest.prerendered
        ? {
            prerendered: {
              ...manifest.prerendered,
              documents: Object.fromEntries(
                Object.keys(sources.prerenderedDocuments ?? {}).map(
                  (outputPath) => [outputPath, ""],
                ),
              ),
            },
          }
        : {}),
      serverBundle: "",
      serverChunks: Object.fromEntries(
        Object.keys(sources.serverChunks).map((name) => [name, ""]),
      ),
      ssrClientBundle: "",
      ssrClientChunks: Object.fromEntries(
        Object.keys(sources.ssrClientChunks).map((name) => [name, ""]),
      ),
      ssrCss: "",
      ssrCssChunks: Object.fromEntries(
        Object.keys(sources.ssrCssChunks).map((name) => [name, ""]),
      ),
      ...(sources.staticServerFunctions
        ? {
            staticServerFunctions: Object.fromEntries(
              Object.keys(sources.staticServerFunctions).map((name) => [
                name,
                "",
              ]),
            ),
          }
        : {}),
    },
    revision,
  );
}

function artifactDescriptors(manifest: ArtifactManifest) {
  const sources = manifest.sources;
  return [
    sources.html,
    ...Object.values(sources.prerenderedDocuments ?? {}),
    sources.serverBundle,
    ...Object.values(sources.serverChunks),
    sources.ssrClientBundle,
    ...Object.values(sources.ssrClientChunks),
    sources.ssrCss,
    ...Object.values(sources.ssrCssChunks),
    ...Object.values(sources.staticServerFunctions ?? {}),
  ];
}

function reconstructArtifact(
  manifest: ArtifactManifest,
  blobs: Map<string, string>,
) {
  const { sources, ...metadata } = manifest;
  const { prerendered, ...artifactMetadata } = metadata;
  const source = (descriptor: ArtifactBlobDescriptor) =>
    blobs.get(descriptor.hash)!;
  const sourceRecord = (record: Record<string, ArtifactBlobDescriptor>) =>
    Object.fromEntries(
      Object.entries(record).map(([name, descriptor]) => [
        name,
        source(descriptor),
      ]),
    );

  return {
    ...artifactMetadata,
    html: source(sources.html),
    ...(prerendered
      ? {
          prerendered: {
            ...prerendered,
            documents: sourceRecord(sources.prerenderedDocuments ?? {}),
          },
        }
      : {}),
    serverBundle: source(sources.serverBundle),
    serverChunks: sourceRecord(sources.serverChunks),
    ssrClientBundle: source(sources.ssrClientBundle),
    ssrClientChunks: sourceRecord(sources.ssrClientChunks),
    ssrCss: source(sources.ssrCss),
    ssrCssChunks: sourceRecord(sources.ssrCssChunks),
    ...(sources.staticServerFunctions
      ? {
          staticServerFunctions: sourceRecord(sources.staticServerFunctions),
        }
      : {}),
  } satisfies TanstackStartArtifact;
}

export function createTanstackStartArtifactStore({
  blobCacheMaxBytes = defaultBlobCacheMaxBytes,
  blobConcurrency = defaultBlobConcurrency,
  blobStore,
  maxBytes = defaultMaxBytes,
  prefix: inputPrefix,
  signingKey,
  ttlMs = defaultTtlMs,
}: TanstackStartArtifactStoreOptions): TanstackStartArtifactStore {
  if (!signingKey)
    throw new Error("A TanStack artifact signing key is required.");
  const prefix = normalizePrefix(inputPrefix);
  const concurrency =
    Number.isSafeInteger(blobConcurrency) && blobConcurrency > 0
      ? blobConcurrency
      : defaultBlobConcurrency;
  const cache = new ArtifactBlobCache(
    Number.isSafeInteger(blobCacheMaxBytes) && blobCacheMaxBytes > 0
      ? blobCacheMaxBytes
      : defaultBlobCacheMaxBytes,
  );
  const manifestCache = new Map<string, ArtifactEnvelopePayload>();

  const cacheManifest = (
    revision: string,
    payload: ArtifactEnvelopePayload,
  ) => {
    manifestCache.delete(revision);
    manifestCache.set(revision, payload);
    while (manifestCache.size > defaultManifestCacheEntries) {
      const oldest = manifestCache.keys().next().value as string | undefined;
      if (!oldest) break;
      manifestCache.delete(oldest);
    }
  };

  const loadBlob = async (
    descriptor: ArtifactBlobDescriptor,
    cacheResult = true,
  ) => {
    const cached = cache.get(descriptor.hash);
    if (cached !== undefined) {
      if (Buffer.byteLength(cached) !== descriptor.bytes) {
        throw new Error(
          "Stored TanStack artifact has inconsistent blob descriptors.",
        );
      }
      return cached;
    }
    const source = await blobStore.get(blobObjectKey(prefix, descriptor.hash));
    if (source === null) {
      throw new Error(
        `Stored TanStack artifact blob ${descriptor.hash} is missing.`,
      );
    }
    if (
      Buffer.byteLength(source) !== descriptor.bytes ||
      sha256(source) !== descriptor.hash
    ) {
      throw new Error(
        `Stored TanStack artifact blob ${descriptor.hash} failed integrity validation.`,
      );
    }
    if (cacheResult) cache.set(descriptor.hash, source);
    return source;
  };

  const loadBlobStream = async (descriptor: ArtifactBlobDescriptor) => {
    const cached = cache.get(descriptor.hash);
    if (cached !== undefined) {
      if (Buffer.byteLength(cached) !== descriptor.bytes) {
        throw new Error(
          "Stored TanStack artifact has inconsistent blob descriptors.",
        );
      }
      return (async function* () {
        yield Buffer.from(cached);
      })();
    }
    if (blobStore.getStream) {
      const stream = await blobStore.getStream(
        blobObjectKey(prefix, descriptor.hash),
      );
      if (stream === null) {
        throw new Error(
          `Stored TanStack artifact blob ${descriptor.hash} is missing.`,
        );
      }
      return stream;
    }
    const source = await loadBlob(descriptor, false);
    return (async function* () {
      yield Buffer.from(source);
    })();
  };

  const deferredSource = (
    descriptor: ArtifactBlobDescriptor,
  ): ServerRuntimeSource => ({
    bytes: descriptor.bytes,
    hash: descriptor.hash,
    load: () => loadBlob(descriptor, false),
    stream: () => loadBlobStream(descriptor),
  });

  const loadDescriptors = async (descriptors: ArtifactBlobDescriptor[]) => {
    const uniqueDescriptors = new Map<string, ArtifactBlobDescriptor>();
    for (const descriptor of descriptors) {
      const existing = uniqueDescriptors.get(descriptor.hash);
      if (existing && existing.bytes !== descriptor.bytes) {
        throw new Error(
          "Stored TanStack artifact has inconsistent blob descriptors.",
        );
      }
      uniqueDescriptors.set(descriptor.hash, descriptor);
    }
    return new Map(
      await mapConcurrent(
        [...uniqueDescriptors.values()],
        concurrency,
        async (descriptor) =>
          [descriptor.hash, await loadBlob(descriptor)] as const,
      ),
    );
  };

  const loadManifest = async (revision: string) => {
    const key = objectKey(prefix, revision);
    const cached = manifestCache.get(revision);
    if (cached) {
      if (cached.expiresAt <= Date.now()) {
        manifestCache.delete(revision);
        await blobStore.delete(key).catch(() => undefined);
        return null;
      }
      cacheManifest(revision, cached);
      return cached;
    }

    const serialized = await blobStore.get(key);
    if (serialized === null) return null;
    if (Buffer.byteLength(serialized) > maxBytes) {
      throw new Error(
        "Stored TanStack artifact exceeds the configured size limit.",
      );
    }

    let envelope: ArtifactEnvelope;
    try {
      envelope = JSON.parse(serialized) as ArtifactEnvelope;
    } catch {
      throw new Error("Stored TanStack artifact is not valid JSON.");
    }
    const payload = {
      artifact: envelope.artifact,
      createdAt: envelope.createdAt,
      expiresAt: envelope.expiresAt,
      version: envelope.version,
    } as ArtifactEnvelopePayload;
    if (!equalIntegrity(envelope.integrity, integrity(payload, signingKey))) {
      throw new Error("Stored TanStack artifact failed integrity validation.");
    }
    if (
      !Number.isSafeInteger(payload.createdAt) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.createdAt > payload.expiresAt
    ) {
      throw new Error(
        "Stored TanStack artifact is incompatible with this runtime.",
      );
    }
    if (payload.expiresAt <= Date.now()) {
      await blobStore.delete(key).catch(() => undefined);
      return null;
    }

    if (payload.version === 3) {
      if (!artifactIsValid(payload.artifact, revision)) {
        throw new Error(
          "Stored TanStack artifact is incompatible with this runtime.",
        );
      }
    } else if (
      payload.version === 4 &&
      artifactManifestIsValid(payload.artifact, revision)
    ) {
      const descriptors = artifactDescriptors(payload.artifact);
      const referencedBytes = descriptors.reduce(
        (total, descriptor) => total + descriptor.bytes,
        0,
      );
      if (referencedBytes > maxBytes) {
        throw new Error(
          "Stored TanStack artifact exceeds the configured size limit.",
        );
      }
      const descriptorBytes = new Map<string, number>();
      for (const descriptor of descriptors) {
        const existingBytes = descriptorBytes.get(descriptor.hash);
        if (existingBytes !== undefined && existingBytes !== descriptor.bytes) {
          throw new Error(
            "Stored TanStack artifact has inconsistent blob descriptors.",
          );
        }
        descriptorBytes.set(descriptor.hash, descriptor.bytes);
      }
    } else {
      throw new Error(
        "Stored TanStack artifact is incompatible with this runtime.",
      );
    }

    cacheManifest(revision, payload);
    return payload;
  };

  return {
    async get(revision) {
      const payload = await loadManifest(revision);
      if (!payload) return null;
      if (payload.version === 3) return payload.artifact;
      const artifact = reconstructArtifact(
        payload.artifact,
        await loadDescriptors(artifactDescriptors(payload.artifact)),
      );
      if (
        !artifactIsValid(artifact, revision) ||
        Buffer.byteLength(JSON.stringify(artifact)) > maxBytes
      ) {
        throw new Error(
          "Stored TanStack artifact is incompatible with this runtime.",
        );
      }
      return artifact;
    },

    async getAsset(revision, asset) {
      const payload = await loadManifest(revision);
      if (!payload) return null;
      if (payload.version === 3) {
        return {
          artifact: artifactMetadata(payload.artifact),
          body: artifactAssetBody(payload.artifact, asset),
        };
      }
      const descriptor = artifactAssetDescriptor(payload.artifact, asset);
      return {
        artifact: artifactMetadata(payload.artifact),
        body:
          asset.kind === "deployment-manifest"
            ? payload.artifact.deploymentManifest
              ? JSON.stringify(payload.artifact.deploymentManifest)
              : null
            : descriptor
              ? await loadBlob(descriptor)
              : null,
      };
    },

    async getMetadata(revision) {
      const payload = await loadManifest(revision);
      return payload ? artifactMetadata(payload.artifact) : null;
    },

    async getPrerenderedDocument(revision, outputPath) {
      const payload = await loadManifest(revision);
      if (!payload) return null;
      if (payload.version === 3) {
        return {
          artifact: artifactMetadata(payload.artifact),
          body: payload.artifact.prerendered?.documents[outputPath] ?? null,
        };
      }
      const descriptor =
        payload.artifact.sources.prerenderedDocuments?.[outputPath];
      return {
        artifact: artifactMetadata(payload.artifact),
        body: descriptor ? await loadBlob(descriptor) : null,
      };
    },

    async getServer(revision) {
      const payload = await loadManifest(revision);
      if (!payload) return null;
      if (payload.version === 3) {
        return {
          ...artifactMetadata(payload.artifact),
          serverBundle: payload.artifact.serverBundle,
          serverChunks: payload.artifact.serverChunks,
        };
      }
      const blobs = await loadDescriptors([
        payload.artifact.sources.serverBundle,
        ...Object.values(payload.artifact.sources.serverChunks),
      ]);
      return {
        ...artifactMetadata(payload.artifact),
        serverBundle: blobs.get(payload.artifact.sources.serverBundle.hash)!,
        serverChunks: Object.fromEntries(
          Object.entries(payload.artifact.sources.serverChunks).map(
            ([name, descriptor]) => [name, blobs.get(descriptor.hash)!],
          ),
        ),
      };
    },

    async getServerRuntime(revision) {
      const payload = await loadManifest(revision);
      if (!payload) return null;
      if (payload.version === 3) {
        return {
          ...artifactMetadata(payload.artifact),
          runtime: inlineServerRuntime(payload.artifact),
        };
      }
      return {
        ...artifactMetadata(payload.artifact),
        runtime: {
          kernelId: payload.artifact.kernelId,
          revision: payload.artifact.revision,
          serverBundle: "",
          serverChunks: {},
          serverSources: {
            chunks: Object.fromEntries(
              Object.entries(payload.artifact.sources.serverChunks).map(
                ([name, descriptor]) => [name, deferredSource(descriptor)],
              ),
            ),
            entry: deferredSource(payload.artifact.sources.serverBundle),
          },
        },
      };
    },

    async getSummary(revision) {
      const payload = await loadManifest(revision);
      if (!payload) return null;
      if (payload.version === 3) {
        return {
          ...artifactMetadata(payload.artifact),
          html: payload.artifact.html,
        };
      }
      return {
        ...artifactMetadata(payload.artifact),
        html: await loadBlob(payload.artifact.sources.html),
      };
    },

    async put(artifact) {
      if (!artifactIsValid(artifact, artifact.revision)) {
        throw new Error(
          "Refusing to store an invalid TanStack Start artifact.",
        );
      }
      if (Buffer.byteLength(JSON.stringify(artifact)) > maxBytes) {
        throw new Error(
          "TanStack artifact exceeds the configured durable size limit.",
        );
      }
      const { blobs, manifest } = createArtifactManifest(artifact);
      const createdAt = Date.now();
      const payload: ContentAddressedEnvelopePayload = {
        artifact: manifest,
        createdAt,
        expiresAt: createdAt + ttlMs,
        version: 4,
      };
      const serialized = JSON.stringify({
        ...payload,
        integrity: integrity(payload, signingKey),
      } satisfies ArtifactEnvelope);
      if (Buffer.byteLength(serialized) > maxBytes) {
        throw new Error(
          "TanStack artifact exceeds the configured durable size limit.",
        );
      }
      await mapConcurrent([...blobs], concurrency, async ([hash, source]) => {
        await blobStore.put(
          blobObjectKey(prefix, hash),
          source,
          "text/plain; charset=utf-8",
        );
        cache.set(hash, source);
      });
      await blobStore.put(
        objectKey(prefix, artifact.revision),
        serialized,
        "application/json; charset=utf-8",
      );
      cacheManifest(artifact.revision, payload);
    },
  };
}

function createFilesystemBlobStore(root: string): ArtifactBlobStore {
  const resolvedRoot = path.resolve(root);
  const resolveKey = (key: string) =>
    path.join(resolvedRoot, ...key.split("/"));

  return {
    async delete(key) {
      await rm(resolveKey(key), { force: true });
    },
    async get(key) {
      try {
        return await readFile(resolveKey(key), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async getStream(key) {
      const target = resolveKey(key);
      try {
        const targetStat = await stat(target);
        if (!targetStat.isFile()) return null;
        return createReadStream(target) as AsyncIterable<Uint8Array>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async put(key, value) {
      const target = resolveKey(key);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await writeFile(temporary, value, "utf8");
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

function encodeObjectPath(bucket: string, key: string) {
  return [bucket, ...key.split("/")].map(encodeURIComponent).join("/");
}

function createS3BlobStore({
  accessKeyId,
  bucket,
  endpoint,
  region = "auto",
  secretAccessKey,
  sessionToken,
}: Pick<
  S3StoreOptions,
  | "accessKeyId"
  | "bucket"
  | "endpoint"
  | "region"
  | "secretAccessKey"
  | "sessionToken"
>): ArtifactBlobStore {
  const client = new AwsClient({
    accessKeyId,
    region,
    secretAccessKey,
    service: "s3",
    sessionToken,
  });
  const baseUrl = endpoint.replace(/\/+$/, "");
  const urlFor = (key: string) => `${baseUrl}/${encodeObjectPath(bucket, key)}`;
  const assertResponse = async (response: Response, operation: string) => {
    if (!response.ok) {
      throw new Error(
        `TanStack artifact ${operation} failed with HTTP ${response.status}.`,
      );
    }
  };

  return {
    async delete(key) {
      const response = await client.fetch(urlFor(key), { method: "DELETE" });
      if (response.status !== 404) await assertResponse(response, "delete");
    },
    async get(key) {
      const response = await client.fetch(urlFor(key), { method: "GET" });
      if (response.status === 404) return null;
      await assertResponse(response, "read");
      return response.text();
    },
    async getStream(key) {
      const response = await client.fetch(urlFor(key), { method: "GET" });
      if (response.status === 404) return null;
      await assertResponse(response, "read");
      const body = response.body;
      return (async function* () {
        if (!body) return;
        const reader = body.getReader();
        let completed = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              completed = true;
              return;
            }
            if (value) yield value;
          }
        } finally {
          if (!completed) await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      })();
    },
    async put(key, value, contentType = "application/octet-stream") {
      const response = await client.fetch(urlFor(key), {
        body: value,
        headers: {
          "cache-control": "no-store",
          "content-type": contentType,
        },
        method: "PUT",
      });
      await assertResponse(response, "write");
    },
  };
}

export function createFilesystemTanstackStartArtifactStore(
  options: FilesystemStoreOptions,
) {
  return createTanstackStartArtifactStore({
    ...options,
    blobStore: createFilesystemBlobStore(options.root),
  });
}

export function createS3TanstackStartArtifactStore(options: S3StoreOptions) {
  return createTanstackStartArtifactStore({
    ...options,
    blobStore: createS3BlobStore(options),
  });
}

function configuredStore() {
  const mode = process.env.TUTO_TANSTACK_ARTIFACT_STORE ?? "disabled";
  if (mode === "disabled") return null;
  const signingKey = process.env.TUTO_TANSTACK_ARTIFACT_SIGNING_KEY ?? "";
  const common = {
    blobCacheMaxBytes: readPositiveInteger(
      "TUTO_TANSTACK_ARTIFACT_BLOB_CACHE_MAX_BYTES",
      defaultBlobCacheMaxBytes,
    ),
    blobConcurrency: readPositiveInteger(
      "TUTO_TANSTACK_ARTIFACT_BLOB_CONCURRENCY",
      defaultBlobConcurrency,
    ),
    maxBytes: readPositiveInteger(
      "TUTO_TANSTACK_ARTIFACT_STORE_MAX_BYTES",
      defaultMaxBytes,
    ),
    prefix: process.env.TUTO_TANSTACK_ARTIFACT_STORE_PREFIX,
    signingKey,
    ttlMs: readPositiveInteger(
      "TUTO_TANSTACK_ARTIFACT_STORE_TTL_MS",
      defaultTtlMs,
    ),
  };

  if (mode === "filesystem") {
    return createFilesystemTanstackStartArtifactStore({
      ...common,
      root:
        process.env.TUTO_TANSTACK_ARTIFACT_FILESYSTEM_ROOT ??
        path.join(process.cwd(), ".tmp", "tanstack-start-artifacts"),
      signingKey: signingKey || "local-development-only",
    });
  }
  if (mode === "s3") {
    const endpoint = process.env.TUTO_TANSTACK_ARTIFACT_S3_ENDPOINT ?? "";
    const bucket = process.env.TUTO_TANSTACK_ARTIFACT_S3_BUCKET ?? "";
    const accessKeyId =
      process.env.TUTO_TANSTACK_ARTIFACT_S3_ACCESS_KEY_ID ?? "";
    const secretAccessKey =
      process.env.TUTO_TANSTACK_ARTIFACT_S3_SECRET_ACCESS_KEY ?? "";
    if (
      !endpoint ||
      !bucket ||
      !accessKeyId ||
      !secretAccessKey ||
      !signingKey
    ) {
      throw new Error(
        "S3 TanStack artifact storage requires endpoint, bucket, access key, secret key, and signing key.",
      );
    }
    return createS3TanstackStartArtifactStore({
      ...common,
      accessKeyId,
      bucket,
      endpoint,
      region: process.env.TUTO_TANSTACK_ARTIFACT_S3_REGION ?? "auto",
      secretAccessKey,
      sessionToken: process.env.TUTO_TANSTACK_ARTIFACT_S3_SESSION_TOKEN,
    });
  }

  throw new Error(`Unknown TanStack artifact store mode: ${mode}`);
}

function getStore() {
  if (testStore !== undefined) return testStore;
  const globals = globalThis as typeof globalThis & {
    [configuredStoreKey]?: TanstackStartArtifactStore | null;
  };
  if (!(configuredStoreKey in globals)) {
    globals[configuredStoreKey] = configuredStore();
  }
  return globals[configuredStoreKey] ?? null;
}

export async function getDurableTanstackStartArtifact(revision: string) {
  return (await getStore()?.get(revision)) ?? null;
}

export async function getDurableTanstackStartArtifactAsset(
  revision: string,
  asset: TanstackStartArtifactAsset,
) {
  const store = getStore();
  if (!store) return null;
  if (store.getAsset) return store.getAsset(revision, asset);
  const artifact = await store.get(revision);
  return artifact
    ? {
        artifact: artifactMetadata(artifact),
        body: artifactAssetBody(artifact, asset),
      }
    : null;
}

export async function getDurableTanstackStartArtifactMetadata(
  revision: string,
) {
  const store = getStore();
  if (!store) return null;
  if (store.getMetadata) return store.getMetadata(revision);
  const artifact = await store.get(revision);
  return artifact ? artifactMetadata(artifact) : null;
}

export async function getDurableTanstackStartPrerenderedDocument(
  revision: string,
  outputPath: string,
) {
  const store = getStore();
  if (!store) return null;
  if (store.getPrerenderedDocument) {
    return store.getPrerenderedDocument(revision, outputPath);
  }
  const artifact = await store.get(revision);
  return artifact
    ? {
        artifact: artifactMetadata(artifact),
        body: artifact.prerendered?.documents[outputPath] ?? null,
      }
    : null;
}

export async function getDurableTanstackStartServerArtifact(revision: string) {
  const store = getStore();
  if (!store) return null;
  if (store.getServer) return store.getServer(revision);
  const artifact = await store.get(revision);
  return artifact
    ? {
        ...artifactMetadata(artifact),
        serverBundle: artifact.serverBundle,
        serverChunks: artifact.serverChunks,
      }
    : null;
}

export async function getDurableTanstackStartServerRuntimeArtifact(
  revision: string,
) {
  const store = getStore();
  if (!store) return null;
  if (store.getServerRuntime) return store.getServerRuntime(revision);
  const artifact = store.getServer
    ? await store.getServer(revision)
    : await store.get(revision);
  return artifact
    ? {
        ...artifactMetadata(artifact),
        runtime: inlineServerRuntime(artifact),
      }
    : null;
}

export async function getDurableTanstackStartArtifactSummary(revision: string) {
  const store = getStore();
  if (!store) return null;
  if (store.getSummary) return store.getSummary(revision);
  const artifact = await store.get(revision);
  return artifact
    ? { ...artifactMetadata(artifact), html: artifact.html }
    : null;
}

export function getTanstackStartArtifactMetadata(
  artifact: TanstackStartArtifact,
) {
  return artifactMetadata(artifact);
}

export async function putDurableTanstackStartArtifact(
  artifact: TanstackStartArtifact,
) {
  await getStore()?.put(artifact);
}

export function setTanstackStartArtifactStoreForTests(
  store: TanstackStartArtifactStore | null | undefined,
) {
  testStore = store;
}
