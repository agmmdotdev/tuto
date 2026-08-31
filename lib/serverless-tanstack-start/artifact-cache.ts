import { createHash } from "node:crypto";
import type { BuildDiagnostic, WorkspaceFile } from "@/lib/ide/types";
import runtimeManifest from "./runtime-manifest.generated.json";

export type TanstackStartBuildMetrics = {
  clientFrameworkInputs: number;
  clientRevisionBytes: number;
  serverFrameworkInputs: number;
  serverRevisionBytes: number;
  sharedClientKernelBytes: number;
  sharedServerKernelBytes: number;
};

export type TanstackStartPrerenderedOutput = {
  documents: Record<string, string>;
  routes: Record<string, string>;
  shell?: string;
};

export type TanstackStartArtifact = {
  buildMetrics: TanstackStartBuildMetrics;
  diagnostics: BuildDiagnostic[];
  durationMs: number;
  html: string;
  kernelId: string;
  prerendered?: TanstackStartPrerenderedOutput;
  revision: string;
  routeManifest: Record<string, { css?: string[]; preloads: string[] }>;
  rpcToken: string;
  ssrClientBundle: string;
  ssrClientChunks: Record<string, string>;
  ssrCss: string;
  ssrCssChunks: Record<string, string>;
  serverBundle: string;
  serverChunks: Record<string, string>;
  serverFnIds: string[];
  success: boolean;
};

type CacheEntry = {
  artifact: TanstackStartArtifact;
  bytes: number;
  expiresAt: number;
};

type CacheState = {
  entries: Map<string, CacheEntry>;
  totalBytes: number;
};

const globalCacheKey = Symbol.for("tuto.tanstack-start.artifact-cache.v2");
const defaultMaxEntries = 24;
const defaultMaxBytes = 32 * 1024 * 1024;
const defaultTtlMs = 10 * 60 * 1000;

function getState() {
  const globals = globalThis as typeof globalThis & {
    [globalCacheKey]?: CacheState;
  };

  globals[globalCacheKey] ??= {
    entries: new Map(),
    totalBytes: 0,
  };

  return globals[globalCacheKey];
}

function readPositiveInteger(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function limits() {
  return {
    maxBytes: readPositiveInteger(
      "TUTO_TANSTACK_ARTIFACT_CACHE_MAX_BYTES",
      defaultMaxBytes,
    ),
    maxEntries: readPositiveInteger(
      "TUTO_TANSTACK_ARTIFACT_CACHE_MAX_ENTRIES",
      defaultMaxEntries,
    ),
    ttlMs: readPositiveInteger(
      "TUTO_TANSTACK_ARTIFACT_CACHE_TTL_MS",
      defaultTtlMs,
    ),
  };
}

function artifactBytes(artifact: TanstackStartArtifact) {
  return (
    Buffer.byteLength(artifact.html) +
    Buffer.byteLength(artifact.serverBundle) +
    Buffer.byteLength(artifact.ssrClientBundle) +
    Buffer.byteLength(artifact.ssrCss) +
    Object.values(artifact.prerendered?.documents ?? {}).reduce(
      (bytes, document) => bytes + Buffer.byteLength(document),
      0,
    ) +
    Object.values(artifact.serverChunks).reduce(
      (bytes, chunk) => bytes + Buffer.byteLength(chunk),
      0,
    ) +
    Object.values(artifact.ssrCssChunks).reduce(
      (bytes, chunk) => bytes + Buffer.byteLength(chunk),
      0,
    ) +
    Object.values(artifact.ssrClientChunks).reduce(
      (bytes, chunk) => bytes + Buffer.byteLength(chunk),
      0,
    )
  );
}

function deleteEntry(state: CacheState, revision: string) {
  const existing = state.entries.get(revision);
  if (!existing) return;
  state.entries.delete(revision);
  state.totalBytes -= existing.bytes;
}

function pruneExpired(state: CacheState, now = Date.now()) {
  for (const [revision, entry] of state.entries) {
    if (entry.expiresAt <= now) deleteEntry(state, revision);
  }
}

export function createWorkspaceRevision(files: WorkspaceFile[]) {
  const canonicalFiles = files
    .map((file) => ({
      content: file.content,
      path: file.path.replaceAll("\\", "/").replace(/^\/+/, ""),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return createHash("sha256")
    .update(`runtime:${runtimeManifest.id}\n`)
    .update(JSON.stringify(canonicalFiles))
    .digest("hex");
}

export function getTanstackStartArtifact(revision: string) {
  const state = getState();
  const now = Date.now();
  pruneExpired(state, now);
  const entry = state.entries.get(revision);

  if (!entry) return null;

  // Map insertion order doubles as an LRU list.
  state.entries.delete(revision);
  state.entries.set(revision, entry);
  entry.expiresAt = now + limits().ttlMs;
  return entry.artifact;
}

export function putTanstackStartArtifact(artifact: TanstackStartArtifact) {
  const state = getState();
  const cacheLimits = limits();
  const bytes = artifactBytes(artifact);
  pruneExpired(state);
  deleteEntry(state, artifact.revision);

  if (bytes > cacheLimits.maxBytes) return false;

  state.entries.set(artifact.revision, {
    artifact,
    bytes,
    expiresAt: Date.now() + cacheLimits.ttlMs,
  });
  state.totalBytes += bytes;

  while (
    state.entries.size > cacheLimits.maxEntries ||
    state.totalBytes > cacheLimits.maxBytes
  ) {
    const oldestRevision = state.entries.keys().next().value as
      | string
      | undefined;
    if (!oldestRevision) break;
    deleteEntry(state, oldestRevision);
  }

  return state.entries.has(artifact.revision);
}

export function clearTanstackStartArtifactCache() {
  const state = getState();
  state.entries.clear();
  state.totalBytes = 0;
}

export function inspectTanstackStartArtifactCache() {
  const state = getState();
  pruneExpired(state);
  return {
    entries: state.entries.size,
    revisions: [...state.entries.keys()],
    totalBytes: state.totalBytes,
  };
}
