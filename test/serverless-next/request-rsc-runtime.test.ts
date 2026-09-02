import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import type { WorkspaceFile } from "../../lib/ide/types";
import { getServerlessNextjsRuntimeTemplate } from "../../lib/ide/templates";
import {
  clearNextRequestArtifactsForTests,
  diffNextRequestArtifacts,
  getNextRequestArtifact,
} from "../../lib/serverless-next/artifact";
import {
  compileNextRequestWorkspace,
  compileNextRequestWorkspaceWithStatus,
} from "../../lib/serverless-next/compiler";
import { clearNextTransformCacheForTests } from "../../lib/serverless-next/next-compiler-adapter";
import { clearNextCacheAdapterForTests } from "../../lib/serverless-next/cache-adapter";
import {
  invokeNextServerAction,
  renderHydratableNextRequestArtifact,
  renderNextRequestArtifact,
  serializeNextActionBody,
} from "../../lib/serverless-next/runtime";
import { closeNextRscWorkerPoolForTests } from "../../lib/serverless-next/rsc-worker-pool";
import { closeNextSsrWorkerPoolForTests } from "../../lib/serverless-next/ssr-worker-pool";
import { POST as requestRoute } from "../../app/api/serverless/nextjs-runtime/request/route";

const actionSalt = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const runtimeRequire = createRequire(path.join(process.cwd(), "package.json"));
const rscClient = runtimeRequire(
  "next/dist/compiled/react-server-dom-webpack/client.node",
) as {
  encodeReply(value: unknown): Promise<FormData | string>;
};

function workspace(serverMarker: string): WorkspaceFile[] {
  return [
    {
      content: `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body><header>shared-layout</header>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `import Counter from './counter';
export default async function Page() {
  const marker = await Promise.resolve(${JSON.stringify(serverMarker)});
  return <main><h1>{marker}</h1><Counter initial={2} /></main>;
}`,
      language: "tsx",
      path: "app/page.tsx",
    },
    {
      content: `"use client";
import { useState } from 'react';
export default function Counter({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial);
  return <button data-client="counter" onClick={() => setCount((value) => value + 1)}>count:{count}</button>;
}`,
      language: "tsx",
      path: "app/counter.tsx",
    },
  ];
}

function routeWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body><header>root-layout</header>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `export default function NotFound() { return <main>root-not-found</main>; }`,
      language: "tsx",
      path: "app/not-found.tsx",
    },
    {
      content: `export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return <section><h2>blog-layout</h2>{children}</section>;
}`,
      language: "tsx",
      path: "app/blog/layout.tsx",
    },
    {
      content: `export default function NewPost() { return <p>static-new-post</p>; }`,
      language: "tsx",
      path: "app/blog/new/page.tsx",
    },
    {
      content: `export default async function Post({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ slug }, { tab }] = await Promise.all([params, searchParams]);
  return <p>dynamic-post:{slug}:tab:{tab ?? "overview"}</p>;
}`,
      language: "tsx",
      path: "app/blog/[slug]/page.tsx",
    },
    {
      content: `export default async function Docs({ params }: { params: Promise<{ parts: string[] }> }) {
  return <p>docs:{(await params).parts.join("|")}</p>;
}`,
      language: "tsx",
      path: "app/docs/[...parts]/page.tsx",
    },
    {
      content: `export default async function Optional({ params }: { params: Promise<{ rest?: string[] }> }) {
  return <p>optional:{(await params).rest?.join("|") ?? "empty"}</p>;
}`,
      language: "tsx",
      path: "app/optional/[[...rest]]/page.tsx",
    },
  ];
}

function actionWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `"use server";
let total = 0;
export async function increment(delta: number) {
  total += delta;
  return total;
}
export async function current() { return total; }`,
      language: "ts",
      path: "app/actions.ts",
    },
    {
      content: `import { current } from "./actions";
import ActionButton from "./action-button";
export default async function Page() {
  return <main><h1>server-total:{await current()}</h1><ActionButton /></main>;
}`,
      language: "tsx",
      path: "app/page.tsx",
    },
    {
      content: `"use client";
import { useState } from "react";
import { increment } from "./actions";
export default function ActionButton() {
  const [result, setResult] = useState<number | null>(null);
  return <button data-action="increment" onClick={async () => setResult(await increment(3))}>
    action-result:{result ?? "idle"}
  </button>;
}`,
      language: "tsx",
      path: "app/action-button.tsx",
    },
  ];
}

function cacheWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `import { cache } from "react";
import { unstable_cache } from "next/cache";
let tagReads = 0;
let pathReads = 0;
let memoReads = 0;
export const getMemoizedValue = cache(async () => ++memoReads);
export const getTaggedValue = unstable_cache(async () => ++tagReads, ["tagged-value"], {
  revalidate: 3600,
  tags: ["lesson-posts"],
});
export const getPathValue = unstable_cache(async () => ++pathReads, ["path-value"], {
  revalidate: 3600,
});`,
      language: "ts",
      path: "app/cache/data.ts",
    },
    {
      content: `"use server";
import { revalidatePath, revalidateTag, updateTag } from "next/cache";
export async function expireTag() { updateTag("lesson-posts"); return "expired"; }
export async function staleTag() { revalidateTag("lesson-posts", "max"); return "stale"; }
export async function expirePath() { revalidatePath("/cache"); return "path"; }`,
      language: "ts",
      path: "app/cache/actions.ts",
    },
    {
      content: `import { getMemoizedValue, getPathValue, getTaggedValue } from "./data";
export default async function CachePage() {
  const [tagged, path] = await Promise.all([getTaggedValue(), getPathValue()]);
  const memoA = await getMemoizedValue();
  const memoB = await getMemoizedValue();
  return <main><p>tag-read:{tagged}</p><p>path-read:{path}</p><p>memo-read:{memoA}:{memoB}</p></main>;
}`,
      language: "tsx",
      path: "app/cache/page.tsx",
    },
  ];
}

describe("request-compiled Next RSC runtime", () => {
  beforeEach(() => {
    clearNextRequestArtifactsForTests();
    clearNextTransformCacheForTests();
    clearNextCacheAdapterForTests();
  });

  afterAll(async () => {
    await Promise.all([
      closeNextRscWorkerPoolForTests(),
      closeNextSsrWorkerPoolForTests(),
    ]);
  });

  test("uses Next SWC outputs to render Flight and HTML without next build", async () => {
    const artifact = await compileNextRequestWorkspace(workspace("server-v1"), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "lesson-rsc",
    });

    expect(artifact.nextVersion).toBe("16.2.6");
    expect(artifact.kernelId).toMatch(/^[a-f0-9]{20}$/);
    expect(artifact.router.routes).toMatchObject([
      {
        layouts: ["app/layout.tsx"],
        page: "app/page.tsx",
        pattern: "/",
      },
    ]);
    expect(Object.keys(artifact.clientReferenceManifest)).toEqual([
      "/tuto/workspaces/lesson-rsc/app/counter.tsx",
    ]);
    expect(artifact.serverModules["app/counter.tsx"].code).toContain(
      "private-next-rsc-mod-ref-proxy",
    );
    expect(artifact.clientModules["app/counter.tsx"].code).toContain(
      "useState",
    );
    expect(artifact.clientBundle.code).toContain(
      "__TUTO_NEXT_CLIENT_MODULES__",
    );
    expect(getNextRequestArtifact(artifact.revision)).toBe(artifact);

    const flightResponse = await renderNextRequestArtifact(artifact, {
      flight: true,
    });
    const flight = await flightResponse.text();
    expect(flightResponse.status).toBe(200);
    expect(flightResponse.headers.get("content-type")).toContain(
      "text/x-component",
    );
    expect(flight).toContain("server-v1");
    expect(flight).toContain(artifact.clientModules["app/counter.tsx"].id);

    const htmlResponse = await renderNextRequestArtifact(artifact);
    const html = await htmlResponse.text();
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("x-tuto-next-generation")).toBe(
      artifact.generation,
    );
    expect(html).toContain("shared-layout");
    expect(html).toContain("server-v1");
    expect(html).toContain('data-client="counter"');
    expect(html).toContain("count:<!-- -->2");

    const hydratable = await (
      await renderHydratableNextRequestArtifact(artifact)
    ).text();
    expect(hydratable).toContain("__TUTO_NEXT_CLIENT_KERNEL__");
    expect(hydratable).toContain("__TUTO_NEXT_CLIENT_MODULES__");
    expect(hydratable).toContain("hydrateRoot");
    expect(hydratable).toContain(artifact.generation);
  });

  test("publishes a new generation while preserving unchanged client artifacts", async () => {
    const before = await compileNextRequestWorkspace(workspace("server-v1"), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "lesson-edit",
    });
    const after = await compileNextRequestWorkspace(workspace("server-v2"), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "lesson-edit",
    });
    const diff = diffNextRequestArtifacts(before, after);

    expect(after.generation).not.toBe(before.generation);
    expect(diff).toEqual({
      actionManifestChanged: false,
      clientBundleChanged: false,
      changedClientModules: [],
      changedServerModules: ["app/page.tsx"],
      clientManifestChanged: false,
      removedClientModules: [],
      removedServerModules: [],
      routeManifestChanged: false,
    });
    expect(after.buildMetrics.browserTransformCacheHits).toBe(1);
    expect(after.buildMetrics.serverTransformCacheHits).toBe(2);
    expect(await (await renderNextRequestArtifact(before)).text()).toContain(
      "server-v1",
    );
    expect(await (await renderNextRequestArtifact(after)).text()).toContain(
      "server-v2",
    );
  });

  test("reuses an immutable artifact for an unchanged workspace", async () => {
    const options = {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "unchanged-workspace",
    };
    const first = await compileNextRequestWorkspaceWithStatus(
      workspace("unchanged"),
      options,
    );
    const second = await compileNextRequestWorkspaceWithStatus(
      workspace("unchanged"),
      options,
    );

    expect(first.artifactCache).toBe("miss");
    expect(second.artifactCache).toBe("hot");
    expect(second.artifact).toBe(first.artifact);
  });

  test("matches static, dynamic, catch-all, and optional routes with nested layouts", async () => {
    const artifact = await compileNextRequestWorkspace(routeWorkspace(), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "router-lessons",
    });
    expect(artifact.router.routes.map((route) => route.pattern)).toEqual([
      "/blog/new",
      "/blog/[slug]",
      "/docs/[...parts]",
      "/optional/[[...rest]]",
    ]);

    const dynamic = await renderNextRequestArtifact(artifact, {
      url: "/blog/hello-next?tab=comments",
    });
    const dynamicHtml = await dynamic.text();
    expect(dynamic.status).toBe(200);
    expect(dynamic.headers.get("x-tuto-next-route-pattern")).toBe(
      "/blog/[slug]",
    );
    expect(dynamicHtml).toContain("root-layout");
    expect(dynamicHtml).toContain("blog-layout");
    expect(dynamicHtml).toContain("dynamic-post:<!-- -->hello-next");
    expect(dynamicHtml).toContain("tab:<!-- -->comments");

    expect(
      await (
        await renderNextRequestArtifact(artifact, { url: "/blog/new" })
      ).text(),
    ).toContain("static-new-post");
    expect(
      await (
        await renderNextRequestArtifact(artifact, { url: "/docs/a/b/c" })
      ).text(),
    ).toContain("docs:<!-- -->a|b|c");
    expect(
      await (
        await renderNextRequestArtifact(artifact, { url: "/optional" })
      ).text(),
    ).toContain("optional:<!-- -->empty");

    const missing = await renderNextRequestArtifact(artifact, {
      url: "/does-not-exist",
    });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("root-not-found");
  });

  test("decodes and executes a real Next Server Action then returns refreshed Flight", async () => {
    const artifact = await compileNextRequestWorkspace(actionWorkspace(), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "action-lessons",
    });
    const actionEntry = Object.entries(artifact.actionManifest).find(
      ([, reference]) => reference.exportName === "increment",
    );
    expect(actionEntry).toBeDefined();
    expect(artifact.clientModules["app/actions.ts"].code).toContain(
      "createServerReference",
    );
    expect(artifact.clientBundle.code).toContain("__TUTO_NEXT_CLIENT_KERNEL__");

    const encodedArgs = await rscClient.encodeReply([3]);
    const response = await invokeNextServerAction(artifact, {
      actionId: actionEntry![0],
      body: await serializeNextActionBody(encodedArgs),
      url: "/",
    });
    const flight = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/x-component");
    expect(flight).toContain('"actionResult":3');
    expect(flight).toContain("server-total:");
    expect(flight).toContain("3");

    const refreshedHtml = await (
      await renderNextRequestArtifact(artifact)
    ).text();
    expect(refreshedHtml).toContain("server-total:<!-- -->3");
  });

  test("uses Next cache APIs with tag, path, and stale-while-revalidate semantics", async () => {
    const artifact = await compileNextRequestWorkspace(cacheWorkspace(), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "cache-lessons",
    });
    const actionId = (exportName: string) => {
      const entry = Object.entries(artifact.actionManifest).find(
        ([, action]) => action.exportName === exportName,
      );
      expect(entry, `missing ${exportName} action`).toBeDefined();
      return entry![0];
    };
    const invoke = async (exportName: string) =>
      invokeNextServerAction(artifact, {
        actionId: actionId(exportName),
        body: await serializeNextActionBody(await rscClient.encodeReply([])),
        url: "/cache",
      });

    const cold = await renderNextRequestArtifact(artifact, { url: "/cache" });
    const coldHtml = await cold.text();
    expect(coldHtml).toContain("tag-read:<!-- -->1");
    expect(coldHtml).toContain("path-read:<!-- -->1");
    expect(coldHtml).toContain("memo-read:<!-- -->1<!-- -->:<!-- -->1");
    expect(cold.headers.get("x-tuto-next-cache")).toContain("miss=2");
    expect(cold.headers.get("x-tuto-next-cache")).toContain("write=2");

    const hot = await renderNextRequestArtifact(artifact, { url: "/cache" });
    const hotHtml = await hot.text();
    expect(hotHtml).toContain("tag-read:<!-- -->1");
    expect(hotHtml).toContain("path-read:<!-- -->1");
    expect(hotHtml).toContain("memo-read:<!-- -->2<!-- -->:<!-- -->2");
    expect(hot.headers.get("x-tuto-next-cache")).toContain("hit=2");

    const expiredTag = await invoke("expireTag");
    const expiredTagFlight = await expiredTag.text();
    expect(expiredTagFlight).toContain("tag-read:");
    expect(expiredTagFlight).toContain("2");
    expect(expiredTag.headers.get("x-tuto-next-cache")).toContain(
      "revalidate=1",
    );
    expect(expiredTag.headers.get("x-tuto-next-cache")).toContain("miss=1");
    expect(expiredTag.headers.get("x-tuto-next-cache")).toContain("hit=1");

    const staleTag = await invoke("staleTag");
    const staleFlight = await staleTag.text();
    expect(staleFlight).toContain("tag-read:");
    expect(staleTag.headers.get("x-tuto-next-cache")).toContain("stale=1");
    expect(staleTag.headers.get("x-tuto-next-cache")).toContain("write=1");

    const refreshed = await renderNextRequestArtifact(artifact, {
      url: "/cache",
    });
    expect(await refreshed.text()).toContain("tag-read:<!-- -->3");

    const expiredPath = await invoke("expirePath");
    const pathFlight = await expiredPath.text();
    expect(pathFlight).toContain("path-read:");
    expect(expiredPath.headers.get("x-tuto-next-cache")).toContain("miss=2");
    expect(expiredPath.headers.get("x-tuto-next-cache")).toContain(
      "revalidate=1",
    );
  });

  test("preserves data cache entries across generations while isolating workspaces", async () => {
    const originalFiles = cacheWorkspace();
    const first = await compileNextRequestWorkspace(originalFiles, {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "cache-generation-a",
    });
    await (await renderNextRequestArtifact(first, { url: "/cache" })).text();

    const editedFiles = originalFiles.map((file) =>
      file.path === "app/cache/page.tsx"
        ? {
            ...file,
            content: `${file.content}\nexport const lessonEdit = "v2";`,
          }
        : file,
    );
    const edited = await compileNextRequestWorkspace(editedFiles, {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "cache-generation-a",
    });
    const reused = await renderNextRequestArtifact(edited, { url: "/cache" });
    expect(edited.generation).not.toBe(first.generation);
    expect(await reused.text()).toContain("tag-read:<!-- -->1");
    expect(reused.headers.get("x-tuto-next-cache")).toContain("hit=2");

    const isolated = await compileNextRequestWorkspace(originalFiles, {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "cache-generation-b",
    });
    const isolatedResponse = await renderNextRequestArtifact(isolated, {
      url: "/cache",
    });
    expect(isolatedResponse.headers.get("x-tuto-next-cache")).toContain(
      "miss=2",
    );
  });

  test("serves the Tuto workbench template through the integrated request route", async () => {
    const template = getServerlessNextjsRuntimeTemplate();
    expect(template).toBeDefined();
    const requestWorkbench = (requestPath: string) =>
      requestRoute(
        new Request("http://tuto.local/api/serverless/nextjs-runtime/request", {
          body: JSON.stringify({
            files: template!.files,
            request: { method: "GET", path: requestPath },
            workspaceKey: "workbench-checkpoint",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
    const response = await requestWorkbench("/");
    const responseText = await response.text();
    const result = JSON.parse(responseText) as {
      response?: { body?: string };
      success?: boolean;
    };

    expect(response.status, responseText).toBe(200);
    expect(result.success).toBe(true);
    expect(result.response?.body).toContain("Hello from real Next core APIs.");
    expect(result.response?.body).toContain('data-client="counter"');
    expect(result.response?.body).toContain("__TUTO_NEXT_HYDRATED__");

    const coldCache = (await (await requestWorkbench("/cache")).json()) as {
      logs: Array<{ message: string }>;
      response: { body: string };
    };
    expect(coldCache.response.body).toContain("Cache and invalidation");
    expect(coldCache.logs.some((log) => log.message.includes("miss=2"))).toBe(
      true,
    );
    const hotCache = (await (await requestWorkbench("/cache")).json()) as {
      logs: Array<{ message: string }>;
    };
    expect(hotCache.logs.some((log) => log.message.includes("hit=2"))).toBe(
      true,
    );
  });

  test("rejects a server-only dependency below a client boundary", async () => {
    const files = workspace("server-v1");
    files[2] = {
      ...files[2],
      content: `"use client";
import value from './secret';
export default function Counter() { return <p>{value}</p>; }`,
    };
    files.push({
      content: `import 'server-only'; export default 'secret';`,
      language: "ts",
      path: "app/secret.ts",
    });

    await expect(
      compileNextRequestWorkspace(files, {
        serverReferenceHashSalt: actionSalt,
        workspaceKey: "lesson-boundary",
      }),
    ).rejects.toThrow(/client component graph imports a server-only module/i);
  });
});
