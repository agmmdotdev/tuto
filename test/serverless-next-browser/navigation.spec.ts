import { expect, test, type Page } from "@playwright/test";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { GET, POST } from "../../app/api/serverless/nextjs-runtime/request/route";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import { persistentNavigationWorkspace } from "../serverless-next/fixtures/persistent-navigation-workspace";

async function openDashboard(page: Page, path = "/dashboard", sandbox = false) {
  const stock = process.env.TUTO_NEXT_STOCK_URL;
  if (stock) {
    await page.goto(stock + path);
    return page;
  }
  const artifact = await compileNextRequestWorkspace(persistentNavigationWorkspace(), {
    serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    workspaceKey: `persistent-browser-${test.info().title}-${path}`,
  });
  const endpoint = "http://next-navigation.local/request";
  await page.route(endpoint, async (route) => {
    const response = await POST(new Request(endpoint, {
      body: route.request().postData()!, method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
    }));
    await route.fulfill({
      body: Buffer.from(await response.arrayBuffer()),
      headers: Object.fromEntries(response.headers), status: response.status,
    });
  });
  const response = await executeNextRequestArtifact(artifact, { actionEndpoint: endpoint, hydrate: true, url: path });
  const html = await response.text();
  if (sandbox) {
    await page.setContent('<iframe sandbox="allow-scripts" title="preview" style="width:100%;height:600px"></iframe>');
    await page.locator("iframe").evaluate((element, html) => { (element as HTMLIFrameElement).srcdoc = html; }, html);
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    await frame.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).__TUTO_NEXT_ROUTER_STATE__));
    return frame;
  }
  await page.setContent(html, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).__TUTO_NEXT_ROUTER_STATE__));
  return page;
}

test("retains the document, layout state, nested slot state and input focus through navigation and refresh", async ({ page }) => {
  const preview = await openDashboard(page);
  await preview.locator('[data-counter="root"]').click();
  await preview.locator('[data-counter="dashboard"]').click();
  await preview.locator('[data-counter="analytics-home"]').click();
  await preview.locator('[data-counter="team-layout"]').click();
  await preview.locator('[data-go="settings"]').click();
  await expect(preview.locator('[data-counter="team-settings"]')).toBeVisible();
  await expect(preview.locator('[data-counter="settings"]')).toHaveCSS("color", "rgb(102, 51, 153)");
  await preview.locator('[data-counter="team-settings"]').click();
  await preview.locator('[data-counter="detail-settings"]').click();
  await preview.locator('[data-go="views"]').click();
  await expect(preview.locator('[data-counter="analytics-views"]')).toBeVisible();
  await expect(preview.locator('[data-counter="team-settings"]')).toHaveText("team-settings:1");
  await expect(preview.locator('[data-counter="detail-settings"]')).toHaveText("detail-settings:1");
  await expect(preview.locator('[data-counter="team-layout"]')).toHaveText("team-layout:1");
  await expect(preview.locator('[data-counter="dashboard"]')).toHaveText("dashboard:1");
  await expect(preview.locator('[data-counter="root"]')).toHaveText("root:1");
  await expect(preview.locator("[data-path]")).toHaveText("/dashboard/views?");
  await expect(preview.locator("[data-selection]")).toHaveText(JSON.stringify({ params: {catchall:["dashboard","views"]}, children: ["views"], team: "settings", analytics: ["(__SLOT__)", "views"] }));
  await preview.locator('[data-input="team-settings"]').fill("keep this draft");
  const beforeRefresh = await preview.locator("[data-layout-server]").textContent();
  await preview.evaluate(() => {
    const input = document.querySelector('[data-input="team-settings"]') as HTMLInputElement;
    input.focus();
    (globalThis as Record<string, unknown>).__TEST_DOCUMENT__ = document;
    (globalThis as Record<string, unknown>).__TEST_INPUT__ = input;
    const transport = (globalThis as typeof globalThis & {__TUTO_NEXT_NAVIGATE__?: (kind: string) => void}).__TUTO_NEXT_NAVIGATE__;
    if (transport) transport("refresh");
    else (document.querySelector("[data-refresh]") as HTMLButtonElement).click();
  });
  await expect(preview.locator("[data-layout-server]")).not.toHaveText(beforeRefresh!);
  // Wait for the request to complete without clicking away from the retained input.
  await expect.poll(() => preview.evaluate(() => document.activeElement === (globalThis as Record<string, unknown>).__TEST_INPUT__)).toBe(true);
  await expect(preview.locator('[data-input="team-settings"]')).toHaveValue("keep this draft");
  await expect(preview.locator('[data-counter="detail-settings"]')).toHaveText("detail-settings:1");
  expect(await preview.evaluate(() => document === (globalThis as Record<string, unknown>).__TEST_DOCUMENT__)).toBe(true);
  await preview.locator("[data-back]").click();
  await expect(preview.locator("[data-path]")).toHaveText("/dashboard/settings?tab=team");
  // Stock without Cache Components remounts a branch after leaving it.
  await expect(preview.locator('[data-counter="analytics-home"]')).toHaveText(process.env.TUTO_NEXT_STOCK_URL ? "analytics-home:0" : "analytics-home:1");
  await preview.locator("[data-back]").click();
  await expect(preview.locator('[data-counter="home"]')).toBeVisible();
  await preview.locator("[data-forward]").click();
  await expect(preview.locator('[data-counter="team-settings"]')).toHaveText(process.env.TUTO_NEXT_STOCK_URL ? "team-settings:0" : "team-settings:1");
  await expect(preview.locator('[data-counter="detail-settings"]')).toHaveText(process.env.TUTO_NEXT_STOCK_URL ? "detail-settings:0" : "detail-settings:1");
});

test("refreshes server output while keeping client state and uses hard-load defaults", async ({ page }) => {
  const preview = await openDashboard(page);
  const initial = await preview.locator("[data-server]").textContent();
  await preview.locator('[data-counter="home"]').click();
  await preview.locator("[data-refresh]").click();
  await expect(preview.locator("[data-server]")).not.toHaveText(initial!);
  await expect(preview.locator('[data-counter="home"]')).toHaveText("home:1");
  await preview.locator('[data-go="settings"]').click();
  await expect(preview.locator('[data-counter="analytics-home"]')).toBeVisible();
  await openDashboard(page, "/dashboard/settings");
  await expect(page.locator("[data-analytics-default]")).toBeVisible();
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:0");
});

test("restores intercepted modal history and keeps hard loads canonical", async ({ page }) => {
  const preview = await openDashboard(page);
  await preview.locator('[data-counter="home"]').click();
  await preview.locator('[data-go="photo"]').click();
  await expect(preview.locator("[data-modal]")).toBeVisible();
  await expect(preview.locator('[data-counter="home"]')).toHaveText("home:1");
  await preview.locator('[data-counter="modal"]').click();
  await preview.locator("[data-refresh]").click();
  await expect(preview.locator('[data-counter="modal"]')).toHaveText("modal:1");
  await preview.locator("[data-back]").click();
  await expect(preview.locator("[data-modal]")).not.toBeVisible();
  await expect(preview.locator('[data-counter="home"]')).toHaveText("home:1");
  await preview.locator("[data-forward]").click();
  // Stock without Cache Components remounts visited pages; Tuto retains a bounded Activity cache.
  await expect(preview.locator('[data-counter="modal"]')).toHaveText(process.env.TUTO_NEXT_STOCK_URL ? "modal:0" : "modal:1");
  await openDashboard(page, "/photo/7");
  await expect(page.locator("[data-canonical]")).toHaveText("photo:7");
  await expect(page.locator("[data-modal]")).not.toBeVisible();
});

test("recovers a slot error on refresh and localizes not-found without losing its owner", async ({ page }) => {
  const preview = await openDashboard(page);
  await preview.locator('[data-counter="dashboard"]').click();
  await preview.locator('[data-go="broken"]').click();
  await expect(preview.locator("[data-team-error]")).toBeVisible();
  await preview.locator("[data-team-error]").click();
  await expect(preview.locator("[data-team-recovered]")).toBeVisible();
  await expect(preview.locator('[data-counter="dashboard"]')).toHaveText("dashboard:1");
  await preview.locator('[data-go="missing"]').click();
  await expect(preview.locator("[data-team-not-found]")).toBeVisible();
  await expect(preview.locator('[data-counter="dashboard"]')).toHaveText("dashboard:1");
  await preview.locator('[data-go="home"]').click();
  await expect(preview.locator('[data-counter="team-home"]')).toBeVisible();
});

test("ignores superseded navigation and supports replace and hash scrolling", async ({ page }) => {
  const preview = await openDashboard(page);
  await preview.locator('[data-go="slow"]').click();
  await preview.locator('[data-go="settings"]').click();
  await expect(preview.locator('[data-counter="settings"]')).toBeVisible();
  await expect(preview.locator("[data-slow]")).not.toBeVisible();
  await preview.locator("[data-replace]").click();
  await expect(preview.locator("[data-path]")).toHaveText("/dashboard/views?replaced=yes");
  await preview.locator("[data-back]").click();
  await expect(preview.locator('[data-counter="home"]')).toBeVisible();
  await preview.locator('[data-go="bottom"]').click();
  await expect.poll(() => preview.evaluate(() => window.scrollY)).toBeGreaterThan(500);
});

test("keeps sandboxed preview state and native history without replacing its document", async ({ page }) => {
  test.skip(Boolean(process.env.TUTO_NEXT_STOCK_URL), "Tuto embeds previews in a sandbox.");
  const preview = await openDashboard(page, "/dashboard", true);
  await preview.locator('[data-counter="root"]').click();
  await preview.locator('[data-go="settings"]').click();
  await expect(preview.locator('[data-counter="settings"]')).toBeVisible();
  await preview.locator("[data-back]").click();
  await expect(preview.locator('[data-counter="home"]')).toBeVisible();
  await expect(preview.locator('[data-counter="root"]')).toHaveText("root:1");
});

test("retains implicit children for a slot-only navigation and recovers its default on a hard load", async ({ page }) => {
  const preview = await openDashboard(page);
  await preview.locator('[data-counter="home"]').click();
  await preview.locator('[data-go="team-only"]').click();
  await expect(preview.locator('[data-counter="team-only"]')).toBeVisible();
  await expect(preview.locator('[data-counter="home"]')).toHaveText("home:1");
  await expect(preview.locator('[data-counter="analytics-home"]')).toBeVisible();
  await preview.locator("[data-back]").click();
  await expect(preview.locator('[data-counter="team-home"]')).toBeVisible();
  await openDashboard(page, "/dashboard/team");
  await expect(page.locator("[data-children-default]")).toBeVisible();
  await expect(page.locator('[data-counter="team-only"]')).toBeVisible();
  await expect(page.locator("[data-analytics-default]")).toBeVisible();
});

test("a native iframe reload hard-renders the current capability URL with canonical modal behavior", async ({ page }) => {
  test.skip(Boolean(process.env.TUTO_NEXT_STOCK_URL), "Tuto's private preview capability transport.");
  const endpoint = "http://next-navigation.local/request";
  const control = await POST(new Request(endpoint, {
    body: JSON.stringify({ files: persistentNavigationWorkspace(), workspaceKey: "native-reload", request: { path: "/dashboard" }, streamPreview: true }),
    method: "POST", headers: { "content-type": "application/json" },
  }));
  const payload = await control.json() as { response: { previewUrl: string } };
  expect(payload.response.previewUrl).toContain("preview=");
  await page.route(endpoint + "?preview=**", async (route) => {
    const request = new Request(route.request().url(), {
      body: route.request().postData() ?? undefined,
      method: route.request().method(), headers: route.request().headers(),
    });
    const response = request.method === "GET" ? await GET(request) : await POST(request);
    const body = Buffer.from(await response.arrayBuffer());
    await route.fulfill({ body, headers: Object.fromEntries(response.headers), status: response.status });
  });
  await page.setContent('<iframe sandbox="allow-scripts" title="preview" style="width:100%;height:600px"></iframe>');
  await page.locator("iframe").evaluate((element, url) => { (element as HTMLIFrameElement).src = url; }, new URL(payload.response.previewUrl, endpoint).href);
  const preview = page.frames().find((candidate) => candidate !== page.mainFrame())!;
  await expect(preview.locator('[data-counter="home"]')).toBeVisible();
  await preview.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).__TUTO_NEXT_ROUTER_STATE__), undefined, {timeout:5000});
  await preview.locator('[data-go="photo"]').click();
  await expect(preview.locator("[data-modal]")).toBeVisible();
  await preview.evaluate(() => location.reload());
  await expect(preview.locator("[data-canonical]")).toHaveText("photo:7");
  await expect(preview.locator("[data-modal]")).not.toBeVisible();
  await preview.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).__TUTO_NEXT_ROUTER_STATE__));
  await preview.locator('[data-go="home"]').click();
  await expect(preview.locator('[data-counter="home"]')).toBeVisible();
  await preview.evaluate(() => location.reload());
  await expect(preview.locator('[data-counter="home"]')).toBeVisible();
});
