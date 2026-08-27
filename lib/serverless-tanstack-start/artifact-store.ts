import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import kernelManifest from "./kernel-manifest.generated.json";
import type { TanstackStartArtifact } from "./artifact-cache";

type ArtifactEnvelopePayload = {
  artifact: TanstackStartArtifact;
  createdAt: number;
  expiresAt: number;
  version: 1;
};

type ArtifactEnvelope = ArtifactEnvelopePayload & {
  integrity: string;
};

type ArtifactBlobStore = {
  delete(key: string): Promise<void>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

export type TanstackStartArtifactStore = {
  get(revision: string): Promise<TanstackStartArtifact | null>;
  put(artifact: TanstackStartArtifact): Promise<void>;
};

type ValidatedStoreOptions = {
  blobStore: ArtifactBlobStore;
  maxBytes?: number;
  prefix?: string;
  signingKey: string;
  ttlMs?: number;
};

type FilesystemStoreOptions = Omit<ValidatedStoreOptions, "blobStore"> & {
  root: string;
};

type S3StoreOptions = Omit<ValidatedStoreOptions, "blobStore"> & {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  region?: string;
  secretAccessKey: string;
  sessionToken?: string;
};

const defaultTtlMs = 60 * 60 * 1000;
const defaultMaxBytes = 16 * 1024 * 1024;
const defaultPrefix = "tanstack-start/artifacts";
const configuredStoreKey = Symbol.for("tuto.tanstack-start.durable-store.v1");
let testStore: TanstackStartArtifactStore | null | undefined;

function payloadJson(payload: ArtifactEnvelopePayload) {
  return JSON.stringify(payload);
}

function integrity(payload: ArtifactEnvelopePayload, signingKey: string) {
  return createHmac("sha256", signingKey)
    .update(payloadJson(payload))
    .digest("hex");
}

function equalIntegrity(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right))
    return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
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

function artifactIsValid(artifact: TanstackStartArtifact, revision: string) {
  return (
    artifact.success === true &&
    artifact.revision === revision &&
    artifact.kernelId === kernelManifest.id &&
    typeof artifact.html === "string" &&
    typeof artifact.serverBundle === "string" &&
    Array.isArray(artifact.serverFnIds)
  );
}

function createValidatedStore({
  blobStore,
  maxBytes = defaultMaxBytes,
  prefix: inputPrefix,
  signingKey,
  ttlMs = defaultTtlMs,
}: ValidatedStoreOptions): TanstackStartArtifactStore {
  if (!signingKey)
    throw new Error("A TanStack artifact signing key is required.");
  const prefix = normalizePrefix(inputPrefix);

  return {
    async get(revision) {
      const key = objectKey(prefix, revision);
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
      const payload: ArtifactEnvelopePayload = {
        artifact: envelope.artifact,
        createdAt: envelope.createdAt,
        expiresAt: envelope.expiresAt,
        version: envelope.version,
      };
      const expectedIntegrity = integrity(payload, signingKey);
      if (!equalIntegrity(envelope.integrity, expectedIntegrity)) {
        throw new Error(
          "Stored TanStack artifact failed integrity validation.",
        );
      }
      if (
        payload.version !== 1 ||
        !artifactIsValid(payload.artifact, revision)
      ) {
        throw new Error(
          "Stored TanStack artifact is incompatible with this runtime.",
        );
      }
      if (
        !Number.isSafeInteger(payload.expiresAt) ||
        payload.expiresAt <= Date.now()
      ) {
        await blobStore.delete(key).catch(() => undefined);
        return null;
      }

      return payload.artifact;
    },

    async put(artifact) {
      if (!artifactIsValid(artifact, artifact.revision)) {
        throw new Error(
          "Refusing to store an invalid TanStack Start artifact.",
        );
      }
      const payload: ArtifactEnvelopePayload = {
        artifact,
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
        version: 1,
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
      await blobStore.put(objectKey(prefix, artifact.revision), serialized);
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
    async put(key, value) {
      const target = resolveKey(key);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(temporary, value, "utf8");
      await rename(temporary, target);
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
    async put(key, value) {
      const response = await client.fetch(urlFor(key), {
        body: value,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
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
  return createValidatedStore({
    ...options,
    blobStore: createFilesystemBlobStore(options.root),
  });
}

export function createS3TanstackStartArtifactStore(options: S3StoreOptions) {
  return createValidatedStore({
    ...options,
    blobStore: createS3BlobStore(options),
  });
}

function configuredStore() {
  const mode = process.env.TUTO_TANSTACK_ARTIFACT_STORE ?? "disabled";
  if (mode === "disabled") return null;
  const signingKey = process.env.TUTO_TANSTACK_ARTIFACT_SIGNING_KEY ?? "";
  const common = {
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
