import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterAll, expect, test } from "vitest";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { executeNextRequestArtifact, nextResponseCacheDependencies } from "../../lib/serverless-next/runtime";
import { POST } from "../../app/api/serverless/nextjs-runtime/request/route";
import { NextPrefetchTickets } from "../../lib/serverless-next/prefetch";
import type { NextRequestArtifact } from "../../lib/serverless-next/artifact";
import type { NextCacheDependencies } from "../../lib/serverless-next/cache-invalidations";
import { closeNextRscWorkerPoolForTests } from "../../lib/serverless-next/rsc-worker-pool";
import { closeNextSsrWorkerPoolForTests } from "../../lib/serverless-next/ssr-worker-pool";
import { prefetchWorkspace } from "./fixtures/prefetch-workspace";

const { recordCacheLifetime } = createRequire(import.meta.url)("../../lib/serverless-next/cache-lifetime.cjs");
const salt = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
afterAll(async () => {
  await closeNextRscWorkerPoolForTests();
  await closeNextSsrWorkerPoolForTests();
});

test("absolute lifetime reduction keeps the oldest read and never renews stale output", () => {
  const metadata: NextCacheDependencies = { complete: true, tags: [] };
  recordCacheLifetime(metadata, 1000, [false]);
  expect(metadata.expiresAt).toBeUndefined();
  recordCacheLifetime(metadata, 1000, [20, 2, 10]);
  recordCacheLifetime(metadata, 5000, [30]);
  expect(metadata.expiresAt).toBe(3000);
  recordCacheLifetime(metadata, 5000, [30], true);
  recordCacheLifetime(metadata, 6000, [30]);
  expect(metadata.expiresAt).toBe(0);
  for (const [timestamp, lifetimes] of [[NaN, [1]], [1000, []], [1000, [-1]], [1000, [undefined]]]) {
    const invalid: NextCacheDependencies = { complete: true, tags: [] };
    recordCacheLifetime(invalid, timestamp, lifetimes);
    expect(invalid.expiresAt).toBe(0);
  }
});

test("tickets and inherited models keep independent data deadlines and fail closed on malformed lifetimes", () => {
  let now = 1000;
  const tickets = new NextPrefetchTickets(() => now);
  const artifact = { workspaceKey: "lifetime-unit", revision: "one", generation: "one" } as NextRequestArtifact;
  const context = tickets.segmentContext(artifact, "owner", {});
  const root = { id: "root", key: context + ":root:one", slots: ["children"] };
  const child = { id: "child", key: context + ":child:one", slots: [] };
  const entry = { artifact, owner: "owner", key: "full", epoch: 0, body: new Uint8Array([1]), headers: [], status: 200 };
  const dependency = (expiresAt: number) => ({ complete: true, tags: ["data"], expiresAt });
  const original = tickets.issueSegments(artifact, "owner", {}, [root], undefined, dependency(8000))!;
  const inherited = tickets.resolveSegments(artifact, "owner", {}, [original]);
  now = 2000;
  const mixed = tickets.issueSegments(artifact, "owner", {}, [root, child], undefined, dependency(4000), inherited)!;
  const ticket = tickets.put({ ...entry, dependencies: dependency(4000) })!;
  expect(tickets.remaining(ticket)).toBe(2000);
  expect(mixed.ttlMs).toBe(2000);
  now = 4000;
  expect(tickets.take(ticket, artifact, "owner", "full")).toBeNull();
  expect(tickets.resolveSegments(artifact, "owner", {}, [mixed]).map(item => item.key)).toEqual([root.key]);
  now = 8000;
  expect(tickets.resolveSegments(artifact, "owner", {}, [mixed])).toEqual([]);
  for (const expiresAt of [0, NaN, Infinity, -1]) {
    expect(tickets.put({ ...entry, dependencies: dependency(expiresAt) })).toBeNull();
    expect(tickets.issueSegments(artifact, "owner", {}, [child], undefined, dependency(expiresAt))).toBeUndefined();
  }
});

async function compile(key: string, cache: "incremental" | "component", delay = 0, life = "stale:10,revalidate:1,expire:2", shell = false) {
  return compileNextRequestWorkspace([
    ...prefetchWorkspace(),
    { path: "app/lifetime-data.ts", language: "ts", content: cache === "incremental"
      ? `import {unstable_cache} from "next/cache";let reads=0;export const read=unstable_cache(async()=>++reads,["lifetime"],{revalidate:1,tags:["lifetime"]});`
      : `import {cacheLife,cacheTag} from "next/cache";let reads=0;export async function read(){"use cache";cacheLife({${life}});cacheTag("lifetime");return ++reads;}` },
    { path: "app/lifetime/page.tsx", language: "tsx", content: `import {read} from "../lifetime-data";export default async function Page(){const value=await read();await new Promise(resolve=>setTimeout(resolve,${delay}));return <output data-lifetime>{value}</output>;}` },
    ...(shell ? [{ path: "app/lifetime/loading.tsx", language: "tsx" as const, content: 'import {read} from "../lifetime-data";export default async function Loading(){return <p data-lifetime-loading>{await read()}</p>;}' }] : []),
  ], { workspaceKey: key, serverReferenceHashSalt: salt });
}
async function request(artifact: NextRequestArtifact, extra: object = {}) {
  return POST(new Request("http://tuto.local/request", { method: "POST", body: JSON.stringify({ navigation: {
    revision: artifact.revision, url: "/lifetime", kind: "push", prefetchOwner: "owner", prefetch: true, ...extra,
  } }) }));
}

for (const cache of ["incremental", "component"] as const) {
  test(`${cache} cold and aged warm reads cap full Flight TTL, reject expired tickets and preserve SWR`, async () => {
    const artifact = await compile("lifetime-full-" + cache, cache);
    const cold = await request(artifact);
    expect(cold.status).toBe(200);
    const first = await cold.json();
    expect(first.ttlMs).toBeGreaterThan(0);
    expect(first.ttlMs).toBeLessThanOrEqual(1000);
    await new Promise(resolve => setTimeout(resolve, 300));
    const aged = await (await request(artifact)).json();
    expect(aged.ttlMs).toBeLessThan(first.ttlMs - 200);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const expired = await request(artifact, { prefetch: false, prefetchTicket: aged.ticket });
    expect(expired.headers.get("x-tuto-next-prefetch")).toBe("miss");
    expect(await expired.text()).toContain('"data-lifetime":true,"children":1');
    const fresh = await request(artifact);
    expect(fresh.status).toBe(200);
    const warmed = await fresh.json();
    const hit = await request(artifact, { prefetch: false, prefetchTicket: warmed.ticket });
    expect(hit.headers.get("x-tuto-next-prefetch")).toBe("hit");
    expect(await hit.text()).toContain('"data-lifetime":true,"children":2');
    await new Promise(resolve => setTimeout(resolve, 1100));
    // Warming that serves stale output must never publish it, even though the
    // finalizer waits for the background replacement to be written.
    expect((await request(artifact)).status).toBe(204);
    expect((await request(artifact)).status).toBe(200);
  });
}

test("late streamed completion cannot restart a short data lifetime", async () => {
  const artifact = await compile("lifetime-stream", "incremental", 1200);
  expect((await request(artifact)).status).toBe(204);
});

test("cacheLife stale limits cap loading shells and model receipts, including caller metadata spoofing", async () => {
  const artifact = await compile("lifetime-shell", "component", 0, "stale:1,revalidate:10,expire:20", true);
  const warmed = await (await request(artifact, { prefetchMode: "auto", dependencies: { expiresAt: Date.now() + 999999 } })).json();
  expect(warmed.kind).toBe("shell");
  expect(warmed.ttlMs).toBeGreaterThan(0);
  expect(warmed.ttlMs).toBeLessThanOrEqual(1000);
  expect(warmed.segmentGrant.ttlMs).toBeLessThanOrEqual(1000);
  await new Promise(resolve => setTimeout(resolve, 1100));
  const expired = await request(artifact, { prefetch: false, prefetchMode: "auto", prefetchTicket: warmed.ticket,
    prefetchShell: true, prefetchShellAck: true, prefetchShellStream: true, segmentRefs: [warmed.segmentGrant] });
  expect(expired.headers.get("x-tuto-next-prefetch")).toBe("shell-stream-miss");
  expect(await expired.text()).toContain("data-lifetime-loading");
  // Data remains a normal cache hit; expiry only removes speculative reuse.
  expect((await request(artifact, { prefetchMode: "auto" })).status).toBe(204);
});

test("hard-expired cache components regenerate with a fresh data deadline for normal navigation", async () => {
  const artifact = await compile("lifetime-hard-expire", "component");
  await (await request(artifact)).json();
  await new Promise(resolve => setTimeout(resolve, 2100));
  const response = await executeNextRequestArtifact(artifact, { url: "/lifetime", stream: true,
    navigation: { kind: "push" } });
  expect(await response.text()).toContain('"data-lifetime":true,"children":2');
  expect((await nextResponseCacheDependencies(response))!.expiresAt).toBeGreaterThan(Date.now());
  expect((await request(artifact)).status).toBe(200);
});

test("cached fetch responses carry their data deadline across the host bridge", async () => {
  let reads = 0;
  const server = createServer((_, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ reads: ++reads }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as { port: number }).port;
    const artifact = await compileNextRequestWorkspace([...prefetchWorkspace(), {
      path: "app/lifetime/page.tsx", language: "tsx", content: `export default async function Page(){const data=await(await fetch("http://127.0.0.1:${port}/data",{next:{revalidate:1,tags:["fetch-lifetime"]}})).json();return <output data-lifetime>{data.reads}</output>;}`,
    }], { workspaceKey: "lifetime-fetch", serverReferenceHashSalt: salt });
    const warmed = await (await request(artifact)).json();
    expect(warmed.ttlMs).toBeGreaterThan(0);
    expect(warmed.ttlMs).toBeLessThanOrEqual(1000);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect((await request(artifact)).status).toBe(204);
    const fresh = await request(artifact);
    expect(fresh.status).toBe(200);
    expect(reads).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
