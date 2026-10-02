import { expect, test } from "@playwright/test";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import { POST } from "../../app/api/serverless/nextjs-runtime/request/route";
import { selectivePrefetchWorkspace } from "../serverless-next/fixtures/selective-prefetch-workspace";

// These cases own manual prefetches; viewport/intent arbitration is covered
// by the scheduler suite. Disable unrelated automatic work in this fixture.
const manualFiles = () =>
  selectivePrefetchWorkspace().map((file) => ({
    ...file,
    content: file.content.replace(
      /<Link (?![^>]*prefetch=)/g,
      "<Link prefetch={false} ",
    ),
  }));

for (const [url, kind, hit] of [
  ["/dashboard/prefetched", "unrelated", "hit"],
  ["/independent", "leaf", "hit"],
  ["/dashboard/prefetched", "leaf", "miss"],
]) {
  test(`full ${url} prefetch ${hit} after ${kind} mutation preserves root state and notifies accurately`, async ({
    page,
  }) => {
    const artifact = await compileNextRequestWorkspace(manualFiles(), {
      workspaceKey: test.info().title,
      serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    });
    const endpoint = "http://selective-prefetch.local/request",
      events: Array<{ prefetch: boolean; hit: string | null; url: string }> =
        [];
    await page.route(endpoint, async (route) => {
      const incoming = route.request(),
        payload = JSON.parse(incoming.postData()!);
      const response = await POST(
        new Request(endpoint, {
          method: "POST",
          body: incoming.postData()!,
          headers: incoming.headers(),
        }),
      );
      if (payload.navigation)
        events.push({
          prefetch: payload.navigation.prefetch === true,
          hit: response.headers.get("x-tuto-next-prefetch"),
          url: payload.navigation.url,
        });
      await route.fulfill({
        body: await response.text(),
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
    });
    await page.setContent(
      await (
        await executeNextRequestArtifact(artifact, {
          url: "/dashboard",
          hydrate: true,
          actionEndpoint: endpoint,
        })
      ).text(),
    );
    await page.waitForFunction(() =>
      Boolean(
        (globalThis as Record<string, unknown>).__TUTO_NEXT_ROUTER_STATE__,
      ),
    );
    await page.locator('[data-counter="root"]').click();
    await page.evaluate(async (href) => {
      const globals = globalThis as Record<string, unknown>;
      globals.__selectiveInvalidations = 0;
      await (
        globals.__TUTO_NEXT_PREFETCH__ as (
          url: string,
          options: unknown,
        ) => Promise<void>
      )(href, {
        onInvalidate: () => {
          globals.__selectiveInvalidations =
            Number(globals.__selectiveInvalidations) + 1;
        },
      });
    }, url);
    expect(
      events.filter((event) => event.prefetch && event.url === url),
    ).toHaveLength(1);
    const mutation = await executeNextRequestArtifact(artifact, {
      url: "/api/revalidate",
      method: "POST",
      body: JSON.stringify({ kind }),
      headers: { "content-type": "application/json" },
    });
    expect(mutation.status).toBe(200);
    await mutation.text();
    await page.evaluate((href) => {
      const globals = globalThis as Record<string, unknown>;
      (globals.__TUTO_NEXT_NAVIGATE__ as (kind: string, url: string) => void)(
        "push",
        href,
      );
    }, url);
    await expect(
      page.locator(
        url === "/independent" ? "[data-independent]" : "[data-tagged-leaf]",
      ),
    ).toHaveText(hit === "miss" ? "2" : "1");
    await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
    expect(events.filter((event) => !event.prefetch).at(-1)?.hit).toBe(hit);
    expect(
      await page.evaluate(
        () => (globalThis as Record<string, unknown>).__selectiveInvalidations,
      ),
    ).toBe(hit === "miss" ? 1 : 0);
  });
}

test("compiled SecureExec production API keeps an unrelated full ticket after a Route Handler mutation", async ({
  page,
}) => {
  const endpoint = process.env.TUTO_NEXT_SELECTIVE_PRODUCTION_ENDPOINT;
  test.skip(
    !endpoint,
    "Requires the built production server with SecureExec selected.",
  );
  const files = manualFiles(),
    workspaceKey = "production-selective-" + Date.now();
  const initial = await fetch(endpoint!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      files,
      workspaceKey,
      streamPreview: true,
      request: { path: "/dashboard" },
    }),
  });
  const payload = await initial.json();
  expect(initial.status, JSON.stringify(payload)).toBe(200);
  expect(JSON.stringify(payload.logs)).toContain("SecureExec V8 isolate");
  const events: Array<string | null> = [];
  page.on("response", (response) => {
    const body = response.request().postData();
    if (
      new URL(response.url()).pathname === new URL(endpoint!).pathname &&
      body
    ) {
      const navigation = JSON.parse(body).navigation;
      if (navigation && !navigation.prefetch)
        events.push(response.headers()["x-tuto-next-prefetch"] ?? null);
    }
  });
  await page.goto(new URL(payload.response.previewUrl, endpoint!).href);
  await page.locator('[data-counter="root"]').click();
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
  await page.evaluate(async () => {
    const globals = globalThis as Record<string, unknown>;
    globals.__productionSelectiveInvalidations = 0;
    await (
      globals.__TUTO_NEXT_PREFETCH__ as (
        url: string,
        options: unknown,
      ) => Promise<void>
    )("/dashboard/prefetched", {
      onInvalidate: () => {
        globals.__productionSelectiveInvalidations =
          Number(globals.__productionSelectiveInvalidations) + 1;
      },
    });
  });
  const mutation = await fetch(endpoint!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      files,
      workspaceKey,
      request: {
        path: "/api/revalidate",
        method: "POST",
        body: '{"kind":"unrelated"}',
        headers: { "content-type": "application/json" },
      },
    }),
  });
  const mutated = await mutation.json();
  expect(mutation.status, JSON.stringify(mutated)).toBe(200);
  expect(mutated.success).toBe(true);
  await page.locator("[data-prefetch-go]").click();
  await expect(page.locator("[data-tagged-leaf]")).toHaveText("1");
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
  expect(events.at(-1)).toBe("hit");
  expect(
    await page.evaluate(
      () =>
        (globalThis as Record<string, unknown>)
          .__productionSelectiveInvalidations,
    ),
  ).toBe(0);
});
