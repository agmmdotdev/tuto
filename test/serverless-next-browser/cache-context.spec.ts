import { expect, test } from "@playwright/test";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import { POST } from "../../app/api/serverless/nextjs-runtime/request/route";
import { cacheContextWorkspace } from "../serverless-next/fixtures/cache-context-workspace";

test("nested cached components hydrate, navigate and invalidate while preserving root/client state", async ({
  page,
}) => {
  const endpoint = "http://next-cache-context.local/request";
  const artifact = await compileNextRequestWorkspace(cacheContextWorkspace(), {
    workspaceKey: test.info().title,
    serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  });
  await page.route(endpoint, async (route) => {
    const incoming = route.request();
    const response = await POST(
      new Request(endpoint, {
        method: "POST",
        body: incoming.postData()!,
        headers: incoming.headers(),
      }),
    );
    await route.fulfill({
      body: await response.text(),
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  });
  await page.setContent(
    await (
      await executeNextRequestArtifact(artifact, {
        url: "/",
        hydrate: true,
        actionEndpoint: endpoint,
        headers: { "x-tenant": "browser", cookie: "session=browser-private" },
      })
    ).text(),
  );
  await page.locator("[data-root-count]").click();
  await expect(page.locator("[data-root-count]")).toHaveText("root:1");
  await page.locator("[data-go]").click();
  await expect(page.locator('[data-card="a"]')).toHaveText("a:browser:1");
  await expect(page.locator('[data-card="b"]')).toHaveText("b:browser:1");
  await expect(page.locator("[data-session]")).toHaveText("browser-private");
  await page.locator('[data-card-count="a"]').click();
  await expect(page.locator('[data-card-count="a"]')).toHaveText("a:1");
  const mutation = await executeNextRequestArtifact(artifact, {
    url: "/api/revalidate",
    method: "POST",
    body: '{"id":"a"}',
    headers: { "content-type": "application/json" },
  });
  expect(mutation.status).toBe(200);
  await mutation.text();
  await page.locator("[data-refresh]").click();
  await expect(page.locator('[data-card="a"]')).toHaveText("a:browser:2");
  await expect(page.locator('[data-card="b"]')).toHaveText("b:browser:1");
  await expect(page.locator("[data-root-count]")).toHaveText("root:1");
  await expect(page.locator('[data-card-count="a"]')).toHaveText("a:1");
  await expect(page.locator("[data-session]")).toHaveText("browser-private");
});

const stock = process.env.TUTO_NEXT_CACHE_CONTEXT_STOCK_URL;

test("compiled production SecureExec API preserves nested cache scopes through navigation and refresh", async ({
  page,
}) => {
  const endpoint = process.env.TUTO_NEXT_CACHE_CONTEXT_PRODUCTION_ENDPOINT;
  test.skip(
    !endpoint,
    "Requires the built production server with SecureExec selected.",
  );
  const files = cacheContextWorkspace();
  const workspaceKey = "production-cache-context-" + Date.now();
  const initial = await fetch(endpoint!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      files,
      workspaceKey,
      streamPreview: true,
      request: {
        path: "/",
        headers: {
          "x-tenant": "production",
          cookie: "session=production-private",
        },
      },
    }),
  });
  const payload = await initial.json();
  expect(initial.status, JSON.stringify(payload)).toBe(200);
  expect(JSON.stringify(payload.logs)).toContain("SecureExec V8 isolate");
  await page.goto(new URL(payload.response.previewUrl, endpoint!).href);
  await page.locator("[data-root-count]").click();
  await expect(page.locator("[data-root-count]")).toHaveText("root:1");
  await page.locator("[data-go]").click();
  await expect(page.locator('[data-card="a"]')).toHaveText("a:production:1");
  await expect(page.locator('[data-card="b"]')).toHaveText("b:production:1");
  await expect(page.locator("[data-session]")).toHaveText("production-private");
  await page.locator('[data-card-count="a"]').click();
  await expect(page.locator('[data-card-count="a"]')).toHaveText("a:1");
  const mutation = await fetch(endpoint!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      files,
      workspaceKey,
      request: {
        path: "/api/revalidate",
        method: "POST",
        body: '{"id":"a"}',
        headers: { "content-type": "application/json" },
      },
    }),
  });
  const mutated = await mutation.json();
  expect(mutation.status, JSON.stringify(mutated)).toBe(200);
  expect(mutated.success).toBe(true);
  await page.locator("[data-refresh]").click();
  await expect(page.locator('[data-card="a"]')).toHaveText("a:production:2");
  await expect(page.locator('[data-card="b"]')).toHaveText("b:production:1");
  await expect(page.locator("[data-root-count]")).toHaveText("root:1");
  await expect(page.locator('[data-card-count="a"]')).toHaveText("a:1");
});

test("stock Next nested cache tags and delayed request reads remain separate", async ({
  page,
  request,
}) => {
  test.skip(
    !stock,
    "Requires the pinned Cache Components stock fixture server.",
  );
  const tenant = "stock-" + Date.now();
  await page.context().setExtraHTTPHeaders({ "x-tenant": tenant });
  await page
    .context()
    .addCookies([{ name: "session", value: "stock-private", url: stock! }]);
  await page.goto(stock! + "/cards");
  await expect(page.locator('[data-card="a"]')).toHaveText(`a:${tenant}:1`);
  await expect(page.locator('[data-card="b"]')).toHaveText(`b:${tenant}:1`);
  await expect(page.locator("[data-session]")).toHaveText("stock-private");
  const response = await request.post(stock! + "/api/revalidate", {
    data: { id: "a" },
  });
  expect(response.status()).toBe(200);
  await page.goto(stock! + "/cards");
  await expect(page.locator('[data-card="a"]')).toHaveText(`a:${tenant}:2`);
  await expect(page.locator('[data-card="b"]')).toHaveText(`b:${tenant}:1`);
  await expect(page.locator("[data-session]")).toHaveText("stock-private");
});

for (const kind of ["await", "then", "timer"]) {
  test(`stock Next public cache rejects request cookies in ${kind} continuations`, async ({
    request,
  }) => {
    test.skip(
      !stock,
      "Requires the pinned Cache Components stock fixture server.",
    );
    const response = await request.get(stock! + "/api/unsafe?kind=" + kind, {
      headers: { cookie: "session=secret" },
    });
    expect(response.status()).toBe(400);
    const payload = await response.json();
    expect(payload.blocked).toBe(true);
    expect(typeof payload.message).toBe("string");
    expect(payload).not.toHaveProperty("value");
    expect(JSON.stringify(payload)).not.toContain("secret");
  });
}
