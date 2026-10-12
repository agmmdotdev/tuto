import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import {
  POST,
  OPTIONS,
} from "../../app/api/serverless/nextjs-runtime/request/route";
import { selectiveShellWorkspace } from "../serverless-next/fixtures/selective-shell-workspace";

const servers: Server[] = [];
test.afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function open(page: Page, gate: Promise<void>) {
  const artifact = await compileNextRequestWorkspace(
    selectiveShellWorkspace(),
    {
      workspaceKey: test.info().title,
      serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    },
  );
  const events: Array<{
    url: string;
    prefetch: boolean;
    hit: string | null;
    headers: boolean;
    flight: string;
  }> = [];
  const server = createServer((request, outgoing) => {
    void (async () => {
      const controller = new AbortController();
      outgoing.on("close", () => {
        if (!outgoing.writableFinished) controller.abort();
      });
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const navigation = body ? JSON.parse(body).navigation : undefined;
      const event = navigation
        ? {
            url: navigation.url,
            prefetch: navigation.prefetch === true,
            hit: null as string | null,
            headers: false,
            flight: "",
          }
        : undefined;
      if (event) events.push(event);
      const response =
        request.method === "OPTIONS"
          ? OPTIONS()
          : await POST(
              new Request("http://tuto.local/request", {
                method: "POST",
                body,
                headers: { "content-type": "text/plain" },
                signal: controller.signal,
              }),
            );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.flushHeaders();
      if (event) {
        event.hit = response.headers.get("x-tuto-next-prefetch");
        event.headers = true;
      }
      if (event && !event.prefetch) await gate;
      controller.signal.throwIfAborted();
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (event) event.flight += new TextDecoder().decode(chunk.value);
          if (!outgoing.write(chunk.value)) await once(outgoing, "drain");
        }
      }
      outgoing.end();
    })().catch((error) => {
      if (!outgoing.destroyed) outgoing.destroy(error as Error);
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await page.setContent(
    await (
      await executeNextRequestArtifact(artifact, {
        url: "/dashboard",
        hydrate: true,
        actionEndpoint: `http://127.0.0.1:${port}/request`,
      })
    ).text(),
  );
  await page.waitForFunction(() =>
    Boolean((globalThis as Record<string, unknown>).__TUTO_NEXT_ROUTER_STATE__),
  );
  await page.locator('[data-counter="root"]').click();
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
  return {
    events,
    async mutate(kind: string) {
      const response = await executeNextRequestArtifact(artifact, {
        url: "/api/revalidate",
        method: "POST",
        body: JSON.stringify({ kind }),
        headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(200);
      await response.text();
    },
  };
}
async function warm(page: Page, url: string) {
  await page.evaluate(async (url) => {
    const globals = globalThis as Record<string, unknown>;
    globals.__shellInvalidations ??= {};
    const notifications = globals.__shellInvalidations as Record<
      string,
      number
    >;
    notifications[url] ??= 0;
    await (
      globals.__TUTO_NEXT_PREFETCH__ as (
        url: string,
        options: unknown,
      ) => Promise<void>
    )(url, {
      _prefetchMode: "auto",
      onInvalidate: () => {
        notifications[url]++;
      },
    });
  }, url);
}
async function go(page: Page, url: string) {
  await page.evaluate((url) => {
    const globals = globalThis as Record<string, unknown>;
    (globals.__TUTO_NEXT_NAVIGATE__ as (kind: string, url: string) => void)(
      "push",
      url,
    );
  }, url);
}

test("an unrelated mutation preserves interactive loading/root/layout models and streams fresh nested slots", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { events, mutate } = await open(page, gate);
  try {
    await warm(page, "/dashboard/shared/one");
    await mutate("unrelated");
    await go(page, "/dashboard/shared/one");
    await expect(page.locator("[data-cached-loading]:visible")).toHaveText(
      "loading:1",
    );
    await expect(page.locator("[data-tagged-layout]")).toHaveText("1");
    await expect(page.locator("[data-cached-root]")).toHaveText("1");
    await page.locator('[data-counter="root"]').click();
    await page.locator('[data-counter="shared-layout"]').click();
    release();
    await expect(page.locator("[data-shared-page]:visible")).toHaveText(
      "one:1:anonymous",
    );
    await expect(page.locator('[data-counter="root"]')).toHaveText("root:2");
    await expect(page.locator('[data-counter="shared-layout"]')).toHaveText(
      "shared-layout:1",
    );
    await expect(page.locator('[data-counter="team-one"]')).toBeVisible();
    await expect(page.locator('[data-counter="detail-one"]')).toBeVisible();
    const fresh = events.filter((event) => !event.prefetch).at(-1)!;
    expect(fresh.hit).toBe("shell-stream-hit");
    expect(fresh.flight).not.toContain("data-tagged-layout");
    expect(fresh.flight).not.toContain("data-cached-loading");
    expect(
      await page.evaluate(
        () =>
          (
            (globalThis as Record<string, unknown>)
              .__shellInvalidations as Record<string, number>
          )["/dashboard/shared/one"],
      ),
    ).toBe(0);
  } finally {
    release();
  }
});

for (const kind of ["layout-tag", "root"]) {
  test(`${kind} invalidation rejects an inherited shell, refreshes dependent models and preserves client state`, async ({
    page,
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { events, mutate } = await open(page, gate);
    try {
      await warm(page, "/start");
      await warm(page, "/dashboard/shared/one");
      await mutate(kind);
      await go(page, "/dashboard/shared/one");
      await expect
        .poll(() => events.some((event) => !event.prefetch && event.headers))
        .toBe(true);
      await expect(page.locator("[data-tagged-layout]")).toHaveCount(0);
      await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
      release();
      await expect(page.locator("[data-shared-page]:visible")).toHaveText(
        "one:1:anonymous",
      );
      await expect(page.locator("[data-tagged-layout]")).toHaveText(
        kind === "layout-tag" ? "2" : "1",
      );
      await expect(page.locator("[data-cached-root]")).toHaveText(
        kind === "root" ? "2" : "1",
      );
      await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
      const fresh = events.filter((event) => !event.prefetch).at(-1)!;
      expect(fresh.hit).toBe("shell-stream-miss");
      if (kind === "layout-tag")
        expect(fresh.flight).not.toContain("data-cached-root");
      else expect(fresh.flight).toContain("data-cached-root");
      expect(
        await page.evaluate(
          () =>
            (
              (globalThis as Record<string, unknown>)
                .__shellInvalidations as Record<string, number>
            )["/dashboard/shared/one"],
        ),
      ).toBe(1);
    } finally {
      release();
    }
  });
}
