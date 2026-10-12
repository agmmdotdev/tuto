import { afterAll, expect, test } from "vitest";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import { revalidateNextCacheTags } from "../../lib/serverless-next/cache-adapter";
import { POST } from "../../app/api/serverless/nextjs-runtime/request/route";
import { closeNextRscWorkerPoolForTests } from "../../lib/serverless-next/rsc-worker-pool";
import { closeNextSsrWorkerPoolForTests } from "../../lib/serverless-next/ssr-worker-pool";
import type { NextRequestArtifact } from "../../lib/serverless-next/artifact";
import { selectivePrefetchWorkspace } from "./fixtures/selective-prefetch-workspace";

afterAll(async () => {
  await closeNextRscWorkerPoolForTests();
  await closeNextSsrWorkerPoolForTests();
});
const compile = (key: string) =>
  compileNextRequestWorkspace(selectivePrefetchWorkspace(), {
    workspaceKey: key,
    serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  });
async function navigate(
  artifact: NextRequestArtifact,
  url: string,
  extra: object = {},
) {
  return POST(
    new Request("http://tuto.local/request", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({
        navigation: {
          revision: artifact.revision,
          url,
          kind: "push",
          prefetchOwner: "owner",
          prefetch: true,
          ...extra,
        },
      }),
    }),
  );
}
async function warm(
  artifact: NextRequestArtifact,
  url: string,
  extra: object = {},
) {
  const response = await navigate(artifact, url, extra);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ ticket: string; segmentGrant: unknown }>;
}
async function mutate(artifact: NextRequestArtifact, kind: string) {
  const response = await executeNextRequestArtifact(artifact, {
    url: "/api/revalidate",
    method: "POST",
    body: JSON.stringify({ kind }),
    headers: { "content-type": "application/json" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ kind });
}
async function consume(
  artifact: NextRequestArtifact,
  url: string,
  ticket: string,
  hit: string,
  extra: object = {},
) {
  const response = await navigate(artifact, url, {
    prefetch: false,
    prefetchTicket: ticket,
    ...extra,
  });
  expect(response.headers.get("x-tuto-next-prefetch")).toBe(hit);
  return response.text();
}

for (const kind of ["leaf", "page", "layout", "dynamic", "max"]) {
  test(`${kind} mutation preserves an unrelated full prefetch in the same workspace`, async () => {
    const artifact = await compile("selective-" + kind);
    const affected =
      kind === "layout"
        ? "/dashboard/shared/one"
        : kind === "dynamic"
          ? "/dashboard/shared/three"
          : "/dashboard/prefetched";
    const bad = await warm(artifact, affected),
      good = await warm(artifact, "/independent");
    await mutate(artifact, kind);
    await consume(artifact, affected, bad.ticket, "miss");
    expect(
      await consume(artifact, "/independent", good.ticket, "hit"),
    ).toContain('"data-independent":true,"children":1');
  });
}

test("path scope preserves Flight at another page sharing the same explicit data tag", async () => {
  const artifact = await compile("selective-path-vs-tag");
  const first = await warm(artifact, "/dashboard/prefetched"),
    second = await warm(artifact, "/also-leaf");
  await mutate(artifact, "page");
  await consume(artifact, "/dashboard/prefetched", first.ticket, "miss");
  await consume(artifact, "/also-leaf", second.ticket, "hit");
  const tagged = await warm(artifact, "/also-leaf");
  await mutate(artifact, "leaf");
  await consume(artifact, "/also-leaf", tagged.ticket, "miss");
});

test("cold and warm use-cache models retain nested tags without expiring unrelated models", async () => {
  const artifact = await compile("selective-use-cache");
  for (let i = 0; i < 2; i++) {
    const nested = await warm(artifact, "/nested-cache"),
      independent = await warm(artifact, "/independent");
    await mutate(artifact, "nested");
    await consume(artifact, "/nested-cache", nested.ticket, "miss");
    await consume(artifact, "/independent", independent.ticket, "hit");
  }
  const independent = await warm(artifact, "/independent"),
    nested = await warm(artifact, "/nested-cache");
  await mutate(artifact, "unrelated");
  await consume(artifact, "/independent", independent.ticket, "miss");
  await consume(artifact, "/nested-cache", nested.ticket, "hit");
});

test("uncached pages still carry implicit path dependencies", async () => {
  const artifact = await compile("selective-uncached");
  const plain = await warm(artifact, "/plain"),
    independent = await warm(artifact, "/independent");
  await mutate(artifact, "plain");
  await consume(artifact, "/plain", plain.ticket, "miss");
  await consume(artifact, "/independent", independent.ticket, "hit");
});

for (const related of [true, false]) {
  test(`late streamed dependencies ${related ? "reject a related" : "survive an unrelated"} mutation during prefetch`, async () => {
    const artifact = await compile("selective-race-" + related);
    const warming = navigate(artifact, "/slow");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await revalidateNextCacheTags({
      workspaceKey: artifact.workspaceKey,
      tags: [related ? "preview-leaf" : "independent"],
      durations: { expire: 0 },
    });
    const response = await warming;
    expect(response.status).toBe(related ? 204 : 200);
    if (!related)
      await consume(artifact, "/slow", (await response.json()).ticket, "hit");
  });
}

test("shell receipts preserve unrelated reuse and ignore caller dependency metadata", async () => {
  const artifact = await compile("selective-shell-fallback");
  const warmed = await warm(artifact, "/dashboard/shared/one", {
    prefetchMode: "auto",
    dependencies: { complete: true, tags: ["forged"] },
  });
  const full = await warm(artifact, "/dashboard/prefetched");
  await mutate(artifact, "unrelated");
  const response = await navigate(artifact, "/dashboard/shared/one", {
    prefetch: false,
    prefetchMode: "auto",
    prefetchTicket: warmed.ticket,
    prefetchShell: true,
    prefetchShellAck: true,
    prefetchShellStream: true,
    segmentRefs: [warmed.segmentGrant],
  });
  expect(response.headers.get("x-tuto-next-prefetch")).toBe(
    "shell-stream-hit",
  );
  expect(await response.text()).not.toContain("data-tagged-layout");
  await consume(artifact, "/dashboard/prefetched", full.ticket, "hit");
});

test("stored cache tags are collected even when another wrapper hits the same key with different tags", async () => {
  const artifact = await compile("selective-shared-key-tags");
  await consume(
    artifact,
    "/first-key",
    (await warm(artifact, "/first-key")).ticket,
    "hit",
  );
  const second = await warm(artifact, "/second-key");
  await mutate(artifact, "first-tag");
  expect(
    await consume(artifact, "/second-key", second.ticket, "miss"),
  ).toContain('"data-shared-key":true,"children":2');
});

test("a parallel slot's distinct route pattern invalidates the full prefetched model", async () => {
  const files = selectivePrefetchWorkspace();
  const handler = files.find(
    (file) => file.path === "app/api/revalidate/route.ts",
  )!;
  handler.content = handler.content.replace(
    'if(kind==="unrelated")',
    'if(kind==="slot"){revalidatePath("/dashboard/[...rest]","page");}\nelse if(kind==="unrelated")',
  );
  files.push({
    path: "app/dashboard/@team/[...rest]/page.tsx",
    language: "tsx",
    content:
      "export default function Team(){return <output data-selective-slot>team catchall</output>;}",
  });
  const artifact = await compileNextRequestWorkspace(files, {
    workspaceKey: "selective-slot-pattern",
    serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  });
  const ticket = (await warm(artifact, "/dashboard/prefetched")).ticket,
    other = (await warm(artifact, "/independent")).ticket;
  await mutate(artifact, "slot");
  expect(
    await consume(artifact, "/dashboard/prefetched", ticket, "miss"),
  ).toContain("data-selective-slot");
  await consume(artifact, "/independent", other, "hit");
});

test("auto fallback full Flight evaluates retained templates before collecting dependencies", async () => {
  const artifact = await compile("selective-auto-fallback");
  const shell = await warm(artifact, "/dashboard/shared/one", {
    prefetchMode: "auto",
  });
  const fallback = await warm(artifact, "/independent", {
    prefetchMode: "auto",
    segmentRefs: [shell.segmentGrant],
  });
  await mutate(artifact, "leaf");
  const flight = await consume(
    artifact,
    "/independent",
    fallback.ticket,
    "hit",
    { prefetchMode: "auto" },
  );
  expect(flight).toContain("data-shared-root");
  expect(flight).toContain("data-independent");
});
