import { expect, test } from "@playwright/test";
import type { WorkspaceFile } from "../../lib/ide/types";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { renderHydratableNextRequestArtifact } from "../../lib/serverless-next/runtime";

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
