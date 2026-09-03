import { createHash, randomUUID } from "node:crypto";
import { AwsClient } from "aws4fetch";
import {
  setNextCacheAdapter,
  type NextCacheAdapter,
  type NextCacheGetInput,
  type NextCacheGetResult,
  type NextCacheLock,
  type NextCacheLockInput,
  type NextCacheRevalidateInput,
  type NextCacheSetInput,
} from "./cache-adapter";

export type NextCacheMutationVersion = {
  sequence: number;
  timestamp: number;
};

export type NextCacheTagState = NextCacheMutationVersion & {
  expireAt?: number;
  expireImmediately: boolean;
};

export type DurableNextCacheEntry = NextCacheMutationVersion & {
  key: string;
  tags: string[];
  value: unknown;
  version: 1;
  workspaceKey: string;
};

export interface NextCacheValueStore {
  delete(input: NextCacheLockInput): Promise<void>;
  get(input: NextCacheLockInput): Promise<DurableNextCacheEntry | null>;
  set(entry: DurableNextCacheEntry): Promise<void>;
}

export interface NextCacheInvalidationCoordinator {
  acquireLease(input: NextCacheLockInput & { leaseMs: number }): Promise<{
    expiresAt: number;
    fence: NextCacheMutationVersion;
    token: string;
  } | null>;
  allocate(workspaceKey: string): Promise<NextCacheMutationVersion>;
  getTagStates(input: {
    tags: string[];
    workspaceKey: string;
  }): Promise<Record<string, NextCacheTagState>>;
  releaseLease(input: NextCacheLock): Promise<void>;
  revalidateTags(
    input: NextCacheRevalidateInput,
  ): Promise<NextCacheMutationVersion>;
}

export interface NextCacheCoordinatorTransaction {
  delete(key: string): Promise<unknown>;
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface NextCacheCoordinatorStorage extends NextCacheCoordinatorTransaction {
  transaction<T>(
    closure: (transaction: NextCacheCoordinatorTransaction) => Promise<T>,
  ): Promise<T>;
}

export type DurableNextCacheAdapterOptions = {
  coordinator: NextCacheInvalidationCoordinator;
  lockLeaseMs?: number;
  lockPollMs?: number;
  lockWaitMs?: number;
  maxEntryBytes?: number;
  now?: () => number;
  values: NextCacheValueStore;
};

export type S3NextCacheValueStoreOptions = {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  fetch?: typeof fetch;
  prefix?: string;
  region?: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type S3NextCacheAdapterOptions = Omit<
  DurableNextCacheAdapterOptions,
  "values"
> &
  S3NextCacheValueStoreOptions;

export type HttpNextCacheInvalidationCoordinatorOptions = {
  authorization?: string;
  endpoint: string;
  fetch?: typeof fetch;
};

const defaultEntryBytes = 6 * 1024 * 1024;
const defaultLockLeaseMs = 15_000;
const defaultLockPollMs = 25;
const defaultLockWaitMs = 5_000;
const defaultPrefix = "next/cache/v1";

function unique(values: string[] | undefined) {
  return [...new Set(values ?? [])];
}

function cacheMapKey(input: NextCacheLockInput) {
  return `${input.workspaceKey}\0${input.key}`;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function encodedObjectPath(bucket: string, key: string) {
  return [bucket, ...key.split("/")].map(encodeURIComponent).join("/");
}

function isStoredEntry(value: unknown): value is DurableNextCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<DurableNextCacheEntry>;
  return (
    entry.version === 1 &&
    typeof entry.key === "string" &&
    typeof entry.workspaceKey === "string" &&
    typeof entry.sequence === "number" &&
    Number.isSafeInteger(entry.sequence) &&
    typeof entry.timestamp === "number" &&
    Number.isFinite(entry.timestamp) &&
    Array.isArray(entry.tags) &&
    entry.tags.every((tag) => typeof tag === "string")
  );
}

export class MemoryNextCacheValueStore implements NextCacheValueStore {
  private entries = new Map<string, DurableNextCacheEntry>();

  async delete(input: NextCacheLockInput) {
    this.entries.delete(cacheMapKey(input));
  }

  async get(input: NextCacheLockInput) {
    const entry = this.entries.get(cacheMapKey(input));
    return entry ? structuredClone(entry) : null;
  }

  async set(entry: DurableNextCacheEntry) {
    this.entries.set(cacheMapKey(entry), structuredClone(entry));
  }
}

type MemoryCoordinatorWorkspace = {
  lastTimestamp: number;
  leases: Map<
    string,
    {
      expiresAt: number;
      fence: NextCacheMutationVersion;
      token: string;
    }
  >;
  sequence: number;
  tags: Map<string, NextCacheTagState>;
};

export class MemoryNextCacheInvalidationCoordinator implements NextCacheInvalidationCoordinator {
  private readonly now: () => number;
  private workspaces = new Map<string, MemoryCoordinatorWorkspace>();

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  private workspace(workspaceKey: string) {
    const existing = this.workspaces.get(workspaceKey);
    if (existing) return existing;
    const created: MemoryCoordinatorWorkspace = {
      lastTimestamp: 0,
      leases: new Map(),
      sequence: 0,
      tags: new Map(),
    };
    this.workspaces.set(workspaceKey, created);
    return created;
  }

  private version(workspace: MemoryCoordinatorWorkspace) {
    workspace.sequence += 1;
    workspace.lastTimestamp = Math.max(this.now(), workspace.lastTimestamp + 1);
    return {
      sequence: workspace.sequence,
      timestamp: workspace.lastTimestamp,
    };
  }

  async acquireLease(input: NextCacheLockInput & { leaseMs: number }) {
    const workspace = this.workspace(input.workspaceKey);
    const now = this.now();
    const existing = workspace.leases.get(input.key);
    if (existing && existing.expiresAt > now) return null;
    const fence = this.version(workspace);
    const lease = {
      expiresAt: now + input.leaseMs,
      fence,
      token: randomUUID(),
    };
    workspace.leases.set(input.key, lease);
    return lease;
  }

  async allocate(workspaceKey: string) {
    return this.version(this.workspace(workspaceKey));
  }

  async getTagStates(input: { tags: string[]; workspaceKey: string }) {
    const tags = this.workspace(input.workspaceKey).tags;
    return Object.fromEntries(
      unique(input.tags).flatMap((tag) => {
        const state = tags.get(tag);
        return state ? [[tag, { ...state }]] : [];
      }),
    );
  }

  async releaseLease(input: NextCacheLock) {
    const leases = this.workspace(input.workspaceKey).leases;
    const current = leases.get(input.key);
    if (current?.token === input.token) leases.delete(input.key);
  }

  async revalidateTags(input: NextCacheRevalidateInput) {
    const workspace = this.workspace(input.workspaceKey);
    const version = this.version(workspace);
    for (const tag of unique(input.tags).filter(
      (candidate) => candidate.length > 0 && candidate.length <= 256,
    )) {
      workspace.tags.set(tag, {
        ...version,
        ...(input.durations?.expire === undefined
          ? {}
          : { expireAt: version.timestamp + input.durations.expire * 1000 }),
        expireImmediately:
          input.durations === undefined || input.durations.expire === 0,
      });
    }
    return version;
  }
}

type StoredCoordinatorVersion = {
  lastTimestamp: number;
  sequence: number;
};

export class TransactionalNextCacheInvalidationCoordinator implements NextCacheInvalidationCoordinator {
  private readonly now: () => number;
  private readonly storage: NextCacheCoordinatorStorage;

  constructor(
    storage: NextCacheCoordinatorStorage,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.storage = storage;
  }

  private prefix(workspaceKey: string) {
    return `workspace:${hash(workspaceKey)}`;
  }

  private async allocateIn(
    transaction: NextCacheCoordinatorTransaction,
    workspaceKey: string,
  ) {
    const key = `${this.prefix(workspaceKey)}:version`;
    const previous = await transaction.get<StoredCoordinatorVersion>(key);
    const stored = {
      lastTimestamp: Math.max(this.now(), (previous?.lastTimestamp ?? 0) + 1),
      sequence: (previous?.sequence ?? 0) + 1,
    };
    await transaction.put(key, stored);
    return { sequence: stored.sequence, timestamp: stored.lastTimestamp };
  }

  private tagKey(workspaceKey: string, tag: string) {
    return `${this.prefix(workspaceKey)}:tag:${hash(tag)}`;
  }

  private leaseKey(input: NextCacheLockInput) {
    return `${this.prefix(input.workspaceKey)}:lease:${hash(input.key)}`;
  }

  async acquireLease(input: NextCacheLockInput & { leaseMs: number }) {
    return this.storage.transaction(async (transaction) => {
      const key = this.leaseKey(input);
      const existing = await transaction.get<{
        expiresAt: number;
        token: string;
      }>(key);
      const now = this.now();
      if (existing && existing.expiresAt > now) return null;
      const lease = {
        expiresAt: now + input.leaseMs,
        fence: await this.allocateIn(transaction, input.workspaceKey),
        token: randomUUID(),
      };
      await transaction.put(key, lease);
      return lease;
    });
  }

  async allocate(workspaceKey: string) {
    return this.storage.transaction((transaction) =>
      this.allocateIn(transaction, workspaceKey),
    );
  }

  async getTagStates(input: { tags: string[]; workspaceKey: string }) {
    return this.storage.transaction(async (transaction) =>
      Object.fromEntries(
        (
          await Promise.all(
            unique(input.tags).map(
              async (tag) =>
                [
                  tag,
                  await transaction.get<NextCacheTagState>(
                    this.tagKey(input.workspaceKey, tag),
                  ),
                ] as const,
            ),
          )
        ).filter((entry): entry is [string, NextCacheTagState] =>
          Boolean(entry[1]),
        ),
      ),
    );
  }

  async releaseLease(input: NextCacheLock) {
    await this.storage.transaction(async (transaction) => {
      const key = this.leaseKey(input);
      const current = await transaction.get<{ token: string }>(key);
      if (current?.token === input.token) await transaction.delete(key);
    });
  }

  async revalidateTags(input: NextCacheRevalidateInput) {
    return this.storage.transaction(async (transaction) => {
      const version = await this.allocateIn(transaction, input.workspaceKey);
      await Promise.all(
        unique(input.tags)
          .filter(
            (candidate) => candidate.length > 0 && candidate.length <= 256,
          )
          .map((tag) =>
            transaction.put(this.tagKey(input.workspaceKey, tag), {
              ...version,
              ...(input.durations?.expire === undefined
                ? {}
                : {
                    expireAt: version.timestamp + input.durations.expire * 1000,
                  }),
              expireImmediately:
                input.durations === undefined || input.durations.expire === 0,
            } satisfies NextCacheTagState),
          ),
      );
      return version;
    });
  }
}

type CoordinatorProtocolRequest =
  | {
      input: NextCacheLockInput & { leaseMs: number };
      operation: "acquire-lease";
    }
  | { input: { workspaceKey: string }; operation: "allocate" }
  | {
      input: { tags: string[]; workspaceKey: string };
      operation: "get-tag-states";
    }
  | { input: NextCacheLock; operation: "release-lease" }
  | { input: NextCacheRevalidateInput; operation: "revalidate-tags" };

export async function handleNextCacheCoordinatorRequest(
  request: Request,
  coordinator: NextCacheInvalidationCoordinator,
  options: { authorization?: string } = {},
) {
  if (
    options.authorization &&
    request.headers.get("authorization") !== options.authorization
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const message = (await request.json()) as CoordinatorProtocolRequest;
    const value =
      message.operation === "acquire-lease"
        ? await coordinator.acquireLease(message.input)
        : message.operation === "allocate"
          ? await coordinator.allocate(message.input.workspaceKey)
          : message.operation === "get-tag-states"
            ? await coordinator.getTagStates(message.input)
            : message.operation === "release-lease"
              ? await coordinator.releaseLease(message.input)
              : message.operation === "revalidate-tags"
                ? await coordinator.revalidateTags(message.input)
                : undefined;
    if (value === undefined && message.operation !== "release-lease") {
      return Response.json({ error: "Invalid operation" }, { status: 400 });
    }
    return Response.json({ value });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export class HttpNextCacheInvalidationCoordinator implements NextCacheInvalidationCoordinator {
  private readonly authorization: string | undefined;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(options: HttpNextCacheInvalidationCoordinatorOptions) {
    this.authorization = options.authorization;
    this.endpoint = options.endpoint;
    this.fetcher = options.fetch ?? fetch;
  }

  private async call<T>(message: CoordinatorProtocolRequest): Promise<T> {
    const response = await this.fetcher(this.endpoint, {
      body: JSON.stringify(message),
      headers: {
        ...(this.authorization ? { authorization: this.authorization } : {}),
        "content-type": "application/json",
      },
      method: "POST",
    });
    const payload = (await response.json()) as { error?: string; value?: T };
    if (!response.ok) {
      throw new Error(
        payload.error ??
          `Next cache coordinator failed with HTTP ${response.status}.`,
      );
    }
    return payload.value as T;
  }

  async acquireLease(input: NextCacheLockInput & { leaseMs: number }) {
    return this.call<{
      expiresAt: number;
      fence: NextCacheMutationVersion;
      token: string;
    } | null>({
      input,
      operation: "acquire-lease",
    });
  }

  async allocate(workspaceKey: string) {
    return this.call<NextCacheMutationVersion>({
      input: { workspaceKey },
      operation: "allocate",
    });
  }

  async getTagStates(input: { tags: string[]; workspaceKey: string }) {
    return this.call<Record<string, NextCacheTagState>>({
      input,
      operation: "get-tag-states",
    });
  }

  async releaseLease(input: NextCacheLock) {
    await this.call<void>({ input, operation: "release-lease" });
  }

  async revalidateTags(input: NextCacheRevalidateInput) {
    return this.call<NextCacheMutationVersion>({
      input,
      operation: "revalidate-tags",
    });
  }
}

export class DurableNextCacheAdapter implements NextCacheAdapter {
  private readonly coordinator: NextCacheInvalidationCoordinator;
  private readonly lockLeaseMs: number;
  private readonly lockPollMs: number;
  private readonly lockWaitMs: number;
  private readonly maxEntryBytes: number;
  private readonly now: () => number;
  private readonly values: NextCacheValueStore;

  constructor(options: DurableNextCacheAdapterOptions) {
    this.coordinator = options.coordinator;
    this.lockLeaseMs = options.lockLeaseMs ?? defaultLockLeaseMs;
    this.lockPollMs = options.lockPollMs ?? defaultLockPollMs;
    this.lockWaitMs = options.lockWaitMs ?? defaultLockWaitMs;
    this.maxEntryBytes = options.maxEntryBytes ?? defaultEntryBytes;
    this.now = options.now ?? Date.now;
    this.values = options.values;
  }

  async acquireLock(input: NextCacheLockInput) {
    const deadline = this.now() + this.lockWaitMs;
    while (true) {
      const lease = await this.coordinator.acquireLease({
        ...input,
        leaseMs: this.lockLeaseMs,
      });
      if (lease) return { ...input, fence: lease.fence, token: lease.token };
      if (this.now() >= deadline) {
        throw new Error(`Timed out waiting for Next cache lock ${input.key}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.lockPollMs));
    }
  }

  async get(input: NextCacheGetInput): Promise<NextCacheGetResult> {
    const stored = await this.values.get(input);
    if (!stored) return { entry: null, status: "miss" };
    const tags = unique([
      ...stored.tags,
      ...(input.tags ?? []),
      ...(input.softTags ?? []),
    ]);
    const states = await this.coordinator.getTagStates({
      tags,
      workspaceKey: input.workspaceKey,
    });
    const now = this.now();
    let stale = false;
    for (const tag of tags) {
      const state = states[tag];
      if (!state || state.sequence < stored.sequence) continue;
      if (
        state.expireImmediately ||
        (state.expireAt !== undefined && state.expireAt <= now)
      ) {
        await this.values.delete(input);
        return { entry: null, status: "miss" };
      }
      stale = true;
    }
    if (
      typeof input.revalidate === "number" &&
      (now - stored.timestamp) / 1000 > input.revalidate
    ) {
      stale = true;
    }
    return {
      entry: { lastModified: stored.timestamp, value: stored.value },
      status: stale ? "stale" : "hit",
    };
  }

  async releaseLock(input: NextCacheLock) {
    await this.coordinator.releaseLease(input);
  }

  async revalidateTags(input: NextCacheRevalidateInput) {
    await this.coordinator.revalidateTags(input);
  }

  async set(input: NextCacheSetInput) {
    const serialized = JSON.stringify(input.value);
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized) > this.maxEntryBytes
    ) {
      return;
    }
    const version =
      input.fence ?? (await this.coordinator.allocate(input.workspaceKey));
    await this.values.set({
      ...version,
      key: input.key,
      tags: unique(input.tags),
      value: input.value,
      version: 1,
      workspaceKey: input.workspaceKey,
    });
  }
}

export class S3NextCacheValueStore implements NextCacheValueStore {
  private readonly bucket: string;
  private readonly client: AwsClient;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly prefix: string;

  constructor(options: S3NextCacheValueStoreOptions) {
    this.bucket = options.bucket;
    this.client = new AwsClient({
      accessKeyId: options.accessKeyId,
      region: options.region ?? "auto",
      secretAccessKey: options.secretAccessKey,
      service: "s3",
      sessionToken: options.sessionToken,
    });
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.fetcher = options.fetch ?? fetch;
    this.prefix = (options.prefix ?? defaultPrefix).replace(/^\/+|\/+$/g, "");
  }

  private objectKey(input: NextCacheLockInput) {
    return `${this.prefix}/${hash(input.workspaceKey)}/${hash(input.key)}.json`;
  }

  private async request(input: NextCacheLockInput, init: RequestInit) {
    const key = this.objectKey(input);
    const url = `${this.endpoint}/${encodedObjectPath(this.bucket, key)}`;
    return this.fetcher(await this.client.sign(url, init));
  }

  private async assert(response: Response, operation: string) {
    if (!response.ok) {
      throw new Error(
        `Next cache object ${operation} failed with HTTP ${response.status}.`,
      );
    }
  }

  async delete(input: NextCacheLockInput) {
    const response = await this.request(input, { method: "DELETE" });
    if (response.status !== 404) await this.assert(response, "delete");
  }

  async get(input: NextCacheLockInput) {
    const response = await this.request(input, { method: "GET" });
    if (response.status === 404) return null;
    await this.assert(response, "read");
    const parsed: unknown = JSON.parse(await response.text());
    if (
      !isStoredEntry(parsed) ||
      parsed.workspaceKey !== input.workspaceKey ||
      parsed.key !== input.key
    ) {
      throw new Error("Next cache object contains an invalid entry envelope.");
    }
    return parsed;
  }

  async set(entry: DurableNextCacheEntry) {
    const response = await this.request(entry, {
      body: JSON.stringify(entry),
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
      method: "PUT",
    });
    await this.assert(response, "write");
  }
}

export function createS3NextCacheAdapter(options: S3NextCacheAdapterOptions) {
  return new DurableNextCacheAdapter({
    coordinator: options.coordinator,
    lockLeaseMs: options.lockLeaseMs,
    lockPollMs: options.lockPollMs,
    lockWaitMs: options.lockWaitMs,
    maxEntryBytes: options.maxEntryBytes,
    now: options.now,
    values: new S3NextCacheValueStore(options),
  });
}

const configuredAdapterKey = Symbol.for(
  "tuto.serverless-next.durable-cache-configured.v1",
);

export function configureNextCacheAdapterFromEnvironment() {
  const globals = globalThis as typeof globalThis & {
    [configuredAdapterKey]?: boolean;
  };
  if (globals[configuredAdapterKey]) return;
  const mode = process.env.TUTO_NEXT_CACHE_STORE ?? "memory";
  if (mode === "memory") {
    globals[configuredAdapterKey] = true;
    return;
  }
  if (mode !== "s3") {
    throw new Error(`Unknown Next cache store mode: ${mode}.`);
  }
  const endpoint = process.env.TUTO_NEXT_CACHE_S3_ENDPOINT ?? "";
  const bucket = process.env.TUTO_NEXT_CACHE_S3_BUCKET ?? "";
  const accessKeyId = process.env.TUTO_NEXT_CACHE_S3_ACCESS_KEY_ID ?? "";
  const secretAccessKey =
    process.env.TUTO_NEXT_CACHE_S3_SECRET_ACCESS_KEY ?? "";
  const coordinatorEndpoint =
    process.env.TUTO_NEXT_CACHE_COORDINATOR_ENDPOINT ?? "";
  const coordinatorToken = process.env.TUTO_NEXT_CACHE_COORDINATOR_TOKEN ?? "";
  if (
    !endpoint ||
    !bucket ||
    !accessKeyId ||
    !secretAccessKey ||
    !coordinatorEndpoint ||
    !coordinatorToken
  ) {
    throw new Error(
      "S3 Next cache storage requires endpoint, bucket, access key, secret key, coordinator endpoint, and coordinator token.",
    );
  }
  setNextCacheAdapter(
    createS3NextCacheAdapter({
      accessKeyId,
      bucket,
      coordinator: new HttpNextCacheInvalidationCoordinator({
        authorization: `Bearer ${coordinatorToken}`,
        endpoint: coordinatorEndpoint,
      }),
      endpoint,
      prefix: process.env.TUTO_NEXT_CACHE_S3_PREFIX,
      region: process.env.TUTO_NEXT_CACHE_S3_REGION ?? "auto",
      secretAccessKey,
      sessionToken: process.env.TUTO_NEXT_CACHE_S3_SESSION_TOKEN,
    }),
  );
  globals[configuredAdapterKey] = true;
}
