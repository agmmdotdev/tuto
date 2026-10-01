import { expect, test } from "@playwright/test";

// Run against a pinned production Next 16.3.6 server built from the shared
// revalidation fixture. These compare data-cache behavior, not private tickets
// or Next's already-held client Router Cache after an out-of-band mutation.
const stock=process.env.TUTO_NEXT_REVALIDATION_STOCK_URL;
test.skip(!stock,"Requires the pinned stock revalidation fixture server.");
for(const kind of ["tag","page","layout","dynamic","max"]){
  test(`stock Next ${kind} invalidation revalidates on the next document request`,async({page,request})=>{
    const url=kind==="layout"?"/dashboard/shared/one":kind==="dynamic"?"/dashboard/shared/three":"/dashboard/prefetched";
    const selector=kind==="layout"?"[data-tagged-layout]":kind==="dynamic"?"[data-tagged-dynamic]":"[data-tagged-leaf]";
    await page.goto(stock+url);
    const before=await page.locator(selector).textContent();
    const mutation=await request.post(stock+"/api/revalidate",{data:{kind}});expect(mutation.status()).toBe(200);
    await page.goto(stock+url);
    if(kind==="max")await expect(page.locator(selector)).toHaveText(before!);
    await expect.poll(async()=>{await page.goto(stock+url);return page.locator(selector).textContent();}).not.toBe(before);
  });
}
