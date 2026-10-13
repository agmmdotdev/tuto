import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("stock Next root-parameter coarse/specific partitions isolate tenants across short revalidation", async ({ page }) => {
  const stock = process.env.TUTO_NEXT_CACHE_LIFETIME_STOCK_ORIGIN;
  test.skip(!stock, "Requires the pinned stock Cache Components production fixture.");
  const tenantA = "a-" + randomUUID(), tenantB = "b-" + randomUUID();
  const other = await page.context().newPage();
  async function read(target: typeof page, tenant: string) {
    await target.goto(stock! + "/" + tenant);
    await expect(target.locator("[data-root-partition]")).toBeVisible();
    return JSON.parse((await target.locator("[data-root-partition]").textContent())!);
  }
  try {
    expect(await read(page, tenantA)).toEqual({ id: tenantA, value: 1 });
    expect(await read(other, tenantB)).toEqual({ id: tenantB, value: 1 });
    expect(await read(page, tenantA)).toEqual({ id: tenantA, value: 1 });
    await page.waitForTimeout(2150);
    // Built-in stock production memory caching blocks for a fresh partition
    // at revalidation. Tuto's handler-only probes cover its SWR clock policy;
    // they do not establish learner-facing root-params API support.
    expect(await read(page, tenantA)).toEqual({ id: tenantA, value: 2 });
    expect(await read(other, tenantB)).toEqual({ id: tenantB, value: 2 });
  } finally { await other.close(); }
});
