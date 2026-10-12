import { expect, test, type Page } from "@playwright/test";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import { POST } from "../../app/api/serverless/nextjs-runtime/request/route";
import { prefetchWorkspace } from "../serverless-next/fixtures/prefetch-workspace";
import { selectiveShellWorkspace } from "../serverless-next/fixtures/selective-shell-workspace";

async function open(page: Page, shell = false, delay = 0) {
  const files = shell ? selectiveShellWorkspace() : prefetchWorkspace();
  if (shell) {
    const data = files.find(file => file.path === "app/shell-data.ts")!;
    data.content = data.content.replace('import {cacheTag}', 'import {cacheLife,cacheTag}')
      .replace('cacheTag("shell-loading");', 'cacheTag("shell-loading");cacheLife({stale:1,revalidate:10,expire:20});');
  } else {
    files.push({ path: "app/lifetime/page.tsx", language: "tsx", content: `import {unstable_cache} from "next/cache";let reads=0;const read=unstable_cache(async()=>++reads,["browser-lifetime"],{revalidate:1});export default async function Page(){return <output data-lifetime>{await read()}</output>;}` });
  }
  const artifact = await compileNextRequestWorkspace(files, { workspaceKey: test.info().title,
    serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" });
  const events: Array<{ prefetch: boolean; ticket: boolean; refs: number; hit: string | null }> = [];
  const endpoint = "http://lifetime.local/request";
  await page.route(endpoint, async route => {
    const body = route.request().postData()!;
    const navigation = JSON.parse(body).navigation;
    const response = await POST(new Request(endpoint, { method: "POST", body }));
    events.push({ prefetch: navigation.prefetch === true, ticket: !!navigation.prefetchTicket,
      refs: navigation.segmentRefs?.length ?? 0, hit: response.headers.get("x-tuto-next-prefetch") });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (navigation.prefetch && delay) await new Promise(resolve => setTimeout(resolve, delay));
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: bytes });
  });
  await page.setContent(await (await executeNextRequestArtifact(artifact, { url: "/dashboard", hydrate: true, actionEndpoint: endpoint })).text());
  await page.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).__TUTO_NEXT_ROUTER_STATE__));
  await page.locator('[data-counter="root"]').click();
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
  return events;
}

async function warm(page: Page, shell = false) {
  await page.evaluate(async shell => {
    const scope = globalThis as typeof globalThis & { __lifetimeInvalidations?: number;
      __TUTO_NEXT_PREFETCH__: (href: string, options: object) => Promise<void> };
    scope.__lifetimeInvalidations = 0;
    await scope.__TUTO_NEXT_PREFETCH__(shell ? "/dashboard/shared/one" : "/lifetime", {
      _prefetchMode: shell ? "auto" : "full", onInvalidate: () => { scope.__lifetimeInvalidations!++; },
    });
  }, shell);
}
async function go(page: Page, shell = false) {
  await page.evaluate(shell => {
    const scope = globalThis as typeof globalThis & { __TUTO_NEXT_NAVIGATE__: (kind: string, href: string, options?: object) => Promise<void> };
    return scope.__TUTO_NEXT_NAVIGATE__("push", shell ? "/dashboard/shared/one" : "/lifetime");
  }, shell);
}

test("short data lifetime fires invalidation once and navigation retains root client state", async ({ page }) => {
  const events = await open(page);
  await warm(page);
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __lifetimeInvalidations: number }).__lifetimeInvalidations)).toBe(1);
  await go(page);
  await expect(page.locator("[data-lifetime]")).toBeVisible();
  expect(events.filter(event => !event.prefetch).at(-1)?.hit).toBe("miss");
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __lifetimeInvalidations: number }).__lifetimeInvalidations)).toBe(1);
});

for (const shell of [false, true]) {
  test(`transport delay cannot extend expired ${shell ? "shell model" : "full Flight"} reuse`, async ({ page }) => {
    const events = await open(page, shell, 1200);
    await warm(page, shell);
    await go(page, shell);
    await expect(page.locator(shell ? "[data-shared-page]" : "[data-lifetime]")).toBeVisible();
    const navigation = events.filter(event => !event.prefetch).at(-1)!;
    expect(navigation.ticket).toBe(false);
    expect(navigation.refs).toBe(0);
    expect(navigation.hit).toBe("miss");
    await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
  });
}
