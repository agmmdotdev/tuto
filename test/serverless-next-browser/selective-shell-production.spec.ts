import { expect, test } from "@playwright/test";
import { selectiveShellWorkspace } from "../serverless-next/fixtures/selective-shell-workspace";

for (const kind of ["unrelated", "layout-tag", "root"]) {
  test(`compiled SecureExec ${kind} mutation validates selective shell models`, async ({
    page,
  }) => {
    const endpoint = process.env.TUTO_NEXT_SHELL_PRODUCTION_ENDPOINT;
    test.skip(!endpoint, "Requires the built SecureExec production API.");
    const files = selectiveShellWorkspace();
    const workspaceKey = `production-shell-${kind}-${Date.now()}`;
    const control = async (request: unknown, streamPreview = false) => {
      const response = await fetch(endpoint!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files, workspaceKey, request, streamPreview }),
      });
      const payload = await response.json();
      expect(response.status, JSON.stringify(payload)).toBe(200);
      expect(payload.success).toBe(true);
      return payload;
    };
    const initial = await control({ path: "/dashboard" }, true);
    expect(JSON.stringify(initial.logs)).toContain("SecureExec V8 isolate");
    const events: Array<{ hit: string | undefined }> = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname !== new URL(endpoint!).pathname)
        return;
      const data = response.request().postData();
      const navigation = data && JSON.parse(data).navigation;
      if (navigation && !navigation.prefetch)
        events.push({
          hit: response.headers()["x-tuto-next-prefetch"],
        });
    });
    await page.addInitScript(() => {
      const globals = globalThis as Record<string, unknown>;
      globals.__productionShellFlight = undefined;
      const original = globalThis.fetch;
      globalThis.fetch = async (...args) => {
        const response = await original(...args);
        const body = args[1]?.body;
        if (typeof body === "string") {
          const navigation = JSON.parse(body).navigation;
          if (navigation && !navigation.prefetch)
            void response
              .clone()
              .text()
              .then((flight) => {
                globals.__productionShellFlight = flight;
              });
        }
        return response;
      };
    });
    await page.goto(new URL(initial.response.previewUrl, endpoint!).href);
    await page.locator('[data-counter="root"]').click();
    await page.evaluate(async () => {
      const prefetch = (globalThis as Record<string, unknown>)
        .__TUTO_NEXT_PREFETCH__ as (
        url: string,
        options: unknown,
      ) => Promise<void>;
      await prefetch("/start", { _prefetchMode: "auto" });
      await prefetch("/dashboard/shared/one", { _prefetchMode: "auto" });
    });
    await control({
      path: "/api/revalidate",
      method: "POST",
      body: JSON.stringify({ kind }),
      headers: { "content-type": "application/json" },
    });
    await page.evaluate(() => {
      (
        (globalThis as Record<string, unknown>).__TUTO_NEXT_NAVIGATE__ as (
          kind: string,
          url: string,
        ) => void
      )("push", "/dashboard/shared/one");
    });
    await expect(page.locator("[data-shared-page]:visible")).toHaveText(
      "one:1:anonymous",
    );
    await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
    await expect(page.locator("[data-cached-root]")).toHaveText(
      kind === "root" ? "2" : "1",
    );
    await expect(page.locator("[data-tagged-layout]")).toHaveText(
      kind === "layout-tag" ? "2" : "1",
    );
    expect(events.at(-1)?.hit).toBe(
      kind === "unrelated" ? "shell-stream-hit" : "shell-stream-miss",
    );
    await page.waitForFunction(
      () =>
        typeof (globalThis as Record<string, unknown>)
          .__productionShellFlight === "string",
    );
    const flight = await page.evaluate(
      () =>
        (globalThis as Record<string, unknown>)
          .__productionShellFlight as string,
    );
    if (kind === "root") expect(flight).toContain("data-cached-root");
    else expect(flight).not.toContain("data-cached-root");
    if (kind === "layout-tag") expect(flight).toContain("data-tagged-layout");
    if (kind === "unrelated")
      expect(flight).not.toContain("data-tagged-layout");
  });
}

for (const kind of ["unrelated", "layout-tag", "root"]) {
  test(`stock Next16.3.6 ${kind} mutation updates only dependent cached data`, async ({
    page,
    request,
  }) => {
    const origin = process.env.TUTO_NEXT_SHELL_STOCK_ORIGIN;
    test.skip(
      !origin,
      "Requires the stock production fixture with cacheComponents and clock-valued cache probes.",
    );
    await page.goto(origin! + "/dashboard/shared/one");
    await expect(page.locator("[data-shared-page]:visible")).toBeVisible();
    const root = await page.locator("[data-cached-root]").textContent();
    const layout = await page.locator("[data-tagged-layout]").textContent();
    const mutation = await request.post(origin! + "/api/revalidate", {
      data: { kind },
    });
    expect(mutation.status()).toBe(200);
    // A hard request reads the stock data cache rather than Next's separate
    // client Router Cache. These probes compare data semantics, not Tuto tickets.
    await page.reload();
    await expect(page.locator("[data-shared-page]:visible")).toBeVisible();
    if (kind === "root")
      expect(await page.locator("[data-cached-root]").textContent()).not.toBe(
        root,
      );
    else await expect(page.locator("[data-cached-root]")).toHaveText(root!);
    if (kind === "layout-tag")
      expect(await page.locator("[data-tagged-layout]").textContent()).not.toBe(
        layout,
      );
    else await expect(page.locator("[data-tagged-layout]")).toHaveText(layout!);
  });
}
