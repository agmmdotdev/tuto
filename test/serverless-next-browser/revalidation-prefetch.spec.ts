import { expect, test, type Page } from "@playwright/test";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import { POST } from "../../app/api/serverless/nextjs-runtime/request/route";
import { revalidationPrefetchWorkspace } from "../serverless-next/fixtures/revalidation-prefetch-workspace";

async function open(page:Page) {
  const endpoint="http://next-revalidation.local/request";
  const artifact=await compileNextRequestWorkspace(revalidationPrefetchWorkspace(),{workspaceKey:test.info().title,serverReferenceHashSalt:"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="});
  const events:Array<{prefetch:boolean;hit:string|null;flight:string;url:string}>=[];
  await page.route(endpoint,async route=>{
    const incoming=route.request(),body=incoming.postData()!;
    const response=await POST(new Request(endpoint,{method:"POST",body,headers:incoming.headers()}));
    const flight=await response.text(),payload=JSON.parse(body);
    if(payload.navigation)events.push({prefetch:payload.navigation.prefetch===true,hit:response.headers.get("x-tuto-next-prefetch"),flight,url:payload.navigation.url});
    await route.fulfill({body:flight,status:response.status,headers:Object.fromEntries(response.headers)});
  });
  await page.setContent(await(await executeNextRequestArtifact(artifact,{url:"/dashboard",hydrate:true,actionEndpoint:endpoint})).text());
  await page.waitForFunction(()=>Boolean((globalThis as Record<string,unknown>).__TUTO_NEXT_ROUTER_STATE__));
  await page.locator('[data-counter="root"]').click();
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
  const mutate=async(kind:string)=>{
    const response=await executeNextRequestArtifact(artifact,{url:"/api/revalidate",method:"POST",body:JSON.stringify({kind}),headers:{"content-type":"application/json"}});
    expect(response.status).toBe(200);await response.text();
  };
  return {events,mutate};
}

for(const kind of ["tag","page"]){
  test(`Route Handler ${kind} mutation rejects warmed Flight and preserves root state`,async({page})=>{
    const {events,mutate}=await open(page);
    await page.locator("[data-prefetch]").click();
    await expect(page.locator("[data-prefetch-status]")).toHaveText("done");
    await mutate(kind);
    await page.locator("[data-prefetch-go]").click();
    await expect(page.locator("[data-tagged-leaf]")).toHaveText("2");
    await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
    await expect(page.locator("[data-invalidations]")).toHaveText("1");
    expect(events.filter(event=>!event.prefetch).at(-1)?.hit).toBe("miss");
  });
}

for(const kind of ["tag","layout","dynamic"]){
  test(`Route Handler ${kind} mutation rejects retained shell/layout receipts before browser display`,async({page})=>{
    const {events,mutate}=await open(page);
    const url=kind==="dynamic"?"/dashboard/shared/three":"/dashboard/shared/one";
    await page.evaluate(async href=>{
      const globals=globalThis as Record<string,unknown>;
      globals.__revalidationNotifications=0;
      await (globals.__TUTO_NEXT_PREFETCH__ as (href:string,options:unknown)=>Promise<void>)(href,{_prefetchMode:"auto",onInvalidate:()=>{globals.__revalidationNotifications=Number(globals.__revalidationNotifications)+1;}});
    },url);
    expect(events.filter(event=>event.prefetch&&event.url===url)).toHaveLength(1);
    await mutate(kind);
    await page.evaluate(href=>{const globals=globalThis as Record<string,unknown>;(globals.__TUTO_NEXT_NAVIGATE__ as (kind:string,href:string)=>void)("push",href);},url);
    // This layout's cached read shares the render's implicit page tags.
    await expect(page.locator("[data-tagged-layout]")).toHaveText("2");
    await expect(page.locator(kind==="dynamic"?"[data-tagged-dynamic]":"[data-shared-page]")).toBeVisible();
    await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
    expect(events.filter(event=>!event.prefetch).at(-1)?.hit).toBe("shell-stream-miss");
    expect(events.filter(event=>!event.prefetch).at(-1)?.flight).toContain("data-tagged-layout");
    expect(await page.evaluate(()=>(globalThis as Record<string,unknown>).__revalidationNotifications)).toBe(1);
  });
}
