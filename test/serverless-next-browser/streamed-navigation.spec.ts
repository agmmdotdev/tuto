import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { POST, OPTIONS } from "../../app/api/serverless/nextjs-runtime/request/route";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import { streamedNavigationWorkspace } from "../serverless-next/fixtures/streamed-navigation-workspace";

const servers: Server[] = [];
test.afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function open(page: Page, delayShellMs = 0) {
  const stats = { chunks: 0, cancelled: 0, requests: [] as Array<{url:string}> };
  if (process.env.TUTO_NEXT_STREAM_STOCK_URL) {
    await page.goto(process.env.TUTO_NEXT_STREAM_STOCK_URL + "/dashboard");
    return stats;
  }
  const artifact = await compileNextRequestWorkspace(streamedNavigationWorkspace(), {
    workspaceKey: test.info().title,
    serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  });
  const server = createServer((request, outgoing) => {
    void (async () => {
      const controller = new AbortController();
      let speculative = false;
      outgoing.on("close", () => {
        if (!outgoing.writableFinished) { if (!speculative) stats.cancelled++; controller.abort(); }
      });
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const input = body ? JSON.parse(body) as {navigation?:{url:string;prefetch?:boolean}} : {};
      speculative = input.navigation?.prefetch === true;
      if (input.navigation) stats.requests.push(input.navigation);
      if (delayShellMs && input.navigation?.url === "/dashboard/slow") {
        await new Promise(resolve => setTimeout(resolve, delayShellMs));
        controller.signal.throwIfAborted();
      }
      const response = request.method === "OPTIONS" ? OPTIONS() : await POST(new Request("http://tuto.local/request", {
        body, method:"POST", headers:{"content-type":"text/plain;charset=UTF-8"}, signal:controller.signal,
      }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          stats.chunks++;
          if (!outgoing.write(chunk.value)) await once(outgoing,"drain");
        }
      }
      outgoing.end();
    })().catch(error => {
      if (!outgoing.destroyed) outgoing.destroy(error as Error);
    });
  });
  servers.push(server);
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  const address = server.address() as {port:number};
  const html = await (await executeNextRequestArtifact(artifact, {url:"/dashboard", hydrate:true, actionEndpoint:`http://127.0.0.1:${address.port}/request`})).text();
  await page.setContent(html);
  await page.waitForFunction(() => Boolean((globalThis as Record<string,unknown>).__TUTO_NEXT_ROUTER_STATE__));
  return stats;
}

test("streams primary and nested slot loading boundaries while shared layouts stay interactive", async ({page}) => {
  const stats = await open(page);
  await page.locator('[data-counter="root"]').click();
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
  await page.locator('[data-counter="analytics-home"]').click();
  await page.locator('[data-go="slow"]').click();
  await expect(page.locator("[data-primary-loading]")).toBeVisible();
  await expect(page.locator("[data-team-loading]")).toBeVisible();
  await expect(page.locator("[data-detail-loading]")).toBeVisible();
  await page.locator('[data-counter="root"]').click();
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:2");
  await expect(page.locator('[data-counter="slow"]')).toBeVisible();
  await expect(page.locator("[data-details-loading]")).toBeVisible();
  await expect(page.locator("[data-team-loading]")).toBeVisible();
  await expect(page.locator("[data-stream-details]")).toBeVisible();
  await expect(page.locator('[data-counter="detail-slow"]')).toBeVisible();
  await expect(page.locator('[data-counter="analytics-home"]')).toHaveText("analytics-home:1");
  if (!process.env.TUTO_NEXT_STREAM_STOCK_URL) expect(stats.chunks).toBeGreaterThan(1);
  await page.locator("[data-back]").click();
  await expect(page.locator('[data-counter="home"]')).toBeVisible();
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:2");
});

test("supersedes a committed loading shell and preserves history ordering", async ({page}) => {
  const stats = await open(page);
  await page.locator('[data-go="slow"]').click();
  await expect(page.locator("[data-primary-loading]")).toBeVisible();
  await page.locator('[data-go="settings"]').click();
  await expect(page.locator('[data-counter="settings"]')).toBeVisible();
  await expect(page.locator('[data-counter="slow"]')).not.toBeVisible();
  await page.locator("[data-back]").click();
  await expect(page.locator('[data-counter="slow"]')).toBeVisible();
  await expect(page.locator("[data-path]")).toHaveText("/dashboard/slow?");
  await page.locator("[data-back]").click();
  await expect(page.locator('[data-counter="home"]')).toBeVisible();
  if (!process.env.TUTO_NEXT_STREAM_STOCK_URL) expect(stats.cancelled).toBe(0);
});

test("handles errors, notFound and redirects after streamed headers without remounting the root layout", async ({page}) => {
  await open(page);
  await page.locator('[data-counter="root"]').click();
  async function push(path:string) {
    await page.evaluate(path => {
      const transport = (globalThis as typeof globalThis & {__TUTO_NEXT_NAVIGATE__?:(kind:string,path:string)=>void}).__TUTO_NEXT_NAVIGATE__;
      if (transport) transport("push",path);
      else { const anchor=document.createElement("a"); anchor.href=path; document.body.append(anchor); anchor.click(); }
    },path);
  }
  // Real Links provide stock client navigation for the comparison fixture.
  if (process.env.TUTO_NEXT_STREAM_STOCK_URL) {
    await page.locator('[data-go="stream-error"]').click();
  } else await push("/dashboard/stream-error");
  await expect(page.locator("[data-error-loading]")).toBeVisible();
  await expect(page.locator("[data-stream-error]")).toBeVisible();
  if (process.env.TUTO_NEXT_STREAM_STOCK_URL) await page.locator('[data-go="stream-missing"]').click();
  else await push("/dashboard/stream-missing");
  await expect(page.locator("[data-stream-not-found]")).toBeVisible();
  if (process.env.TUTO_NEXT_STREAM_STOCK_URL) await page.locator('[data-go="stream-redirect"]').click();
  else await push("/dashboard/stream-redirect");
  await expect(page.locator('[data-counter="settings"]')).toBeVisible();
  await expect(page.locator("[data-path]")).toHaveText("/dashboard/settings?redirected=yes");
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
});


test("retains streamed background slot selection through intercepted modal history and refresh", async ({page}) => {
  await open(page);
  await page.locator('[data-counter="root"]').click();
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
  await page.locator('[data-go="slow"]').click();
  await expect(page.locator("[data-primary-loading]")).toBeVisible();
  await expect(page.locator("[data-path]")).toHaveText("/dashboard/slow?");
  await expect(page.locator('[data-counter="slow"]')).toBeVisible();
  await page.locator('[data-counter="slow"]').click();
  await expect(page.locator("[data-details-loading]")).toBeVisible();
  await page.locator('[data-go="photo"]').click();
  await expect(page.locator("[data-modal]")).toBeVisible();
  await expect(page.locator('[data-counter="slow"]')).toBeVisible();
  await expect(page.locator('[data-counter="detail-slow"]')).toBeVisible();
  await expect(page.locator('[data-counter="slow"]')).toHaveText("slow:1");
  await page.locator('[data-counter="modal"]').click();
  await page.locator('[data-refresh]').click();
  await expect(page.locator('[data-counter="modal"]')).toHaveText("modal:1");
  await expect(page.locator('[data-counter="slow"]')).toHaveText("slow:1");
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
  await page.locator('[data-back]').click();
  await expect(page.locator("[data-modal]")).not.toBeVisible();
  await expect(page.locator("[data-path]")).toHaveText("/dashboard/slow?");
  await page.locator('[data-forward]').click();
  await expect(page.locator("[data-modal]")).toBeVisible();
  await expect(page.locator("[data-path]")).toHaveText("/photo/7?");
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
});


test("cancels navigation before a Flight shell is handed to React without adding a history entry", async ({page}) => {
  test.skip(Boolean(process.env.TUTO_NEXT_STREAM_STOCK_URL), "Exercises Tuto's controlled HTTP transport.");
  const stats = await open(page, 300);
  await page.locator('[data-go="slow"]').click();
  await expect.poll(() => stats.requests.some(request => request.url === "/dashboard/slow")).toBe(true);
  await page.locator('[data-go="settings"]').click();
  await expect(page.locator('[data-counter="settings"]')).toBeVisible();
  await expect.poll(() => stats.cancelled).toBeGreaterThan(0);
  await expect(page.locator("[data-path]")).toHaveText("/dashboard/settings?tab=team");
  await page.locator('[data-back]').click();
  await expect(page.locator('[data-counter="home"]')).toBeVisible();
  await expect(page.locator("[data-path]")).toHaveText("/dashboard?");
});
