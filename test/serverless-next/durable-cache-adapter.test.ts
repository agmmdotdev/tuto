import { describe, expect, test } from "vitest";
import {
  createS3NextCacheAdapter,
  DurableNextCacheAdapter,
  handleNextCacheCoordinatorRequest,
  HttpNextCacheInvalidationCoordinator,
  MemoryNextCacheInvalidationCoordinator,
  MemoryNextCacheValueStore,
  S3NextCacheValueStore,
  TransactionalNextCacheInvalidationCoordinator,
  type DurableNextCacheEntry,
  type NextCacheCoordinatorStorage,
  type NextCacheValueStore,
} from "../../lib/serverless-next/durable-cache-adapter";

const workspaceKey = "durable-cache-workspace";

function durablePair(now: () => number = Date.now) {
  const coordinator = new MemoryNextCacheInvalidationCoordinator({ now });
  const values = new MemoryNextCacheValueStore();
  return {
    first: new DurableNextCacheAdapter({ coordinator, now, values }),
    second: new DurableNextCacheAdapter({ coordinator, now, values }),
  };
}

class TestCoordinatorStorage implements NextCacheCoordinatorStorage {
  private data = new Map<string, unknown>();
  private tail = Promise.resolve();

  async delete(key: string) {
    return this.data.delete(key);
  }

  async get<T>(key: string) {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T) {
    this.data.set(key, structuredClone(value));
  }

  async transaction<T>(closure: (storage: this) => Promise<T>) {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await closure(this);
    } finally {
      release();
    }
  }
}

describe("durable Next cache adapter", () => {
  test("shares values and tag invalidations across host adapter instances", async () => {
    let timestamp = 1_000;
    const { first, second } = durablePair(() => timestamp);
    await first.set({
      key: "lesson",
      tags: ["lesson-posts"],
      value: { title: "RSC" },
      workspaceKey,
    });

    expect(await second.get({ key: "lesson", workspaceKey })).toEqual({
      entry: { lastModified: 1_000, value: { title: "RSC" } },
      status: "hit",
    });

    timestamp += 1;
    await second.revalidateTags({
      durations: { expire: 3600 },
      tags: ["lesson-posts"],
      workspaceKey,
    });
    expect(await first.get({ key: "lesson", workspaceKey })).toMatchObject({
      status: "stale",
    });

    timestamp += 1;
    await first.set({
      key: "lesson",
      tags: ["lesson-posts"],
      value: { title: "Fresh RSC" },
      workspaceKey,
    });
    expect(await second.get({ key: "lesson", workspaceKey })).toMatchObject({
      entry: { value: { title: "Fresh RSC" } },
      status: "hit",
    });

    timestamp += 1;
    await second.revalidateTags({
      tags: ["lesson-posts"],
      workspaceKey,
    });
    expect(await first.get({ key: "lesson", workspaceKey })).toEqual({
      entry: null,
      status: "miss",
    });
  });

  test("uses coordinator sequence order when an older object write finishes late", async () => {
    let allowWrite!: () => void;
    let startedWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      startedWrite = resolve;
    });
    const writeAllowed = new Promise<void>((resolve) => {
      allowWrite = resolve;
    });
    let stored: DurableNextCacheEntry | null = null;
    const values: NextCacheValueStore = {
      async delete() {
        stored = null;
      },
      async get() {
        return stored;
      },
      async set(entry) {
        startedWrite();
        await writeAllowed;
        stored = entry;
      },
    };
    const coordinator = new MemoryNextCacheInvalidationCoordinator();
    const writer = new DurableNextCacheAdapter({ coordinator, values });
    const invalidator = new DurableNextCacheAdapter({ coordinator, values });
    const lock = await writer.acquireLock({
      key: "late-write",
      workspaceKey,
    });

    const pendingWrite = writer.set({
      fence: lock.fence,
      key: "late-write",
      tags: ["posts"],
      value: "old",
      workspaceKey,
    });
    await writeStarted;
    await invalidator.revalidateTags({ tags: ["posts"], workspaceKey });
    allowWrite();
    await pendingWrite;
    await writer.releaseLock(lock);

    expect(await invalidator.get({ key: "late-write", workspaceKey })).toEqual({
      entry: null,
      status: "miss",
    });
  });

  test("coordinates cache leases across host adapter instances", async () => {
    const coordinator = new MemoryNextCacheInvalidationCoordinator();
    const values = new MemoryNextCacheValueStore();
    const first = new DurableNextCacheAdapter({
      coordinator,
      lockPollMs: 5,
      lockWaitMs: 500,
      values,
    });
    const second = new DurableNextCacheAdapter({
      coordinator,
      lockPollMs: 5,
      lockWaitMs: 500,
      values,
    });
    const firstLock = await first.acquireLock({
      key: "fetch-key",
      workspaceKey,
    });
    let secondAcquired = false;
    const secondLockPromise = second
      .acquireLock({ key: "fetch-key", workspaceKey })
      .then((lock) => {
        secondAcquired = true;
        return lock;
      });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondAcquired).toBe(false);

    await first.releaseLock(firstLock);
    const secondLock = await secondLockPromise;
    expect(secondAcquired).toBe(true);
    expect(secondLock.token).not.toBe(firstLock.token);
    await second.releaseLock(secondLock);
  });

  test("grants only one in-memory lease under concurrent acquisition", async () => {
    const coordinator = new MemoryNextCacheInvalidationCoordinator();
    const leases = await Promise.all([
      coordinator.acquireLease({
        key: "same-key",
        leaseMs: 1_000,
        workspaceKey,
      }),
      coordinator.acquireLease({
        key: "same-key",
        leaseMs: 1_000,
        workspaceKey,
      }),
    ]);
    expect(leases.filter(Boolean)).toHaveLength(1);
  });

  test("persists monotonic invalidation state in transactional coordinator storage", async () => {
    const coordinator = new TransactionalNextCacheInvalidationCoordinator(
      new TestCoordinatorStorage(),
      { now: () => 2_000 },
    );
    const versions = await Promise.all(
      Array.from({ length: 8 }, () => coordinator.allocate(workspaceKey)),
    );
    expect(versions.map((version) => version.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(versions.map((version) => version.timestamp)).toEqual([
      2_000, 2_001, 2_002, 2_003, 2_004, 2_005, 2_006, 2_007,
    ]);

    const invalidation = await coordinator.revalidateTags({
      durations: { expire: 3600 },
      tags: ["posts", "authors"],
      workspaceKey,
    });
    const states = await coordinator.getTagStates({
      tags: ["posts", "authors", "absent"],
      workspaceKey,
    });
    expect(states.posts?.sequence).toBe(invalidation.sequence);
    expect(states.authors?.sequence).toBe(invalidation.sequence);
    expect(states.absent).toBeUndefined();
  });

  test("uses the authenticated HTTP protocol for a remote coordinator", async () => {
    const backend = new MemoryNextCacheInvalidationCoordinator();
    const authorization = "Bearer coordinator-secret";
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) =>
      handleNextCacheCoordinatorRequest(new Request(input, init), backend, {
        authorization,
      })) as typeof fetch;
    const coordinator = new HttpNextCacheInvalidationCoordinator({
      authorization,
      endpoint: "https://cache-coordinator.internal/v1",
      fetch: fetcher,
    });

    const version = await coordinator.allocate(workspaceKey);
    await coordinator.revalidateTags({ tags: ["remote-tag"], workspaceKey });
    const states = await coordinator.getTagStates({
      tags: ["remote-tag"],
      workspaceKey,
    });
    expect(version.sequence).toBe(1);
    expect(states["remote-tag"]?.sequence).toBe(2);

    const unauthorized = await handleNextCacheCoordinatorRequest(
      new Request("https://cache-coordinator.internal/v1", {
        body: JSON.stringify({
          input: { workspaceKey },
          operation: "allocate",
        }),
        method: "POST",
      }),
      backend,
      { authorization },
    );
    expect(unauthorized.status).toBe(401);
  });

  test("round-trips hashed cache envelopes through an R2-compatible S3 API", async () => {
    const objects = new Map<string, string>();
    const requests: Request[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push(request);
      if (request.method === "PUT") {
        objects.set(request.url, await request.text());
        return new Response(null, { status: 200 });
      }
      if (request.method === "DELETE") {
        objects.delete(request.url);
        return new Response(null, { status: 204 });
      }
      const value = objects.get(request.url);
      return value === undefined
        ? new Response(null, { status: 404 })
        : new Response(value, { status: 200 });
    }) as typeof fetch;
    const store = new S3NextCacheValueStore({
      accessKeyId: "test-access-key",
      bucket: "tuto-cache",
      endpoint: "https://account.r2.cloudflarestorage.com",
      fetch: fetcher,
      secretAccessKey: "test-secret-key",
    });
    const entry: DurableNextCacheEntry = {
      key: "next-fetch:https://example.com/private?q=1",
      sequence: 4,
      tags: ["posts"],
      timestamp: 1_234,
      value: { body: "cached" },
      version: 1,
      workspaceKey: "student-private-workspace",
    };

    await store.set(entry);
    expect(await store.get(entry)).toEqual(entry);
    expect(requests[0]?.url).not.toContain(entry.workspaceKey);
    expect(requests[0]?.url).not.toContain("example.com/private");
    expect(requests[0]?.headers.get("authorization")).toContain(
      "AWS4-HMAC-SHA256",
    );

    await store.delete(entry);
    expect(await store.get(entry)).toBeNull();
  });

  test("constructs the combined S3 adapter without embedding coordinator state in R2", () => {
    const coordinator = new MemoryNextCacheInvalidationCoordinator();
    expect(
      createS3NextCacheAdapter({
        accessKeyId: "test-access-key",
        bucket: "tuto-cache",
        coordinator,
        endpoint: "https://account.r2.cloudflarestorage.com",
        secretAccessKey: "test-secret-key",
      }),
    ).toBeInstanceOf(DurableNextCacheAdapter);
  });
});
