import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type ServerRuntimeArtifact = {
  kernelId: string;
  revision: string;
  serverBundle: string;
  serverChunks: Record<string, string>;
  serverSources?: {
    chunks: Record<string, ServerRuntimeSource>;
    entry: ServerRuntimeSource;
  };
};

export type ServerRuntimeSource = RuntimeFile & {
  load?(): Promise<string>;
  stream?(): Promise<AsyncIterable<Uint8Array>>;
};

export class ServerRuntimeSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServerRuntimeSourceError";
  }
}

type RuntimeFile = {
  bytes: number;
  hash: string;
};

type RuntimeManifest = {
  chunks: Record<string, RuntimeFile>;
  entry: RuntimeFile;
  kernelId: string;
  revision: string;
  version: 1;
};

export type ServerRuntimeLease = {
  entryHash: string;
  entryPath: string;
  kernelId: string;
  release(): Promise<void>;
  revision: string;
};

export type ServerRuntimeStoreOptions = {
  cleanupGraceMs?: number;
  maxBytes?: number;
  maxRevisions?: number;
  root?: string;
};

type RevisionInfo = {
  manifest: RuntimeManifest;
  modifiedAt: number;
  path: string;
  pinned: boolean;
  runtimeId: string;
};

const chunkNamePattern = /^chunks\/[A-Za-z0-9_-]+\.js$/;
const manifestFilename = "manifest.json";
const defaultCleanupGraceMs = 30_000;
const defaultMaxBytes = 64 * 1024 * 1024;
const defaultMaxRevisions = 24;
const globalStoreKey = Symbol.for("tuto.tanstack-start.server-runtime-store.v2");

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : fallback;
}

function environmentInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return positiveInteger(value, fallback);
}

function sha256(source: string | Buffer) {
  return createHash("sha256").update(source).digest("hex");
}

function fileDescriptor(source: string): RuntimeFile {
  return {
    bytes: Buffer.byteLength(source),
    hash: sha256(source),
  };
}

function sourceDescriptor(source: ServerRuntimeSource): RuntimeFile {
  if (
    !Number.isSafeInteger(source.bytes) ||
    source.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(source.hash) ||
    (typeof source.load !== "function" && typeof source.stream !== "function")
  ) {
    throw new Error("Invalid TanStack Start runtime source descriptor.");
  }
  return { bytes: source.bytes, hash: source.hash };
}

async function* sourceChunks(source: ServerRuntimeSource) {
  try {
    if (source.stream) {
      yield* await source.stream();
    } else {
      yield Buffer.from(await source.load!());
    }
  } catch (error) {
    throw new ServerRuntimeSourceError(
      `Runtime source ${source.hash} could not be read.`,
      { cause: error },
    );
  }
}

function errorCode(error: unknown) {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function runtimeManifest(artifact: ServerRuntimeArtifact): RuntimeManifest {
  if (!/^[a-f0-9]{64}$/.test(artifact.revision)) {
    throw new Error("Invalid TanStack Start artifact revision.");
  }
  if (!/^[a-f0-9]{20}$/.test(artifact.kernelId)) {
    throw new Error("Invalid TanStack Start kernel id.");
  }

  const deferred = artifact.serverSources;
  const chunks = Object.fromEntries(
    Object.entries(deferred?.chunks ?? artifact.serverChunks)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, source]) => {
        if (!chunkNamePattern.test(name)) {
          throw new Error("Invalid TanStack Start server chunk name.");
        }
        return [
          name,
          typeof source === "string"
            ? fileDescriptor(source)
            : sourceDescriptor(source),
        ];
      }),
  );

  return {
    chunks,
    entry: deferred
      ? sourceDescriptor(deferred.entry)
      : fileDescriptor(artifact.serverBundle),
    kernelId: artifact.kernelId,
    revision: artifact.revision,
    version: 1,
  };
}

function manifestEquals(left: RuntimeManifest, right: RuntimeManifest) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function runtimeId(manifest: RuntimeManifest) {
  return sha256(JSON.stringify(manifest));
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function touch(filePath: string) {
  const now = new Date();
  await utimes(filePath, now, now);
}

function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

export class ServerRuntimeStore {
  readonly root: string;
  private readonly blobsRoot: string;
  private readonly cleanupGraceMs: number;
  private readonly maxBytes: number;
  private readonly maxRevisions: number;
  private operation = Promise.resolve();
  private readonly revisionsRoot: string;
  private readonly temporaryRoot: string;
  private readonly verifiedRevisions = new Set<string>();

  constructor(options: ServerRuntimeStoreOptions = {}) {
    this.root = path.resolve(
      options.root ??
        process.env.TUTO_TANSTACK_SERVER_RUNTIME_ROOT ??
        path.join(tmpdir(), "tuto-tanstack-start-runtime-v2"),
    );
    this.blobsRoot = path.join(this.root, "blobs");
    this.revisionsRoot = path.join(this.root, "revisions");
    this.temporaryRoot = path.join(this.root, "tmp");
    this.cleanupGraceMs = nonNegativeInteger(
      options.cleanupGraceMs,
      defaultCleanupGraceMs,
    );
    this.maxBytes = positiveInteger(options.maxBytes, defaultMaxBytes);
    this.maxRevisions = positiveInteger(
      options.maxRevisions,
      defaultMaxRevisions,
    );
  }

  private runExclusive<T>(operation: () => Promise<T>) {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async initialize() {
    await Promise.all([
      mkdir(this.blobsRoot, { recursive: true }),
      mkdir(this.revisionsRoot, { recursive: true }),
      mkdir(this.temporaryRoot, { recursive: true }),
    ]);
    const markerPath = path.join(this.root, ".tuto-start-runtime-v2");
    if (!(await pathExists(markerPath))) {
      await writeFile(markerPath, "immutable runtime cache\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o444,
      }).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
    }
  }

  private blobPath(hash: string) {
    return path.join(this.blobsRoot, `${hash}.js`);
  }

  private revisionPath(id: string) {
    return path.join(this.revisionsRoot, id);
  }

  private async verifyBlob(filePath: string, descriptor: RuntimeFile) {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size !== descriptor.bytes) {
      throw new Error(`Runtime blob ${descriptor.hash} failed size validation.`);
    }
    const contents = await readFile(filePath);
    if (sha256(contents) !== descriptor.hash) {
      throw new Error(
        `Runtime blob ${descriptor.hash} failed integrity validation.`,
      );
    }
  }

  private async materializeBlob(
    source: string | ServerRuntimeSource,
    descriptor: RuntimeFile,
  ) {
    const destination = this.blobPath(descriptor.hash);
    if (await pathExists(destination)) {
      await this.verifyBlob(destination, descriptor);
      return destination;
    }

    const temporaryPath = path.join(
      this.temporaryRoot,
      `${descriptor.hash}-${process.pid}-${randomUUID()}.tmp`,
    );
    try {
      if (typeof source === "string") {
        await writeFile(temporaryPath, source, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o444,
        });
      } else {
        const temporary = await open(temporaryPath, "wx", 0o444);
        const hash = createHash("sha256");
        let bytes = 0;
        try {
          for await (const chunk of sourceChunks(source)) {
            if (!(chunk instanceof Uint8Array)) {
              throw new ServerRuntimeSourceError(
                `Runtime source ${descriptor.hash} returned an invalid chunk.`,
              );
            }
            bytes += chunk.byteLength;
            if (bytes > descriptor.bytes) {
              throw new ServerRuntimeSourceError(
                `Runtime source ${descriptor.hash} failed size validation.`,
              );
            }
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.byteLength) {
              const { bytesWritten } = await temporary.write(
                chunk,
                offset,
                chunk.byteLength - offset,
              );
              if (bytesWritten === 0) {
                throw new Error("Unable to write TanStack runtime source.");
              }
              offset += bytesWritten;
            }
          }
        } finally {
          await temporary.close();
        }
        if (bytes !== descriptor.bytes || hash.digest("hex") !== descriptor.hash) {
          throw new ServerRuntimeSourceError(
            `Runtime source ${descriptor.hash} failed integrity validation.`,
          );
        }
      }
      await link(temporaryPath, destination);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      await this.verifyBlob(destination, descriptor);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return destination;
  }

  private async readManifest(revisionPath: string) {
    const serialized = await readFile(
      path.join(revisionPath, manifestFilename),
      "utf8",
    );
    return JSON.parse(serialized) as RuntimeManifest;
  }

  private async validateRevision(
    revisionPath: string,
    expected: RuntimeManifest,
    expectedRuntimeId: string,
  ) {
    const stored = await this.readManifest(revisionPath);
    if (!manifestEquals(stored, expected)) {
      throw new Error(
        `Runtime ${expectedRuntimeId} does not match its content manifest.`,
      );
    }
    const entryPath = path.join(revisionPath, "entry.mjs");
    if (!this.verifiedRevisions.has(expectedRuntimeId)) {
      await this.verifyBlob(entryPath, expected.entry);
      await Promise.all(
        Object.entries(expected.chunks).map(([name, descriptor]) =>
          this.verifyBlob(path.join(revisionPath, name), descriptor),
        ),
      );
      this.verifiedRevisions.add(expectedRuntimeId);
    }
    return entryPath;
  }

  private async materializeRevision(
    artifact: ServerRuntimeArtifact,
    manifest: RuntimeManifest,
    id: string,
  ) {
    const revisionPath = this.revisionPath(id);
    if (await pathExists(revisionPath)) {
      return this.validateRevision(revisionPath, manifest, id);
    }

    const deferred = artifact.serverSources;
    const entryBlob = await this.materializeBlob(
      deferred?.entry ?? artifact.serverBundle,
      manifest.entry,
    );
    const chunkBlobs = new Map<string, string>();
    for (const [name, descriptor] of Object.entries(manifest.chunks)) {
      chunkBlobs.set(
        name,
        await this.materializeBlob(
          deferred?.chunks[name] ?? artifact.serverChunks[name]!,
          descriptor,
        ),
      );
    }

    const stagingPath = path.join(
      this.revisionsRoot,
      `.${id}-${process.pid}-${randomUUID()}.tmp`,
    );
    let published = false;
    await mkdir(path.join(stagingPath, "chunks"), { recursive: true });
    try {
      await link(entryBlob, path.join(stagingPath, "entry.mjs"));
      await Promise.all(
        [...chunkBlobs].map(([name, blobPath]) =>
          link(blobPath, path.join(stagingPath, name)),
        ),
      );
      await writeFile(
        path.join(stagingPath, manifestFilename),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: "utf8", mode: 0o444 },
      );
      try {
        await rename(stagingPath, revisionPath);
        published = true;
      } catch (error) {
        if (!new Set(["EEXIST", "ENOTEMPTY"]).has(errorCode(error) ?? "")) {
          throw error;
        }
        await rm(stagingPath, { force: true, recursive: true });
      }
    } catch (error) {
      await rm(stagingPath, { force: true, recursive: true });
      throw error;
    }

    if (published) {
      this.verifiedRevisions.add(id);
      return path.join(revisionPath, "entry.mjs");
    }
    return this.validateRevision(revisionPath, manifest, id);
  }

  private async revisionIsPinned(revisionPath: string) {
    const pinsPath = path.join(revisionPath, ".pins");
    let pinNames: string[];
    try {
      pinNames = await readdir(pinsPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }

    let pinned = false;
    for (const pinName of pinNames) {
      const pid = Number.parseInt(pinName.split("-")[0] ?? "", 10);
      if (processIsAlive(pid)) {
        pinned = true;
      } else {
        await rm(path.join(pinsPath, pinName), { force: true });
      }
    }
    return pinned;
  }

  private async revisionInfos() {
    const entries = await readdir(this.revisionsRoot, { withFileTypes: true });
    const infos: RevisionInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const revisionPath = this.revisionPath(entry.name);
      try {
        const [manifest, revisionStat, pinned] = await Promise.all([
          this.readManifest(revisionPath),
          stat(revisionPath),
          this.revisionIsPinned(revisionPath),
        ]);
        infos.push({
          manifest,
          modifiedAt: revisionStat.mtimeMs,
          path: revisionPath,
          pinned,
          runtimeId: entry.name,
        });
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    return infos;
  }

  private uniqueBytes(infos: RevisionInfo[]) {
    const blobs = new Map<string, number>();
    for (const { manifest } of infos) {
      blobs.set(manifest.entry.hash, manifest.entry.bytes);
      for (const chunk of Object.values(manifest.chunks)) {
        blobs.set(chunk.hash, chunk.bytes);
      }
    }
    return [...blobs.values()].reduce((total, bytes) => total + bytes, 0);
  }

  private async collectUnusedBlobs(infos: RevisionInfo[]) {
    const referenced = new Set<string>();
    for (const { manifest } of infos) {
      referenced.add(manifest.entry.hash);
      for (const chunk of Object.values(manifest.chunks)) {
        referenced.add(chunk.hash);
      }
    }

    const entries = await readdir(this.blobsRoot, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const hash = entry.name.match(/^([a-f0-9]{64})\.js$/)?.[1];
        if (!entry.isFile() || !hash || referenced.has(hash)) return;
        const blobPath = path.join(this.blobsRoot, entry.name);
        const blobStat = await stat(blobPath);
        if (blobStat.nlink === 1) await rm(blobPath, { force: true });
      }),
    );
  }

  private async pruneUnlocked() {
    let infos = await this.revisionInfos();
    const now = Date.now();
    while (
      infos.length > this.maxRevisions ||
      this.uniqueBytes(infos) > this.maxBytes
    ) {
      const candidate = infos
        .filter(
          (info) =>
            !info.pinned && now - info.modifiedAt >= this.cleanupGraceMs,
        )
        .sort((left, right) => left.modifiedAt - right.modifiedAt)[0];
      if (!candidate) break;
      await rm(candidate.path, { force: true, recursive: true });
      this.verifiedRevisions.delete(candidate.runtimeId);
      infos = infos.filter((info) => info !== candidate);
    }
    await this.collectUnusedBlobs(infos);
  }

  acquire(artifact: ServerRuntimeArtifact) {
    return this.runExclusive(async (): Promise<ServerRuntimeLease> => {
      await this.initialize();
      const manifest = runtimeManifest(artifact);
      const id = runtimeId(manifest);
      const entryPath = await this.materializeRevision(artifact, manifest, id);
      const revisionPath = this.revisionPath(id);
      const pinsPath = path.join(revisionPath, ".pins");
      await mkdir(pinsPath, { recursive: true });
      const pinPath = path.join(
        pinsPath,
        `${process.pid}-${randomUUID()}.pin`,
      );
      await writeFile(pinPath, `${Date.now()}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o400,
      });
      await touch(revisionPath);
      await this.pruneUnlocked();

      let released = false;
      return {
        entryHash: manifest.entry.hash,
        entryPath,
        kernelId: artifact.kernelId,
        release: async () => {
          if (released) return;
          released = true;
          await this.runExclusive(async () => {
            await rm(pinPath, { force: true });
            if (await pathExists(revisionPath)) await touch(revisionPath);
          });
        },
        revision: artifact.revision,
      };
    });
  }

  prune() {
    return this.runExclusive(async () => {
      await this.initialize();
      await this.pruneUnlocked();
    });
  }

  inspect() {
    return this.runExclusive(async () => {
      await this.initialize();
      const infos = await this.revisionInfos();
      const blobEntries = await readdir(this.blobsRoot, {
        withFileTypes: true,
      });
      return {
        blobs: blobEntries.filter(
          (entry) => entry.isFile() && /^[a-f0-9]{64}\.js$/.test(entry.name),
        ).length,
        bytes: this.uniqueBytes(infos),
        pinnedRevisions: infos.filter((info) => info.pinned).length,
        revisions: infos.length,
      };
    });
  }
}

export function serverRuntimeHasEntry(artifact: ServerRuntimeArtifact) {
  return artifact.serverSources
    ? artifact.serverSources.entry.bytes > 0
    : artifact.serverBundle.length > 0;
}

function createConfiguredStore() {
  return new ServerRuntimeStore({
    maxBytes: environmentInteger(
      "TUTO_TANSTACK_SERVER_RUNTIME_MAX_BYTES",
      defaultMaxBytes,
    ),
    maxRevisions: environmentInteger(
      "TUTO_TANSTACK_SERVER_RUNTIME_MAX_REVISIONS",
      defaultMaxRevisions,
    ),
  });
}

export function getServerRuntimeStore() {
  const globals = globalThis as typeof globalThis & {
    [globalStoreKey]?: ServerRuntimeStore;
  };
  globals[globalStoreKey] ??= createConfiguredStore();
  return globals[globalStoreKey];
}

export function clearServerRuntimeStoreForTests() {
  const globals = globalThis as typeof globalThis & {
    [globalStoreKey]?: ServerRuntimeStore;
  };
  delete globals[globalStoreKey];
}
