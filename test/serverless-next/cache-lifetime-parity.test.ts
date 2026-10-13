import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import type { NextRequestArtifact } from "../../lib/serverless-next/artifact";
import { POST } from "../../app/api/serverless/nextjs-runtime/request/route";
import { closeNextRscWorkerPoolForTests } from "../../lib/serverless-next/rsc-worker-pool";
import { closeNextSsrWorkerPoolForTests } from "../../lib/serverless-next/ssr-worker-pool";
import { cacheLifetimeParityWorkspace } from "./fixtures/cache-lifetime-parity-workspace";

const runId = randomUUID();
const stock = process.env.TUTO_NEXT_CACHE_LIFETIME_STOCK_ORIGIN;
const salt = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Value = { id: string; value: number; inner?: Value };
afterAll(async () => {
  await closeNextRscWorkerPoolForTests();
  await closeNextSsrWorkerPoolForTests();
});

for (const target of ["tuto", "stock"] as const) {
  const check = test.skipIf(target === "stock" && !stock);
  let artifact: Promise<NextRequestArtifact> | undefined;
  const compiled = () => artifact ??= compileNextRequestWorkspace(cacheLifetimeParityWorkspace(), {
    workspaceKey: "cache-lifetime-parity", serverReferenceHashSalt: salt,
  });
  async function probe(kind: string, id: string, tenant = "one") {
    const path = "/api/probe?" + new URLSearchParams({ kind, id, tenant, origin: stock ?? "" });
    const response = target === "stock" ? await fetch(stock! + path) : await executeNextRequestArtifact(await compiled(), { url: path });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }
  test.skipIf(!stock)(`${target}: cached fetch short TTL matches incremental stale-while-revalidate semantics`, async () => {
    const id = target + "-fetch-" + runId;
    const cold: Value = await probe("fetch", id);
    expect(cold.value).toBe(1);
    expect(await probe("fetch", id)).toEqual(cold);
    await pause(1150);
    expect(await probe("fetch", id)).toEqual(cold);
    await pause(150);
    await expect.poll(async () => (await probe("fetch", id)).value).toBeGreaterThan(cold.value);
    const refreshed = await probe("fetch", id);
    expect(await probe("fetch", id)).toEqual(refreshed);
  });
  check(`${target}: unstable_cache short TTL serves stale once and refreshes`, async () => {
    const id = target + "-incremental-" + runId;
    const cold: Value = await probe("incremental", id);
    expect(cold.value).toBe(1);
    expect(await probe("incremental", id)).toEqual(cold);
    await pause(1150);
    expect(await probe("incremental", id)).toEqual(cold);
    // Stock ends the HTTP response before its background write. Give that
    // fill time to settle; polling immediately would itself trigger more
    // request-local refreshes and skip observing the first replacement.
    await pause(150);
    await expect.poll(async () => (await probe("incremental", id)).value).toBeGreaterThan(cold.value);
    const refreshed = await probe("incremental", id);
    expect(await probe("incremental", id)).toEqual(refreshed);
  });
  check(`${target}: Cache Components natural revalidation follows the selected handler policy`, async () => {
    const id = target + "-component-" + runId;
    const cold: Value = await probe("component", id);
    expect(cold.value).toBe(1);
    expect(await probe("component", id)).toEqual(cold);
    await pause(1150);
    const aged: Value = await probe("component", id);
    // Stock production's built-in memory handler drops naturally stale values;
    // Tuto's host-backed handler supports Next's background refresh path.
    expect(aged.value).toBe(target === "stock" ? 2 : 1);
    await expect.poll(async () => (await probe("component", id)).value).toBe(2);
  });
  check(`${target}: client stale time does not expire the server data value`, async () => {
    const id = target + "-stale-" + runId;
    const cold: Value = await probe("stale", id);
    await pause(1150);
    expect(await probe("stale", id)).toEqual(cold);
  });
  check(`${target}: hard expiration regenerates before returning`, async () => {
    const id = target + "-expired-" + runId;
    expect((await probe("component", id)).value).toBe(1);
    await pause(3150);
    expect((await probe("component", id)).value).toBe(2);
  });
  check(`${target}: nested implicit lifetimes propagate and refresh descendants`, async () => {
    const id = target + "-inherited-" + runId;
    const cold: Value = await probe("inherited", id);
    expect(cold.inner?.value).toBe(1);
    expect(await probe("inherited", id)).toEqual(cold);
    await pause(1150);
    const aged: Value = await probe("inherited", id);
    expect(aged.inner?.value).toBe(target === "stock" ? 2 : 1);
    await expect.poll(async () => (await probe("inherited", id)).inner.value).toBe(2);
  });
  check(`${target}: explicit outer lifetime keeps a cached descendant snapshot`, async () => {
    const id = target + "-explicit-" + runId;
    const cold: Value = await probe("explicit", id);
    await pause(1150);
    expect(await probe("explicit", id)).toEqual(cold);
    // A direct read refreshes that child's separate entry; the outer cache is
    // still valid and retains its prior snapshot by explicit cacheLife choice.
    await probe("component", id);
    await expect.poll(async () => (await probe("component", id)).value).toBe(2);
    expect(await probe("explicit", id)).toEqual(cold);
  });
  check(`${target}: overlapping nested fills share one child without mixing parent keys`, async () => {
    const id = target + "-nested-parallel-" + runId;
    const cold: Value[] = await probe("nested-parallel", id);
    expect(cold.map(value => value.value)).toEqual([1, 1, 1]);
    expect(cold.map(value => value.inner?.value)).toEqual([1, 1, 1]);
    expect(cold[0]).toEqual(cold[2]);
    expect(cold[0].id).not.toBe(cold[1].id);
    expect(cold[0].inner).toEqual(cold[1].inner);
    expect(await probe("nested-parallel", id)).toEqual(cold);
  });
  check(`${target}: argument partitions deduplicate independently and isolate tenants`, async () => {
    const tenant = target + "-partition-" + runId;
    const first: Value[] = await probe("partitions", "unused", tenant + "-one");
    const other: Value[] = await probe("partitions", "unused", tenant + "-two");
    expect(first.map(value => value.value)).toEqual([1, 1, 1]);
    expect(other.map(value => value.value)).toEqual([1, 1, 1]);
    expect(first[0]).toEqual(first[1]);
    expect(first[0].id).not.toBe(first[2].id);
    expect(first[0].id).not.toBe(other[0].id);
    expect(await probe("partitions", "unused", tenant + "-one")).toEqual(first);
  });
}

test("explicit nested cacheLife keeps Tuto warming conservative on a fill and uses the outer value lifetime on a hit", async () => {
  const artifact = await compileNextRequestWorkspace(cacheLifetimeParityWorkspace(), { workspaceKey: "nested-speculative-parity", serverReferenceHashSalt: salt });
  const url = "/show/explicit/one";
  async function warm() {
    return POST(new Request("http://tuto.local/request", { method: "POST", body: JSON.stringify({ navigation: {
      revision: artifact.revision, url, kind: "push", prefetch: true, prefetchOwner: "parity-owner",
    } }) }));
  }
  const cold = await (await warm()).json();
  expect(cold.ttlMs).toBeGreaterThan(0);
  expect(cold.ttlMs).toBeLessThanOrEqual(1000);
  await pause(1150);
  const warmHit = await (await warm()).json();
  expect(warmHit.ttlMs).toBeGreaterThan(27_000);
  expect(warmHit.ttlMs).toBeLessThanOrEqual(30_000);
});

test("short cache fills finish while a streamed response is backpressured between host pulls", async () => {
  const artifact = await compileNextRequestWorkspace([...cacheLifetimeParityWorkspace(), {
    path: "app/stream-gap/page.tsx", language: "tsx", content: `import {Suspense} from "react";import {cacheLife} from "next/cache";
async function Fast({delay}){await new Promise(resolve=>setTimeout(resolve,delay));return <p data-fast>fast:{delay}</p>;}
async function Card(){"use cache";cacheLife({stale:1,revalidate:1,expire:3});await new Promise(resolve=>setTimeout(resolve,350));return <p data-cache-fill>completed</p>;}
export default function Page(){return <><h1 data-shell>shell</h1><Suspense fallback="fast one"><Fast delay={20} /></Suspense><Suspense fallback="fast two"><Fast delay={40} /></Suspense><Suspense fallback="cache loading"><Card /></Suspense></>;}`,
  }], { workspaceKey: "cache-fill-backpressure", serverReferenceHashSalt: salt });
  const response = await executeNextRequestArtifact(artifact, { url: "/stream-gap", stream: true, navigation: { kind: "push" } });
  const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
  try {
    const first = await reader.read();
    expect(first.done).toBe(false);
    chunks.push(first.value!);
    // The stream's one-chunk queue fills with an early Suspense result. The
    // cached descendant finishes while no stream-control HTTP call is active.
    await pause(800);
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
    }
    const flight = Buffer.concat(chunks).toString();
    expect(flight).toContain('"data-cache-fill":true,"children":"completed"');
    expect(flight).not.toMatch(/(?:^|\n)[0-9a-f]+:E\{/);
  } finally { await reader.cancel().catch(() => {}); }
});
