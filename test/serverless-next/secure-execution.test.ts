import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type { WorkspaceFile } from "../../lib/ide/types";
import { clearNextRequestArtifactsForTests } from "../../lib/serverless-next/artifact";
import { clearNextCacheAdapterForTests } from "../../lib/serverless-next/cache-adapter";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import {
  assertNextProductionExecutionIsolated,
  getNextExecutionMode,
} from "../../lib/serverless-next/execution-mode";
import {
  executeNextRequestArtifact,
  invokeNextRouteHandlerStream,
  renderNextRequestArtifact,
} from "../../lib/serverless-next/runtime";
import { closeNextRscWorkerPoolForTests } from "../../lib/serverless-next/rsc-worker-pool";
import { NextSecureExecWorkspacePool } from "../../lib/serverless-next/secure-exec-worker";
import { closeNextSsrWorkerPoolForTests } from "../../lib/serverless-next/ssr-worker-pool";

const actionSalt = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const previousExecutionMode = process.env.TUTO_NEXT_EXECUTION_MODE;

function pageWorkspace(page: string): WorkspaceFile[] {
  return [
    {
      content:
        "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }",
      language: "tsx",
      path: "app/layout.tsx",
    },
    { content: page, language: "tsx", path: "app/page.tsx" },
  ];
}

async function compile(workspaceKey: string, page: string) {
  return compileNextRequestWorkspace(pageWorkspace(page), {
    serverReferenceHashSalt: actionSalt,
    workspaceKey,
  });
}

function streamingWorkspace(route: string): WorkspaceFile[] {
  return [
    {
      content:
        "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }",
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: "export default function Page() { return <main>streaming</main>; }",
      language: "tsx",
      path: "app/page.tsx",
    },
    {
      content: route,
      language: "ts",
      path: "app/api/stream/route.ts",
    },
  ];
}

function secureTopologyWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `export default function Layout({ children, modal }: { children: React.ReactNode; modal: React.ReactNode }) {
  return <section>{children}<aside>{modal}</aside></section>;
}`,
      language: "tsx",
      path: "app/feed/layout.tsx",
    },
    {
      content: `export default function Page() { return <main>secure-feed</main>; }`,
      language: "tsx",
      path: "app/feed/page.tsx",
    },
    {
      content: `export default function Default() { return <p>secure-modal-empty</p>; }`,
      language: "tsx",
      path: "app/feed/@modal/default.tsx",
    },
    {
      content: `export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <dialog open>secure-intercept:{(await params).id}</dialog>;
}`,
      language: "tsx",
      path: "app/feed/@modal/(..)photo/[id]/page.tsx",
    },
    {
      content: `export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <main>secure-photo:{(await params).id}</main>;
}`,
      language: "tsx",
      path: "app/photo/[id]/page.tsx",
    },
  ];
}

describe.sequential("SecureExec Next execution", () => {
  beforeAll(() => {
    process.env.TUTO_NEXT_EXECUTION_MODE = "secure-exec";
  });

  afterAll(() => {
    if (previousExecutionMode === undefined) {
      delete process.env.TUTO_NEXT_EXECUTION_MODE;
    } else {
      process.env.TUTO_NEXT_EXECUTION_MODE = previousExecutionMode;
    }
  });

  afterEach(async () => {
    await Promise.all([
      closeNextRscWorkerPoolForTests(),
      closeNextSsrWorkerPoolForTests(),
    ]);
    clearNextRequestArtifactsForTests();
    clearNextCacheAdapterForTests();
    delete process.env.TUTO_HOST_SECRET;
    delete process.env.TUTO_NEXT_NETWORK_ALLOWLIST;
    delete process.env.TUTO_NEXT_REQUEST_TIMEOUT_MS;
    delete process.env.TUTO_NEXT_SECURE_WORKERS;
  });

  test("requires sandbox execution in Vercel production", () => {
    expect(getNextExecutionMode({ NODE_ENV: "test" })).toBe("child-process");
    expect(() =>
      assertNextProductionExecutionIsolated({
        NODE_ENV: "production",
        VERCEL: "1",
      }),
    ).toThrow(/requires TUTO_NEXT_EXECUTION_MODE="secure-exec"/);
    expect(
      assertNextProductionExecutionIsolated({
        NODE_ENV: "production",
        TUTO_NEXT_EXECUTION_MODE: "secure-exec",
        VERCEL: "1",
      }),
    ).toBe("secure-exec");
    expect(() =>
      getNextExecutionMode({
        NODE_ENV: "test",
        TUTO_NEXT_EXECUTION_MODE: "container",
      }),
    ).toThrow(/Unsupported TUTO_NEXT_EXECUTION_MODE/);
  });

  test("denies host secrets and unlisted outbound network", async () => {
    process.env.TUTO_HOST_SECRET = "must-not-enter-the-isolate";
    const artifact = await compile(
      "host-boundary",
      `export default async function Page() {
  let secret = "blocked";
  let network = "blocked";
  try { secret = process.env.TUTO_HOST_SECRET || "missing"; } catch {}
  try { await fetch("https://example.com/private"); network = "allowed"; } catch {}
  return <main>secret:{secret};network:{network}</main>;
}`,
    );
    const response = await renderNextRequestArtifact(artifact);
    const html = await response.text();
    expect(html).toContain(
      "secret:<!-- -->missing<!-- -->;network:<!-- -->blocked",
    );
    expect(html).not.toContain("must-not-enter-the-isolate");
  });

  test("rejects filesystem and child-process imports", async () => {
    for (const specifier of ["node:fs", "node:child_process"]) {
      const artifact = await compile(
        `forbidden-${specifier}`,
        `import forbidden from ${JSON.stringify(specifier)};
export default function Page() { return <main>{String(forbidden)}</main>; }`,
      );
      await expect(renderNextRequestArtifact(artifact)).rejects.toThrow(
        new RegExp(`Unsupported external server import ${specifier.replace(":", "\\:")}`),
      );
      await closeNextRscWorkerPoolForTests();
    }
  });

  test("keeps student globals in separate workspace isolates", async () => {
    const poison = await compile(
      "tenant-a",
      `export default function Page() {
  (globalThis as any).__TUTO_STUDENT_POISON__ = "tenant-a";
  return <main>tenant-a</main>;
}`,
    );
    const clean = await compile(
      "tenant-b",
      `export default function Page() {
  return <main>{(globalThis as any).__TUTO_STUDENT_POISON__ || "clean"}</main>;
}`,
    );
    expect(await (await renderNextRequestArtifact(poison)).text()).toContain(
      "tenant-a",
    );
    expect(await (await renderNextRequestArtifact(clean)).text()).toContain(
      "clean",
    );
  });

  test("bounds warm workspace isolates and evicts least-recently-used ones", async () => {
    process.env.TUTO_NEXT_SECURE_WORKERS = "1";
    const first = await compile(
      "bounded-a",
      "export default function Page() { return <main>a</main>; }",
    );
    const second = await compile(
      "bounded-b",
      "export default function Page() { return <main>b</main>; }",
    );
    const pool = new NextSecureExecWorkspacePool("rsc");
    try {
      await pool.send({ artifact: first, type: "install" });
      await pool.send({ artifact: second, type: "install" });
      expect(pool.statsForTests()).toEqual({
        limit: 1,
        workspaces: ["bounded-b"],
      });
    } finally {
      await pool.close();
    }
  });

  test("streams Suspense HTML before a delayed Server Component completes", async () => {
    const artifact = await compile(
      "streamed-rsc",
      `import { Suspense } from "react";
async function Slow({ delay }: { delay: number }) {
  await new Promise((resolve) => setTimeout(resolve, delay));
  return <p>slow-content</p>;
}
export default async function Page({ searchParams }: {
  searchParams: Promise<{ delay?: string }>;
}) {
  const delay = Number((await searchParams).delay || 0);
  return <main><h1>shell-content</h1><Suspense fallback={<p>fallback-content</p>}><Slow delay={delay} /></Suspense></main>;
}`,
    );
    await (
      await executeNextRequestArtifact(artifact, {
        hydrate: true,
        stream: true,
        url: "/?delay=0",
      })
    ).text();

    const startedAt = performance.now();
    const response = await executeNextRequestArtifact(artifact, {
      hydrate: true,
      stream: true,
      url: "/?delay=800",
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    const firstByteMs = performance.now() - startedAt;
    const firstHtml = Buffer.from(first.value ?? []).toString("utf8");
    const chunks = [Buffer.from(first.value ?? [])];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(Buffer.from(chunk.value));
    }
    const totalMs = performance.now() - startedAt;
    const html = Buffer.concat(chunks).toString("utf8");

    expect(first.done).toBe(false);
    expect(firstByteMs).toBeLessThan(500);
    expect(firstHtml).toContain("shell-content");
    expect(firstHtml).toContain("fallback-content");
    expect(firstHtml).not.toContain("slow-content");
    expect(totalMs).toBeGreaterThanOrEqual(650);
    expect(html).toContain("shell-content");
    expect(html).toContain("fallback-content");
    expect(html).toContain("slow-content");
  });

  test("renders parallel defaults and intercepted slots inside SecureExec", async () => {
    const artifact = await compileNextRequestWorkspace(
      secureTopologyWorkspace(),
      {
        serverReferenceHashSalt: actionSalt,
        workspaceKey: "secure-topology",
      },
    );
    const feed = await renderNextRequestArtifact(artifact, { url: "/feed" });
    const feedHtml = await feed.text();
    expect(feedHtml).toContain("secure-feed");
    expect(feedHtml).toContain("secure-modal-empty");

    const intercepted = await renderNextRequestArtifact(artifact, {
      headers: { "next-url": "/feed" },
      url: "/photo/7",
    });
    const interceptedHtml = await intercepted.text();
    expect(intercepted.headers.get("x-tuto-next-route-pattern")).toBe(
      "/photo/[id]",
    );
    expect(interceptedHtml).toContain("secure-feed");
    expect(interceptedHtml).toContain("secure-intercept:<!-- -->7");
    expect(interceptedHtml).not.toContain("secure-photo");
  });

  test("falls back before the first byte for redirect and not-found control flow", async () => {
    const redirected = await compile(
      "streamed-redirect",
      `import { redirect } from "next/navigation";
export default function Page() { redirect("/target"); }`,
    );
    const redirectResponse = await executeNextRequestArtifact(redirected, {
      stream: true,
    });
    expect(redirectResponse.status).toBe(307);
    expect(redirectResponse.headers.get("location")).toBe("/target");

    const missing = await compile(
      "streamed-not-found",
      `import { notFound } from "next/navigation";
export default function Page() { notFound(); }`,
    );
    const notFoundResponse = await executeNextRequestArtifact(missing, {
      stream: true,
    });
    expect(notFoundResponse.status).toBe(404);
    expect(await notFoundResponse.text()).toContain("Not Found");
  });

  test("preserves Route Handler chunk timing and releases a cancelled stream lease", async () => {
    process.env.TUTO_NEXT_SECURE_WORKERS = "1";
    const artifact = await compileNextRequestWorkspace(
      streamingWorkspace(`export function GET(request: Request) {
  const encoder = new TextEncoder();
  const delay = Number(new URL(request.url).searchParams.get("delay") || 0);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("first:"));
      setTimeout(() => {
        controller.enqueue(encoder.encode("second"));
        controller.close();
      }, delay);
    },
  }), { headers: { "content-type": "text/plain; charset=utf-8" } });
}`),
      { serverReferenceHashSalt: actionSalt, workspaceKey: "streamed-handler" },
    );
    await (
      await invokeNextRouteHandlerStream(artifact, {
        method: "GET",
        url: "/api/stream?delay=0",
      })
    ).text();
    const startedAt = performance.now();
    const response = await invokeNextRouteHandlerStream(artifact, {
      method: "GET",
      url: "/api/stream?delay=300",
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    const firstByteMs = performance.now() - startedAt;
    expect(Buffer.from(first.value ?? []).toString()).toBe("first:");
    expect(firstByteMs).toBeLessThan(200);
    await reader.cancel("lesson navigated away");

    const next = await compile(
      "stream-after-cancel",
      "export default function Page() { return <main>lease-released</main>; }",
    );
    await expect(
      Promise.race([
        renderNextRequestArtifact(next).then((result) => result.text()),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("stream lease was not released")), 5_000),
        ),
      ]),
    ).resolves.toContain("lease-released");
  });

  test("terminates a Route Handler stream that exceeds the output budget", async () => {
    const artifact = await compileNextRequestWorkspace(
      streamingWorkspace(`export function GET() {
  const chunk = new Uint8Array(17 * 1024 * 1024);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  }));
}`),
      { serverReferenceHashSalt: actionSalt, workspaceKey: "stream-budget" },
    );
    const response = await invokeNextRouteHandlerStream(artifact, {
      method: "GET",
      url: "/api/stream",
    });
    await expect(response.arrayBuffer()).rejects.toThrow(
      /streamed response exceeds the 16777216 byte limit/,
    );
  });

  test("terminates a CPU-bound request at the host deadline", async () => {
    process.env.TUTO_NEXT_REQUEST_TIMEOUT_MS = "300";
    const artifact = await compile(
      "cpu-deadline",
      `export default function Page() {
  while (true) {}
}`,
    );
    await expect(renderNextRequestArtifact(artifact)).rejects.toThrow(
      /worker request timed out/,
    );
  });
});
