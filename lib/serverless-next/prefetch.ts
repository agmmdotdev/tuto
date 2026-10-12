import { createHash, randomBytes } from "node:crypto";
import type { NextRequestArtifact } from "./artifact";
import type { NextRouterState } from "./navigation";
import {
  nextCacheInvalidations,
  type NextCacheDependencies,
  type NextCacheSnapshot,
} from "./cache-invalidations";

// Standalone so the hydration transport can embed exactly the same key logic.
export function nextPrefetchKey(
  revision: string,
  url: string,
  headers: Record<string, string>,
  state?: NextRouterState,
  mode: "full" | "auto" = "full",
) {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "navigationId")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  }
  const target = new URL(url, "http://next.local");
  return JSON.stringify(
    canonical([
      revision,
      target.pathname + target.search,
      Object.fromEntries(new Headers(headers).entries()),
      state ?? null,
      mode,
    ]),
  );
}

export type NextSharedSegment = { key: string; id?: string; slots: string[] };
export type NextRetainedSegment = NextSharedSegment & {
  dependencies?: NextCacheDependencies;
  snapshot?: NextCacheSnapshot;
  expiresAt?: number;
};

type Entry = {
  artifact: NextRequestArtifact;
  owner: string;
  key: string;
  epoch: number;
  expiresAt: number;
  body: Uint8Array;
  headers: Array<[string, string]>;
  status: number;
  kind?: "full" | "shell";
  snapshot?: NextCacheSnapshot;
  dependencies?: NextCacheDependencies;
  maxExpiresAt?: number;
};

export class NextPrefetchTickets {
  private entries = new Map<string, Entry>();
  private segments = new Map<
    string,
    {
      artifact: NextRequestArtifact;
      owner: string;
      context: string;
      models: Map<string, NextRetainedSegment>;
      expiresAt: number;
    }
  >();
  private epochs = new WeakMap<NextRequestArtifact, number>();
  private workspaceVersions = new WeakMap<NextRequestArtifact, string>();
  readonly ttlMs = 30_000;
  readonly maxEntryBytes = 1024 * 1024;
  constructor(private now: () => number = Date.now) {}
  epoch(artifact: NextRequestArtifact) {
    const version = nextCacheInvalidations.generation(artifact.workspaceKey);
    const previous = this.workspaceVersions.get(artifact);
    this.workspaceVersions.set(artifact, version);
    if (previous !== undefined && previous !== version) {
      this.epochs.set(artifact, (this.epochs.get(artifact) ?? 0) + 1);
      this.drop(artifact);
    }
    return this.epochs.get(artifact) ?? 0;
  }
  invalidate(artifact: NextRequestArtifact) {
    this.epochs.set(artifact, this.epoch(artifact) + 1);
    this.drop(artifact);
  }
  private drop(artifact: NextRequestArtifact) {
    for (const [ticket, entry] of this.entries)
      if (entry.artifact === artifact) this.entries.delete(ticket);
    for (const [token, entry] of this.segments)
      if (entry.artifact === artifact) this.segments.delete(token);
  }
  segmentContext(
    artifact: NextRequestArtifact,
    owner: string,
    headers: Record<string, string>,
  ) {
    return createHash("sha256")
      .update(nextPrefetchKey(artifact.revision, "/", headers))
      .update(
        JSON.stringify([artifact.generation, owner, this.epoch(artifact)]),
      )
      .digest("hex");
  }
  // Only completed, bounded, error-free shells issue model receipts. New
  // models receive the completed shell's conservative dependency union;
  // inherited models retain their original dependencies, snapshot and expiry.
  issueSegments(
    artifact: NextRequestArtifact,
    owner: string,
    headers: Record<string, string>,
    segments: NextSharedSegment[],
    snapshot = nextCacheInvalidations.snapshot(artifact.workspaceKey),
    dependencies?: NextCacheDependencies,
    inherited: NextRetainedSegment[] = [],
  ) {
    if (
      !nextCacheInvalidations.valid(
        artifact.workspaceKey,
        snapshot,
        dependencies,
      )
    )
      return undefined;
    const context = this.segmentContext(artifact, owner, headers),
      models = new Map<string, NextRetainedSegment>();
    const validDependencies = dependencies && {
      complete:
        dependencies.complete === true &&
        Array.isArray(dependencies.tags) &&
        dependencies.tags.length <= 256 &&
        dependencies.tags.every(
          (tag) => typeof tag === "string" && tag.length <= 2048,
        ),
      tags: Array.isArray(dependencies.tags)
        ? dependencies.tags.slice(0, 256)
        : [],
    };
    for (const segment of segments) {
      if (models.size >= 16) break;
      if (
        !segment.key.startsWith(context + ":") ||
        segment.key.length > 4096 ||
        segment.slots.length > 64 ||
        (segment.id &&
          (!segment.key.startsWith(context + ":" + segment.id + ":") ||
            segment.id.length > 3900))
      )
        continue;
      const previous = inherited.find(
        (item) => item.key === segment.key && item.id === segment.id,
      );
      if (
        previous &&
        (!previous.snapshot ||
          !previous.expiresAt ||
          previous.expiresAt <= this.now() ||
          !nextCacheInvalidations.valid(
            artifact.workspaceKey,
            previous.snapshot,
            previous.dependencies,
          ))
      )
        return undefined;
      models.set(
        segment.key,
        previous
          ? { ...previous, slots: segment.slots }
          : {
              ...segment,
              snapshot: { ...snapshot },
              dependencies: validDependencies,
              expiresAt: this.now() + this.ttlMs,
            },
      );
    }
    if (!models.size) return undefined;
    for (const [token, entry] of this.segments)
      if (entry.expiresAt <= this.now()) this.segments.delete(token);
    const owned = [...this.segments].filter(
      ([, entry]) => entry.artifact === artifact && entry.owner === owner,
    );
    while (owned.length >= 8) this.segments.delete(owned.shift()![0]);
    while (this.segments.size >= 128)
      this.segments.delete(this.segments.keys().next().value!);
    const token = randomBytes(24).toString("base64url"),
      expiries = [...models.values()].map((item) => item.expiresAt!);
    this.segments.set(token, {
      artifact,
      owner,
      context,
      models,
      expiresAt: Math.max(...expiries),
    });
    return {
      token,
      keys: [...models.keys()],
      ttlMs: Math.max(0, Math.min(...expiries) - this.now()),
    };
  }
  resolveSegments(
    artifact: NextRequestArtifact,
    owner: string,
    headers: Record<string, string>,
    refs: unknown,
  ): NextRetainedSegment[] {
    if (nextCacheInvalidations.pending(artifact.workspaceKey)) return [];
    if (!Array.isArray(refs) || refs.length > 8) return [];
    const context = this.segmentContext(artifact, owner, headers),
      models = new Map<string, NextRetainedSegment>();
    for (const ref of refs) {
      if (
        !ref ||
        typeof ref.token !== "string" ||
        !Array.isArray(ref.keys) ||
        ref.keys.length > 16
      )
        continue;
      const entry = this.segments.get(ref.token);
      if (
        !entry ||
        entry.artifact !== artifact ||
        entry.owner !== owner ||
        entry.context !== context ||
        entry.expiresAt <= this.now()
      )
        continue;
      for (const key of ref.keys) {
        const model = entry.models.get(key);
        if (
          !model ||
          models.size >= 16 ||
          !model.snapshot ||
          model.expiresAt! <= this.now() ||
          !nextCacheInvalidations.valid(
            artifact.workspaceKey,
            model.snapshot,
            model.dependencies,
          )
        )
          continue;
        // Legacy unknown-metadata receipts retain conservative behavior. The
        // HTTP renderer always produces IDs and receives host-only metadata.
        models.set(
          model.id ?? key,
          model.id
            ? { ...model, slots: [...model.slots] }
            : { key: model.key, slots: [...model.slots] },
        );
      }
    }
    return [...models.values()];
  }
  put(entry: Omit<Entry, "expiresAt">) {
    if (
      entry.epoch !== this.epoch(entry.artifact) ||
      nextCacheInvalidations.pending(entry.artifact.workspaceKey) ||
      (entry.snapshot &&
        !nextCacheInvalidations.valid(
          entry.artifact.workspaceKey,
          entry.snapshot,
          entry.dependencies,
        )) ||
      (entry.maxExpiresAt !== undefined && entry.maxExpiresAt <= this.now()) ||
      entry.body.byteLength > this.maxEntryBytes
    )
      return null;
    for (const [ticket, item] of this.entries)
      if (
        item.expiresAt <= this.now() ||
        (item.artifact === entry.artifact &&
          item.owner === entry.owner &&
          item.key === entry.key)
      )
        this.entries.delete(ticket);
    // Eight entries per document; at most sixteen MiB process-wide.
    const owned = [...this.entries].filter(
      ([, item]) =>
        item.artifact === entry.artifact && item.owner === entry.owner,
    );
    while (owned.length >= 8) this.entries.delete(owned.shift()![0]);
    let bytes = [...this.entries.values()].reduce(
      (sum, item) => sum + item.body.byteLength,
      0,
    );
    while (
      this.entries.size >= 128 ||
      bytes + entry.body.byteLength > 16 * 1024 * 1024
    ) {
      const oldest = this.entries.keys().next().value!;
      bytes -= this.entries.get(oldest)!.body.byteLength;
      this.entries.delete(oldest);
    }
    const ticket = randomBytes(24).toString("base64url");
    this.entries.set(ticket, {
      ...entry,
      snapshot:
        entry.snapshot ??
        nextCacheInvalidations.snapshot(entry.artifact.workspaceKey),
      expiresAt: Math.min(
        this.now() + this.ttlMs,
        entry.maxExpiresAt ?? Infinity,
      ),
    });
    return ticket;
  }
  remaining(ticket: string) {
    return Math.max(
      0,
      (this.entries.get(ticket)?.expiresAt ?? this.now()) - this.now(),
    );
  }
  take(
    ticket: string,
    artifact: NextRequestArtifact,
    owner: string,
    key: string,
  ) {
    const entry = this.entries.get(ticket);
    if (
      !entry ||
      entry.artifact !== artifact ||
      entry.owner !== owner ||
      entry.key !== key
    )
      return null;
    this.entries.delete(ticket);
    return this.current(entry) ? entry : null;
  }
  current(entry: Entry) {
    return (
      entry.expiresAt > this.now() &&
      entry.epoch === this.epoch(entry.artifact) &&
      !!entry.snapshot &&
      nextCacheInvalidations.valid(
        entry.artifact.workspaceKey,
        entry.snapshot,
        entry.dependencies,
      )
    );
  }
}

const key = Symbol.for("tuto.serverless-next.prefetch.v3");
const globals = globalThis as typeof globalThis & {
  [key]?: NextPrefetchTickets;
};
export const nextPrefetchTickets = (globals[key] ??= new NextPrefetchTickets());
