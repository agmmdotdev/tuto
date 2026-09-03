import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type { WorkspaceFile } from "../../lib/ide/types";
import { clearNextRequestArtifactsForTests } from "../../lib/serverless-next/artifact";
import { clearNextCacheAdapterForTests } from "../../lib/serverless-next/cache-adapter";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import {
  assertNextProductionExecutionIsolated,
  getNextExecutionMode,
} from "../../lib/serverless-next/execution-mode";
import { renderNextRequestArtifact } from "../../lib/serverless-next/runtime";
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
