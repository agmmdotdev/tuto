import { expect, test } from "@playwright/test";
import type { WorkspaceFile } from "../../lib/ide/types";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import {
  invokeNextServerAction,
  renderHydratableNextRequestArtifact,
} from "../../lib/serverless-next/runtime";

const files: WorkspaceFile[] = [
  {
    content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body><h1>Next request runtime</h1>{children}</body></html>;
}`,
    language: "tsx",
    path: "app/layout.tsx",
  },
  {
    content: `import Counter from './counter';
export default function Page() { return <main><p>server-browser-checkpoint</p><Counter /></main>; }`,
    language: "tsx",
    path: "app/page.tsx",
  },
  {
    content: `"use client";
import { useState } from 'react';
export default function Counter() {
  const [count, setCount] = useState(0);
  return <button data-client="counter" onClick={() => setCount((value) => value + 1)}>count:{count}</button>;
}`,
    language: "tsx",
    path: "app/counter.tsx",
  },
];

const actionFiles: WorkspaceFile[] = [
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
export async function increment(delta: number) { total += delta; return total; }
export async function current() { return total; }`,
    language: "ts",
    path: "app/actions.ts",
  },
  {
    content: `import { current } from "./actions";
import ActionButton from "./action-button";
export default async function Page() {
  return <main><p data-server-total>server-total:{await current()}</p><ActionButton /></main>;
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
  return <button data-action="increment" onClick={async () => setResult(await increment(4))}>action-result:{result ?? "idle"}</button>;
}`,
    language: "tsx",
    path: "app/action-button.tsx",
  },
];

test("hydrates a Next SWC client boundary and preserves interaction", async ({
  page,
}) => {
  const artifact = await compileNextRequestWorkspace(files, {
    serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    workspaceKey: "browser-checkpoint",
  });
  const document = await (
    await renderHydratableNextRequestArtifact(artifact)
  ).text();
  await page.setContent(document, { waitUntil: "load" });

  await expect(page.locator("text=server-browser-checkpoint")).toBeVisible();
  await expect(page.locator('[data-client="counter"]')).toHaveText("count:0");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __TUTO_NEXT_HYDRATED__?: string;
            }
          ).__TUTO_NEXT_HYDRATED__,
      ),
    )
    .toBe(artifact.generation);
  await page.locator('[data-client="counter"]').click();
  await expect(page.locator('[data-client="counter"]')).toHaveText("count:1");
});

test("dispatches a Server Action and applies its refreshed Flight tree", async ({
  page,
}) => {
  const artifact = await compileNextRequestWorkspace(actionFiles, {
    serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    workspaceKey: "browser-action-checkpoint",
  });
  const actionEndpoint = "http://next-action.local/action";
  await page.route(actionEndpoint, async (route) => {
    const payload = JSON.parse(route.request().postData() ?? "{}") as {
      action: Parameters<typeof invokeNextServerAction>[1] & {
        revision: string;
      };
    };
    expect(payload.action.revision).toBe(artifact.revision);
    const response = await invokeNextServerAction(artifact, payload.action);
    await route.fulfill({
      body: Buffer.from(await response.arrayBuffer()),
      headers: Object.fromEntries(response.headers.entries()),
      status: response.status,
    });
  });
  const document = await (
    await renderHydratableNextRequestArtifact(artifact, { actionEndpoint })
  ).text();
  await page.setContent(document, { waitUntil: "load" });

  await expect(page.locator("[data-server-total]")).toHaveText(
    "server-total:0",
  );
  await expect(page.locator('[data-action="increment"]')).toHaveText(
    "action-result:idle",
  );
  await page.locator('[data-action="increment"]').click();
  await expect(page.locator('[data-action="increment"]')).toHaveText(
    "action-result:4",
  );
  await expect(page.locator("[data-server-total]")).toHaveText(
    "server-total:4",
  );
});
