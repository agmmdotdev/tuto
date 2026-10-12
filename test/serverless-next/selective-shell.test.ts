import { afterAll, expect, test } from "vitest";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import { POST } from "../../app/api/serverless/nextjs-runtime/request/route";
import {
  NextPrefetchTickets,
  type NextSharedSegment,
} from "../../lib/serverless-next/prefetch";
import { nextCacheInvalidations } from "../../lib/serverless-next/cache-invalidations";
import { revalidateNextCacheTags } from "../../lib/serverless-next/cache-adapter";
import type { NextRequestArtifact } from "../../lib/serverless-next/artifact";
import { closeNextRscWorkerPoolForTests } from "../../lib/serverless-next/rsc-worker-pool";
import { closeNextSsrWorkerPoolForTests } from "../../lib/serverless-next/ssr-worker-pool";
import { selectiveShellWorkspace } from "./fixtures/selective-shell-workspace";

afterAll(async () => {
  await closeNextRscWorkerPoolForTests();
  await closeNextSsrWorkerPoolForTests();
});
const compile = (key: string) =>
  compileNextRequestWorkspace(selectiveShellWorkspace(), {
    workspaceKey: key,
    serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  });
async function request(
  artifact: NextRequestArtifact,
  url: string,
  extra: object = {},
) {
  return POST(
    new Request("http://tuto.local/request", {
      method: "POST",
      body: JSON.stringify({
        navigation: {
          revision: artifact.revision,
          url,
          kind: "push",
          prefetchOwner: "owner",
          prefetchMode: "auto",
          ...extra,
        },
      }),
    }),
  );
}
type Grant = { token: string; keys: string[]; ttlMs: number };
async function warm(
  artifact: NextRequestArtifact,
  url = "/dashboard/shared/one",
  refs: Grant[] = [],
) {
  const response = await request(artifact, url, {
    prefetch: true,
    segmentRefs: refs,
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    ticket: string;
    segmentGrant: Grant;
    shellFlight: string;
    ttlMs: number;
  }>;
}
async function navigate(
  artifact: NextRequestArtifact,
  url: string,
  warmed?: Awaited<ReturnType<typeof warm>>,
  refs = warmed ? [warmed.segmentGrant] : [],
) {
  const response = await request(artifact, url, {
    prefetchTicket: warmed?.ticket,
    prefetchShell: !!warmed,
    prefetchShellAck: !!warmed,
    prefetchShellStream: !!warmed,
    segmentRefs: refs,
  });
  const flight = await response.text();
  return { response, flight };
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

for (const kind of ["unrelated", "leaf", "plain"]) {
  test(`unrelated ${kind} mutation preserves shell ticket, root/layout/loading models and fresh nested-slot descendants`, async () => {
    const artifact = await compile("selective-shell-" + kind),
      warmed = await warm(artifact);
    const original = Buffer.from(warmed.shellFlight, "base64").toString();
    expect(original).toContain("data-cached-root");
    expect(original).toContain("data-cached-loading");
    expect(original).not.toContain("data-shared-page");
    await mutate(artifact, kind);
    const one = await navigate(artifact, "/dashboard/shared/one", warmed);
    expect(one.response.headers.get("x-tuto-next-prefetch")).toBe(
      "shell-stream-hit",
    );
    expect(one.flight).not.toContain("data-cached-root");
    expect(one.flight).not.toContain("data-tagged-layout");
    expect(one.flight).not.toContain("data-cached-loading");
    expect(one.flight).toContain("data-shared-page");
    expect(one.flight).toContain("team-one");
    expect(one.flight).toContain("detail-one");
    const sibling = await navigate(
      artifact,
      "/dashboard/shared/two",
      undefined,
      [warmed.segmentGrant],
    );
    expect(sibling.flight).not.toContain("data-tagged-layout");
    expect(sibling.flight).toContain('["two:",1,":","anonymous"]');
    expect(sibling.flight).toContain("detail-two");
  });
}

for (const kind of ["root", "loading", "layout-tag", "layout", "dynamic"]) {
  test(`${kind} mutation expires dependent shell receipts and gives rebuilt templates fresh identities`, async () => {
    const artifact = await compile("shell-dependent-" + kind),
      url =
        kind === "dynamic"
          ? "/dashboard/shared/three"
          : "/dashboard/shared/one";
    const warmed = await warm(artifact, url);
    await mutate(artifact, kind);
    const fresh = await navigate(artifact, url, warmed);
    expect(fresh.response.headers.get("x-tuto-next-prefetch")).toBe(
      "shell-stream-miss",
    );
    expect(fresh.flight).toContain("data-cached-root");
    expect(fresh.flight).toContain("data-tagged-layout");
    const next = await warm(artifact, url, [warmed.segmentGrant]);
    expect(
      next.segmentGrant.keys.some((key) =>
        warmed.segmentGrant.keys.includes(key),
      ),
    ).toBe(false);
    if (kind === "root")
      expect(Buffer.from(next.shellFlight, "base64").toString()).toContain(
        '"data-cached-root":true,"children":2',
      );
  });
}

test("inherited root survives a new child-layout tag mutation while the child and its shell expire", async () => {
  const artifact = await compile("shell-partial-inherited"),
    start = await warm(artifact, "/start");
  const child = await warm(artifact, "/dashboard/shared/one", [
    start.segmentGrant,
  ]);
  const inheritedRoot = start.segmentGrant.keys.find((key) =>
    key.includes('"layout","app/layout.tsx"'),
  )!;
  expect(child.segmentGrant.keys).toContain(inheritedRoot);
  expect(Buffer.from(child.shellFlight, "base64").toString()).not.toContain(
    "data-cached-root",
  );
  await mutate(artifact, "layout-tag");
  const fresh = await navigate(artifact, "/dashboard/shared/one", child, [
    child.segmentGrant,
  ]);
  expect(fresh.response.headers.get("x-tuto-next-prefetch")).toBe(
    "shell-stream-miss",
  );
  expect(fresh.flight).not.toContain("data-cached-root");
  expect(fresh.flight).toContain('"data-tagged-layout":true,"children":2');
  const again = await warm(artifact, "/dashboard/shared/two", [
    child.segmentGrant,
  ]);
  expect(again.segmentGrant.keys).toContain(inheritedRoot);
  expect(
    again.segmentGrant.keys
      .filter((key) => key.includes("app/dashboard/shared/layout.tsx"))
      .every((key) => !child.segmentGrant.keys.includes(key)),
  ).toBe(true);
  await mutate(artifact, "root");
  const expired = await navigate(artifact, "/dashboard/shared/two", again);
  expect(expired.response.headers.get("x-tuto-next-prefetch")).toBe(
    "shell-stream-miss",
  );
  expect(expired.flight).toContain("data-cached-root");
});

for (const related of [true, false]) {
  test(`late loading-cache tags ${related ? "reject related" : "survive unrelated"} invalidation during shell warming`, async () => {
    const artifact = await compile("shell-late-" + related),
      warming = request(artifact, "/dashboard/shared/one", { prefetch: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await revalidateNextCacheTags({
      workspaceKey: artifact.workspaceKey,
      tags: [related ? "shell-loading" : "unrelated"],
      durations: { expire: 0 },
    });
    expect((await warming).status).toBe(related ? 204 : 200);
  });
}

test("reissuing inherited keys cannot renew expiry or manufacture complete dependencies", () => {
  let now = 0;
  const cache = new NextPrefetchTickets(() => now),
    artifact = {
      workspaceKey: "shell-unit",
      revision: "one",
      generation: "one",
    } as NextRequestArtifact;
  const context = cache.segmentContext(artifact, "owner", {}),
    snapshot = nextCacheInvalidations.snapshot(artifact.workspaceKey);
  const root: NextSharedSegment = {
    id: "root",
    key: context + ":root:fresh-one",
    slots: ["children"],
  };
  const original = cache.issueSegments(
    artifact,
    "owner",
    {},
    [root],
    snapshot,
    { complete: true, tags: ["root-tag"] },
  )!;
  now = 20_000;
  const inherited = cache.resolveSegments(artifact, "owner", {}, [original]);
  const child = { id: "child", key: context + ":child:fresh-two", slots: [] };
  const next = cache.issueSegments(
    artifact,
    "owner",
    {},
    [root, child],
    snapshot,
    { complete: true, tags: ["root-tag", "child-tag"] },
    inherited,
  )!;
  expect(next.ttlMs).toBe(10_000);
  now = 30_000;
  const valid = cache.resolveSegments(artifact, "owner", {}, [next]);
  expect(valid.map((model) => model.key)).toEqual([child.key]);
  expect(
    cache.issueSegments(
      artifact,
      "owner",
      {},
      [root],
      snapshot,
      { complete: true, tags: ["root-tag"] },
      inherited,
    ),
  ).toBeUndefined();
  expect(
    cache.put({
      artifact,
      owner: "owner",
      epoch: cache.epoch(artifact),
      snapshot,
      dependencies: { complete: true, tags: ["root-tag"] },
      key: "shell",
      body: new Uint8Array([1]),
      headers: [],
      status: 200,
      kind: "shell",
      maxExpiresAt: 30_000,
    }),
  ).toBeNull();
  const unknown = cache.issueSegments(artifact, "owner", {}, [
    { id: "unknown", key: context + ":unknown:fresh-three", slots: [] },
  ])!;
  nextCacheInvalidations.begin(artifact.workspaceKey, ["unrelated"])();
  expect(cache.resolveSegments(artifact, "owner", {}, [unknown])).toEqual([]);
});
