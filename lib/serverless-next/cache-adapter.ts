export type NextCacheMetrics = {
  hits: number;
  misses: number;
  revalidations: number;
  staleHits: number;
  writes: number;
};

export type NextCacheEntry = {
  lastModified: number;
  value: unknown;
};

export type NextCacheGetInput = {
  key: string;
  revalidate?: number | false;
  softTags?: string[];
  tags?: string[];
  workspaceKey: string;
};

export type NextCacheGetResult = {
  entry: NextCacheEntry | null;
  status: "hit" | "miss" | "stale";
};

export type NextCacheSetInput = {
  key: string;
  tags?: string[];
  value: unknown;
  workspaceKey: string;
};

export type NextCacheRevalidateInput = {
  durations?: { expire?: number };
  tags: string[];
  workspaceKey: string;
};

export interface NextCacheAdapter {
  get(input: NextCacheGetInput): Promise<NextCacheGetResult>;
  revalidateTags(input: NextCacheRevalidateInput): Promise<void>;
  set(input: NextCacheSetInput): Promise<void>;
}

type StoredEntry = NextCacheEntry & {
  bytes: number;
  tags: string[];
};

type TagState = {
  expiredAt?: number;
  expireImmediately?: boolean;
  staleAt?: number;
};

type WorkspaceCache = {
  bytes: number;
  entries: Map<string, StoredEntry>;
  lastTimestamp: number;
  tags: Map<string, TagState>;
};

const maxEntriesPerWorkspace = 512;
const maxTagsPerWorkspace = 2_048;
const maxWorkspaceBytes = 8 * 1024 * 1024;
const maxWorkspaces = 64;

function unique(values: string[] | undefined) {
  return [...new Set(values ?? [])];
}

export class MemoryNextCacheAdapter implements NextCacheAdapter {
  private workspaces = new Map<string, WorkspaceCache>();

  private workspace(workspaceKey: string) {
    const existing = this.workspaces.get(workspaceKey);
    if (existing) {
      this.workspaces.delete(workspaceKey);
      this.workspaces.set(workspaceKey, existing);
      return existing;
    }
    const created: WorkspaceCache = {
      bytes: 0,
      entries: new Map(),
      lastTimestamp: 0,
      tags: new Map(),
    };
    this.workspaces.set(workspaceKey, created);
    while (this.workspaces.size > maxWorkspaces) {
      this.workspaces.delete(this.workspaces.keys().next().value!);
    }
    return created;
  }

  private timestamp(cache: WorkspaceCache) {
    cache.lastTimestamp = Math.max(Date.now(), cache.lastTimestamp + 1);
    return cache.lastTimestamp;
  }

  async get(input: NextCacheGetInput): Promise<NextCacheGetResult> {
    const cache = this.workspace(input.workspaceKey);
    const stored = cache.entries.get(input.key);
    if (!stored) return { entry: null, status: "miss" };

    const now = Date.now();
    const tags = unique([
      ...stored.tags,
      ...(input.tags ?? []),
      ...(input.softTags ?? []),
    ]);
    let isStale = false;
    for (const tag of tags) {
      const state = cache.tags.get(tag);
      if (!state) continue;
      if (
        state.expiredAt !== undefined &&
        (state.expireImmediately || state.expiredAt <= now) &&
        state.expiredAt >= stored.lastModified
      ) {
        cache.entries.delete(input.key);
        cache.bytes -= stored.bytes;
        return { entry: null, status: "miss" };
      }
      if (state.staleAt !== undefined && state.staleAt >= stored.lastModified) {
        isStale = true;
      }
    }
    if (
      typeof input.revalidate === "number" &&
      (now - stored.lastModified) / 1000 > input.revalidate
    ) {
      isStale = true;
    }

    cache.entries.delete(input.key);
    cache.entries.set(input.key, stored);
    return {
      entry: { lastModified: stored.lastModified, value: stored.value },
      status: isStale ? "stale" : "hit",
    };
  }

  async set(input: NextCacheSetInput) {
    const cache = this.workspace(input.workspaceKey);
    const bytes = Buffer.byteLength(JSON.stringify(input.value));
    if (bytes > maxWorkspaceBytes) return;
    const previous = cache.entries.get(input.key);
    if (previous) cache.bytes -= previous.bytes;
    cache.entries.delete(input.key);
    cache.entries.set(input.key, {
      bytes,
      lastModified: this.timestamp(cache),
      tags: unique(input.tags),
      value: input.value,
    });
    cache.bytes += bytes;
    while (
      cache.entries.size > maxEntriesPerWorkspace ||
      cache.bytes > maxWorkspaceBytes
    ) {
      const oldestKey = cache.entries.keys().next().value;
      if (!oldestKey) break;
      const oldest = cache.entries.get(oldestKey)!;
      cache.entries.delete(oldestKey);
      cache.bytes -= oldest.bytes;
    }
  }

  async revalidateTags(input: NextCacheRevalidateInput) {
    const cache = this.workspace(input.workspaceKey);
    const now = this.timestamp(cache);
    for (const tag of unique(input.tags).filter(
      (candidate) => candidate.length > 0 && candidate.length <= 256,
    )) {
      const previous = cache.tags.get(tag) ?? {};
      cache.tags.delete(tag);
      cache.tags.set(
        tag,
        input.durations
          ? {
              ...previous,
              ...(input.durations.expire === undefined
                ? {}
                : { expiredAt: now + input.durations.expire * 1000 }),
              staleAt: now,
              expireImmediately: false,
            }
          : { ...previous, expiredAt: now, expireImmediately: true },
      );
    }
    while (cache.tags.size > maxTagsPerWorkspace) {
      cache.tags.delete(cache.tags.keys().next().value!);
    }
  }

  clear() {
    this.workspaces.clear();
  }
}

const adapterKey = Symbol.for("tuto.serverless-next.cache-adapter.v1");

export function getNextCacheAdapter() {
  const globals = globalThis as typeof globalThis & {
    [adapterKey]?: NextCacheAdapter;
  };
  globals[adapterKey] ??= new MemoryNextCacheAdapter();
  return globals[adapterKey];
}

export function setNextCacheAdapter(adapter: NextCacheAdapter) {
  const globals = globalThis as typeof globalThis & {
    [adapterKey]?: NextCacheAdapter;
  };
  globals[adapterKey] = adapter;
}

export function clearNextCacheAdapterForTests() {
  const globals = globalThis as typeof globalThis & {
    [adapterKey]?: NextCacheAdapter;
  };
  if (globals[adapterKey] instanceof MemoryNextCacheAdapter) {
    globals[adapterKey].clear();
  } else {
    delete globals[adapterKey];
  }
}
