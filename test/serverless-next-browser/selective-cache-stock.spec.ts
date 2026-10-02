import { expect, test } from "@playwright/test";

// Pinned Next 16.3.6 documents compare data dependencies and path scope. Next's
// client Router Cache is not our private, server-validated prefetch protocol.
const stock = process.env.TUTO_NEXT_SELECTIVE_STOCK_URL;
test.skip(!stock, "Requires the pinned selective cache fixture server.");

test("stock tag revalidation leaves independently tagged data cached", async ({
  page,
  request,
}) => {
  await page.goto(stock + "/independent");
  const independent = await page.locator("[data-independent]").textContent();
  await page.goto(stock + "/dashboard/prefetched");
  const before = await page.locator("[data-tagged-leaf]").textContent();
  expect(
    (
      await request.post(stock + "/api/revalidate", { data: { kind: "leaf" } })
    ).status(),
  ).toBe(200);
  await page.goto(stock + "/dashboard/prefetched");
  await expect(page.locator("[data-tagged-leaf]")).not.toHaveText(before!);
  await page.goto(stock + "/independent");
  await expect(page.locator("[data-independent]")).toHaveText(independent!);
});

test("stock page-path revalidation leaves another page sharing the same tag cached until the affected path is visited", async ({
  page,
  request,
}) => {
  await page.goto(stock + "/dashboard/prefetched");
  const before = await page.locator("[data-tagged-leaf]").textContent();
  await page.goto(stock + "/also-leaf");
  await expect(page.locator("[data-also-leaf]")).toHaveText(before!);
  expect(
    (
      await request.post(stock + "/api/revalidate", { data: { kind: "page" } })
    ).status(),
  ).toBe(200);
  await page.goto(stock + "/also-leaf");
  await expect(page.locator("[data-also-leaf]")).toHaveText(before!);
  await page.goto(stock + "/dashboard/prefetched");
  await expect(page.locator("[data-tagged-leaf]")).not.toHaveText(before!);
});

test("stock shared-key reads validate the current wrapper tags rather than the first wrapper tags", async ({
  page,
  request,
}) => {
  await page.goto(stock + "/first-key");
  const before = await page.locator("[data-shared-key]").textContent();
  await page.goto(stock + "/second-key");
  await expect(page.locator("[data-shared-key]")).toHaveText(before!);
  expect(
    (
      await request.post(stock + "/api/revalidate", {
        data: { kind: "first-tag" },
      })
    ).status(),
  ).toBe(200);
  await page.goto(stock + "/second-key");
  // Tuto deliberately checks stored and current tags. Its conservative miss
  // is tested separately; pinned Next checks the current wrapper tag here.
  await expect(page.locator("[data-shared-key]")).toHaveText(before!);
});
