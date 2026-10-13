import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import { POST } from "../../app/api/serverless/nextjs-runtime/request/route";
import { rootParamsWorkspace } from "../serverless-next/fixtures/root-params-workspace";
const stock = process.env.TUTO_NEXT_ROOT_PARAMS_STOCK_ORIGIN;

for (const target of ["tuto", "stock"] as const) {
  async function open(page: Page, url = "/alpha/items/one", events: Array<{prefetch: boolean; hit: string | null}> = []) {
    if (target === "stock") {
      // Stock shares persisted cache entries across these tests and its action
      // bundle has a separate counter. Seed each tenant test with a render fill.
      const reset = await fetch(stock! + "/api/invalidate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "tenant", value: url.split("/")[1] }) });
      expect(reset.status).toBe(200);
      await page.goto(stock! + url);
      return async (name: string, value: string) => {
        const response = await fetch(stock! + "/api/invalidate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, value }) });
        expect(response.status).toBe(200);
      };
    }
    const artifact = await compileNextRequestWorkspace(rootParamsWorkspace(), { workspaceKey: "root-browser-" + randomUUID(), serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" });
    const endpoint = "http://root-params.local/request";
    await page.route(endpoint, async route => {
      const response = await POST(new Request(endpoint, { method: "POST", headers: route.request().headers(), body: route.request().postData()! }));
      events.push({prefetch: JSON.parse(route.request().postData()!).navigation?.prefetch === true, hit: response.headers.get("x-tuto-next-prefetch")});
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.setContent(await (await executeNextRequestArtifact(artifact, { url, hydrate: true, actionEndpoint: endpoint })).text());
    await page.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).__TUTO_NEXT_ROUTER_STATE__));
    return async (name: string, value: string) => {
      const response = await executeNextRequestArtifact(artifact, { url: "/api/invalidate", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, value }) });
      expect(response.status).toBe(200);
    };
  }
  const check = target === "stock" && !stock ? test.skip : test;
  check(`${target}: independent roots omit other exports and preserve catch-all arrays`, async ({ page }) => {
    await open(page, "/other/west");
    await expect(page.locator("[data-root-layout-params]:visible")).toHaveText('{"region":"west"}');
    await expect(page.locator("[data-root-values]:visible")).toHaveText('{"region":"west"}');
    await open(page, "/bag/red/blue");
    await expect(page.locator("[data-root-layout-params]:visible")).toHaveText('{"parts":["red","blue"]}');
    await expect(page.locator("[data-root-values]:visible")).toHaveText('{"parts":["red","blue"]}');
  });
  check(`${target}: root layout props/getters exclude leaf params through sibling navigation and owner changes`, async ({ page }) => {
    await open(page);
    await expect(page.locator("[data-root-layout-params]:visible")).toHaveText('{"tenant":"alpha"}');
    await expect(page.locator("[data-leaf-params]:visible")).toHaveText('{"tenant":"alpha","id":"one"}');
    await expect(page.locator("[data-root-values]:visible")).toHaveText('{"tenant":"alpha"}');
    await expect(page.locator("[data-slot-root]:visible")).toHaveText("alpha");
    await page.locator("[data-root-count]:visible").click();
    await page.locator("[data-next]:visible").click();
    await expect(page.locator("[data-leaf-params]:visible")).toHaveText('{"tenant":"alpha","id":"two"}');
    await expect(page.locator("[data-root-layout-params]:visible")).toHaveText('{"tenant":"alpha"}');
    await expect(page.locator("[data-root-count]:visible")).toHaveText("root:1");
    await page.locator("[data-beta]:visible").click();
    await expect(page.locator("[data-root-values]:visible")).toHaveText('{"tenant":"beta"}');
    await expect(page.locator("[data-root-count]:visible")).toHaveText("root:0");
    await expect(page.locator("[data-slot-root]:visible")).toHaveText("beta");
  });
  check(`${target}: intercepted root context and browser history retain the background root`, async ({ page }) => {
    await open(page);
    await page.locator("[data-root-count]:visible").click();
    await page.locator("[data-photo]:visible").click();
    await expect(page.locator("[data-modal-root]:visible")).toHaveText("alpha");
    await expect(page.locator("[data-modal-params]:visible")).toHaveText('{"tenant":"alpha","photoId":"seven"}');
    await expect(page.locator("[data-root-values]:visible")).toHaveText('{"tenant":"alpha"}');
    await expect(page.locator("[data-root-count]:visible")).toHaveText("root:1");
    await page.locator("[data-back]:visible").click();
    await expect(page.locator("[data-modal-root]:visible")).toHaveCount(0);
    await expect(page.locator("[data-root-values]:visible")).toHaveText('{"tenant":"alpha"}');
    await expect(page.locator("[data-root-count]:visible")).toHaveText("root:1");
  });
  check(`${target}: root partition tag invalidation refreshes data and retains root client state`, async ({ page }) => {
    const invalidate = await open(page);
    const before = JSON.parse((await page.locator("[data-root-cache]:visible").textContent())!);
    await page.locator("[data-root-count]:visible").click();
    await invalidate("tenant", "alpha");
    await page.locator("[data-refresh]:visible").click();
    await expect.poll(async () => JSON.parse((await page.locator("[data-root-cache]:visible").textContent())!).count).toBe(before.count + 1);
    await expect(page.locator("[data-root-count]:visible")).toHaveText("root:1");
    await expect(page.locator("[data-root-layout-params]:visible")).toHaveText('{"tenant":"alpha"}');
  });
  check(`${target}: direct Server Action root getters reject and the refreshed render keeps its root context`, async ({ page }) => {
    const invalidate = await open(page);
    const before = JSON.parse((await page.locator("[data-root-cache]:visible").textContent())!);
    await page.locator("[data-action]:visible").click();
    await expect.poll(async () => JSON.parse((await page.locator("[data-action-result]:visible").textContent())!)?.blocked).toBe(true);
    expect(JSON.parse((await page.locator("[data-action-result]:visible").textContent())!).message).toContain("inside a Server Action");
    await page.locator("[data-noop]:visible").click();
    await expect(page.locator("[data-action-result]:visible")).toHaveText('{"ok":true}');
    await expect(page.locator("[data-root-values]:visible")).toHaveText('{"tenant":"alpha"}');
    await invalidate("tenant", "alpha");
    await page.locator("[data-cache-action]:visible").click();
    await expect.poll(async () => page.locator("[data-action-result]:visible").textContent()).not.toBe('{"ok":true}');
    const result = JSON.parse((await page.locator("[data-action-result]:visible").textContent())!);
    // Stock's action and render bundles have separate fixture-local counters.
    expect(result).toEqual({ tenant: "alpha", count: target === "tuto" ? before.count + 1 : expect.any(Number) });
    await expect(page.locator("[data-root-values]:visible")).toHaveText('{"tenant":"alpha"}');
    await page.locator("[data-beta]:visible").click();
    await expect(page.locator("[data-root-values]:visible")).toHaveText('{"tenant":"beta"}');
    await page.locator("[data-cache-action]:visible").click();
    await expect.poll(async () => JSON.parse((await page.locator("[data-action-result]:visible").textContent())!)?.tenant).toBe("beta");
  });
  if (target === "tuto") check("root-dependent full prefetch is discarded after its partition tag changes", async ({ page }) => {
    const events: Array<{prefetch: boolean; hit: string | null}> = [];
    const invalidate = await open(page, "/alpha/items/one", events);
    const before = JSON.parse((await page.locator("[data-root-cache]:visible").textContent())!);
    await page.locator("[data-root-count]:visible").click();
    // Populate the full client model before invalidating its root partition.
    await page.evaluate(async () => {
      await (globalThis as typeof globalThis & {__TUTO_NEXT_PREFETCH__: (url: string, options: object) => Promise<void>}).__TUTO_NEXT_PREFETCH__("/alpha/items/two", {_prefetchMode: "full"});
    });
    await invalidate("tenant", "alpha");
    await page.locator("[data-next]:visible").click();
    await expect(page.locator("[data-leaf-params]:visible")).toHaveText('{"tenant":"alpha","id":"two"}');
    await expect.poll(async () => JSON.parse((await page.locator("[data-root-cache]:visible").textContent())!).count).toBe(before.count + 1);
    expect(events.filter(event => !event.prefetch).at(-1)?.hit).toBe("miss");
    await expect(page.locator("[data-root-count]:visible")).toHaveText("root:1");
  });
}
