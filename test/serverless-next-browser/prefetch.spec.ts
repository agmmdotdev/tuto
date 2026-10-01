import {expect,test,type Page,type Frame} from "@playwright/test";
import {compileNextRequestWorkspace} from "../../lib/serverless-next/compiler";
import {GET,POST} from "../../app/api/serverless/nextjs-runtime/request/route";
import {executeNextRequestArtifact} from "../../lib/serverless-next/runtime";
import {prefetchWorkspace} from "../serverless-next/fixtures/prefetch-workspace";

async function open(page:Page, capability=false) {
 const events:Array<{prefetch:boolean;hit:string|null;url:string}>=[];
 if(process.env.TUTO_NEXT_PREFETCH_STOCK_URL){await page.goto(process.env.TUTO_NEXT_PREFETCH_STOCK_URL+"/dashboard");return {preview:page as Page|Frame,events};}
 const endpoint="http://next-prefetch.local/request";
 const artifact=await compileNextRequestWorkspace(prefetchWorkspace(),{workspaceKey:test.info().title,serverReferenceHashSalt:"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="});
 await page.route(endpoint+"**",async route=>{
  const incoming=route.request();const body=incoming.postData()??undefined;
  const request=new Request(incoming.url(),{method:incoming.method(),body,headers:incoming.headers()});
  const response=incoming.method()==="GET"?await GET(request):await POST(request);
  const payload=body?JSON.parse(body):{};
  if(payload.navigation)events.push({prefetch:payload.navigation.prefetch===true,hit:response.headers.get("x-tuto-next-prefetch"),url:payload.navigation.url});
  await route.fulfill({body:Buffer.from(await response.arrayBuffer()),status:response.status,headers:Object.fromEntries(response.headers)});
 });
 let preview:Page|Frame=page;
 if(capability){
  const control=await POST(new Request(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({files:prefetchWorkspace(),workspaceKey:test.info().title,request:{path:"/dashboard"},streamPreview:true})}));
  const payload=await control.json();
  await page.setContent('<iframe sandbox="allow-scripts" title="preview" style="width:100%;height:600px"></iframe>');
  await page.locator("iframe").evaluate((element,url)=>{(element as HTMLIFrameElement).src=url;},new URL(payload.response.previewUrl,endpoint).href);
  preview=page.frames().find(frame=>frame!==page.mainFrame())!;
 }else await page.setContent(await (await executeNextRequestArtifact(artifact,{url:"/dashboard",hydrate:true,actionEndpoint:endpoint,headers:{"x-tenant":"one"}})).text());
 await expect(preview.locator('[data-counter="home"]')).toBeVisible();
 await preview.waitForFunction(()=>Boolean((globalThis as Record<string,unknown>).__TUTO_NEXT_ROUTER_STATE__),undefined,{timeout:5000});
 return {preview,events,artifact};
}
async function warm(preview:Page|Frame,href="/dashboard/prefetched"){
 await preview.locator("[data-prefetch-href]").fill(href);
 await preview.locator("[data-prefetch]").click();
 await expect(preview.locator("[data-prefetch-status]")).toHaveText("done");
}

test("manual prefetch deduplicates without rendering, changing URL or history, then consumes the ticket once",async({page})=>{
 const {preview,events}=await open(page);
 await preview.locator('[data-counter="root"]').click();
 await expect(preview.locator('[data-counter="root"]')).toHaveText("root:1");
 const before=await preview.locator('[data-server]').textContent();
 await warm(preview);
 await warm(preview);
 if(!process.env.TUTO_NEXT_PREFETCH_STOCK_URL) expect(events.filter(event=>event.prefetch)).toHaveLength(1);
 await expect(preview.locator('[data-counter="prefetched"]')).not.toBeVisible();
 await expect(preview.locator('[data-path]')).toHaveText("/dashboard?");
 await expect(preview.locator('[data-server]')).toHaveText(before!);
 await preview.locator('[data-prefetch-go]').click();
 await expect(preview.locator('[data-counter="prefetched"]')).toBeVisible();
 if(!process.env.TUTO_NEXT_PREFETCH_STOCK_URL) expect(events.filter(event=>!event.prefetch).at(-1)?.hit).toBe("hit");
 await expect(preview.locator('[data-counter="root"]')).toHaveText("root:1");
 await preview.locator('[data-back]').click();
 await expect(preview.locator('[data-path]')).toHaveText("/dashboard?");
});

test("refresh invalidates an unused prefetch and notifies each callback once",async({page})=>{
 const {preview,events}=await open(page);
 await warm(preview);
 await preview.locator('[data-refresh]').click();
 await expect(preview.locator('[data-invalidations]')).toHaveText(process.env.TUTO_NEXT_PREFETCH_STOCK_URL ? "0" : "1");
 await preview.locator('[data-refresh]').click();
 await expect(preview.locator('[data-invalidations]')).toHaveText(process.env.TUTO_NEXT_PREFETCH_STOCK_URL ? "0" : "1");
 await preview.locator('[data-prefetch-go]').click();
 await expect(preview.locator('[data-counter="prefetched"]')).toBeVisible();
 if(!process.env.TUTO_NEXT_PREFETCH_STOCK_URL) expect(events.filter(event=>!event.prefetch).at(-1)?.hit).toBe("miss");
});

test("server actions invalidate warmed data and virtual cookie context before navigation",async({page})=>{
 const {preview,events}=await open(page);
 await warm(preview);
 await preview.locator('[data-mutate]').click();
 await expect(preview.locator('[data-prefetch-status]')).toHaveText("changed");
 await expect(preview.locator('[data-invalidations]')).toHaveText(process.env.TUTO_NEXT_PREFETCH_STOCK_URL ? "0" : "1");
 await preview.locator('[data-prefetch-go]').click();
 // The counter is Tuto artifact-local state; stock action/RSC bundles do not share this module.
 if(!process.env.TUTO_NEXT_PREFETCH_STOCK_URL) await expect(preview.locator('[data-prefetched]')).toContainText('"version":1');
 await expect(preview.locator('[data-prefetched]')).toContainText('"identity":"signed-in"');
 if(!process.env.TUTO_NEXT_PREFETCH_STOCK_URL) expect(events.filter(event=>!event.prefetch).at(-1)?.hit).toBe("miss");
});

test("prefetched interception preserves background and native reload remains canonical",async({page})=>{
 test.skip(Boolean(process.env.TUTO_NEXT_PREFETCH_STOCK_URL),"Exercises the private Tuto reload capability.");
 const {preview,events}=await open(page,true);
 await preview.locator('[data-counter="home"]').click();
 await warm(preview,"/photo/7");
 await preview.evaluate(()=>location.reload());
 await expect(preview.locator('[data-counter="home"]')).toBeVisible();
 await preview.waitForFunction(()=>Boolean((globalThis as Record<string,unknown>).__TUTO_NEXT_ROUTER_STATE__),undefined,{timeout:5000});
 await warm(preview,"/photo/7");
 await preview.locator('[data-prefetch-go]').click();
 await expect(preview.locator('[data-modal]')).toBeVisible();
 if(!process.env.TUTO_NEXT_PREFETCH_STOCK_URL) expect(events.filter(event=>!event.prefetch).at(-1)?.hit).toBe("hit");
 await preview.evaluate(()=>location.reload());
 await expect(preview.locator('[data-canonical]')).toHaveText("photo:7");
 await expect(preview.locator('[data-modal]')).not.toBeVisible();
});

test("slot-context changes discard prefetch selections and fresh warming retains active unmatched slots",async({page})=>{
 const {preview,events}=await open(page);
 await warm(preview,"/dashboard/views");
 await preview.locator('[data-go="settings"]').click();
 await expect(preview.locator('[data-counter="team-settings"]')).toBeVisible();
 await warm(preview,"/dashboard/views");
 await preview.locator('[data-prefetch-go]').click();
 await expect(preview.locator('[data-counter="analytics-views"]')).toBeVisible();
 await expect(preview.locator('[data-counter="team-settings"]')).toBeVisible();
 if(!process.env.TUTO_NEXT_PREFETCH_STOCK_URL) expect(events.filter(event=>!event.prefetch).at(-1)?.hit).toBe("hit");
});


test("expires a deduplicated prefetch and calls each subscriber once",async({page})=>{
 test.skip(Boolean(process.env.TUTO_NEXT_PREFETCH_STOCK_URL),"Tuto uses an explicit conservative 30-second ticket lifetime.");
 const {preview,events}=await open(page);
 await page.clock.install();
 await warm(preview);await warm(preview);
 await page.clock.fastForward(30_001);
 await expect(preview.locator('[data-invalidations]')).toHaveText("2");
 await page.clock.fastForward(30_001);
 await expect(preview.locator('[data-invalidations]')).toHaveText("2");
 await preview.locator('[data-prefetch-go]').click();
 await expect(preview.locator('[data-counter="prefetched"]')).toBeVisible();
 expect(events.filter(event=>!event.prefetch).at(-1)?.hit).toBe("miss");
});


test("a ticket invalidated by another document falls back to fresh Flight and notifies its subscriber",async({page})=>{
 test.skip(Boolean(process.env.TUTO_NEXT_PREFETCH_STOCK_URL),"Exercises Tuto's process-local ticket invalidation.");
 const {preview,events,artifact}=await open(page);
 await warm(preview);
 const actionId=Object.entries(artifact!.actionManifest).find(([,reference])=>reference.exportName==="change")![0];
 const action=await POST(new Request("http://tuto.local/request",{method:"POST",headers:{"content-type":"text/plain"},body:JSON.stringify({action:{revision:artifact!.revision,url:"/dashboard",actionId,body:{kind:"string",value:"[]"}}})}));
 expect(action.status).toBe(200);await action.text();
 await preview.locator('[data-prefetch-go]').click();
 await expect(preview.locator('[data-prefetched]')).toContainText('"version":1');
 await expect(preview.locator('[data-prefetched]')).toContainText('"identity":"anonymous"');
 await expect(preview.locator('[data-invalidations]')).toHaveText("1");
 expect(events.filter(event=>!event.prefetch).at(-1)?.hit).toBe("miss");
});
