import { afterAll, beforeEach, describe, expect, test } from "vitest";
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
import {
  renderHydratableNextRequestArtifact,
  renderNextRequestArtifact,
} from "../../lib/serverless-next/runtime";
import { closeNextRscWorkerPoolForTests } from "../../lib/serverless-next/rsc-worker-pool";
import { closeNextSsrWorkerPoolForTests } from "../../lib/serverless-next/ssr-worker-pool";
import { POST as requestRoute } from "../../app/api/serverless/nextjs-runtime/request/route";

const actionSalt = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

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

describe("request-compiled Next RSC runtime", () => {
  beforeEach(() => {
    clearNextRequestArtifactsForTests();
    clearNextTransformCacheForTests();
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
    expect(artifact.entries).toEqual({
      layout: "app/layout.tsx",
      page: "app/page.tsx",
    });
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

  test("serves the Tuto workbench template through the integrated request route", async () => {
    const template = getServerlessNextjsRuntimeTemplate();
    expect(template).toBeDefined();
    const response = await requestRoute(
      new Request("http://tuto.local/api/serverless/nextjs-runtime/request", {
        body: JSON.stringify({
          files: template!.files,
          request: { method: "GET", path: "/" },
          workspaceKey: "workbench-checkpoint",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const result = (await response.json()) as {
      response?: { body?: string };
      success?: boolean;
    };

    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    expect(result.response?.body).toContain("Hello from real Next core APIs.");
    expect(result.response?.body).toContain('data-client="counter"');
    expect(result.response?.body).toContain("__TUTO_NEXT_HYDRATED__");
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
