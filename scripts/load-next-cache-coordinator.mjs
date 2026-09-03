import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

function option(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
  );
}

function summarize(values) {
  return {
    meanMs: values.reduce((total, value) => total + value, 0) / values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parsePositiveInteger(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return value;
}

function parseNonNegativeInteger(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer.`);
  }
  return value;
}

async function runPool(count, concurrency, task) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      while (true) {
        const index = next++;
        if (index >= count) return;
        await task(index);
      }
    }),
  );
}

export async function runLoadTest({
  allocations = 200,
  concurrency = 32,
  endpoints,
  minColos = 0,
  token,
}) {
  const colos = new Set();
  const latencies = [];
  let cursor = 0;

  async function call(operation, input) {
    const endpoint = endpoints[cursor++ % endpoints.length];
    const startedAt = performance.now();
    const response = await fetch(endpoint, {
      body: JSON.stringify({ input, operation }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    latencies.push(performance.now() - startedAt);
    const ray = response.headers.get("cf-ray");
    if (ray?.includes("-")) colos.add(ray.split("-").at(-1));
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(
        `${operation} failed with HTTP ${response.status}: ${payload.error ?? "unknown error"}`,
      );
    }
    return payload.value;
  }

  const runId = `${Date.now()}-${randomUUID()}`;
  const sequenceWorkspace = `load:sequence:${runId}`;
  const startedAt = performance.now();
  const versions = Array(allocations);
  await runPool(allocations, concurrency, async (index) => {
    versions[index] = await call("allocate", {
      workspaceKey: sequenceWorkspace,
    });
  });
  const elapsedMs = performance.now() - startedAt;
  const sequences = versions
    .map((version) => version.sequence)
    .sort((a, b) => a - b);
  assert(
    sequences.every((sequence, index) => sequence === index + 1),
    `Concurrent allocation was not gap-free and monotonic: ${sequences.join(", ")}`,
  );

  const leaseWorkspace = `load:lease:${runId}`;
  const leaseInput = {
    key: "contended-render",
    leaseMs: 30_000,
    workspaceKey: leaseWorkspace,
  };
  const attempts = await Promise.all(
    Array.from({ length: concurrency }, () =>
      call("acquire-lease", leaseInput),
    ),
  );
  const winners = attempts.filter(Boolean);
  assert(
    winners.length === 1,
    `Expected one lease winner, received ${winners.length}.`,
  );
  const firstLease = winners[0];
  const invalidation = await call("revalidate-tags", {
    tags: ["lesson-posts"],
    workspaceKey: leaseWorkspace,
  });
  assert(
    invalidation.sequence > firstLease.fence.sequence,
    "Invalidation did not fence the in-flight writer.",
  );
  const states = await call("get-tag-states", {
    tags: ["lesson-posts"],
    workspaceKey: leaseWorkspace,
  });
  assert(
    states["lesson-posts"]?.sequence === invalidation.sequence,
    "A subsequent ingress did not observe the invalidation.",
  );
  await call("release-lease", { ...leaseInput, ...firstLease });
  const secondLease = await call("acquire-lease", leaseInput);
  assert(secondLease, "A released lease could not be reacquired.");
  assert(
    secondLease.fence.sequence > invalidation.sequence,
    "The next writer fence did not advance beyond invalidation.",
  );
  await call("release-lease", { ...leaseInput, ...secondLease });
  assert(
    colos.size >= minColos,
    `Expected at least ${minColos} Cloudflare colos, observed ${colos.size}: ${[
      ...colos,
    ].join(", ")}`,
  );

  return {
    allocations,
    allocationRequestsPerSecond: allocations / (elapsedMs / 1_000),
    colos: [...colos].sort(),
    concurrency,
    endpoints: endpoints.length,
    minColos,
    latency: summarize(latencies),
    protocolRequests: latencies.length,
    tests: {
      invalidationFencing: "passed",
      leaseContention: "passed",
      monotonicAllocation: "passed",
    },
  };
}

async function main() {
  const endpoints = option(
    "endpoints",
    process.env.TUTO_NEXT_CACHE_COORDINATOR_ENDPOINTS ?? "",
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const token = option(
    "token",
    process.env.TUTO_NEXT_CACHE_COORDINATOR_TOKEN ?? "",
  );
  if (endpoints.length === 0 || !token) {
    throw new Error(
      "Set TUTO_NEXT_CACHE_COORDINATOR_ENDPOINTS and TUTO_NEXT_CACHE_COORDINATOR_TOKEN.",
    );
  }
  const result = await runLoadTest({
    allocations: parsePositiveInteger("allocations", 200),
    concurrency: parsePositiveInteger("concurrency", 32),
    endpoints,
    minColos: parseNonNegativeInteger("min-colos", 0),
    token,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
