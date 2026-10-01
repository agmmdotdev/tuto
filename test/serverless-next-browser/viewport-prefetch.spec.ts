import {expect,test,type Page} from "@playwright/test";
import {createServer,type Server} from "node:http";
import {once} from "node:events";
import {compileNextRequestWorkspace} from "../../lib/serverless-next/compiler";
import {POST,OPTIONS} from "../../app/api/serverless/nextjs-runtime/request/route";
import {executeNextRequestArtifact} from "../../lib/serverless-next/runtime";
import {viewportPrefetchWorkspace} from "../serverless-next/fixtures/viewport-prefetch-workspace";

const stock = process.env.TUTO_NEXT_VIEWPORT_STOCK_URL;
const servers:Server[]=[];
test.afterEach(async()=>{
 for(const server of servers.splice(0)){
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
 }
});
async function open(page:Page,delayPrefetch=0,delayNavigation=0){
 const stats={cancelled:0,events:[] as Array<{prefetch:boolean;url:string;hit?:string|null;done?:boolean;cookie?:string}>};
 if(stock){await page.goto(stock+"/dashboard");await expect(page.locator('[data-counter="home"]')).toBeVisible();return stats;}
 const artifact=await compileNextRequestWorkspace(viewportPrefetchWorkspace(),{
  workspaceKey:test.info().title,serverReferenceHashSalt:"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
 });
 const server=createServer((request,outgoing)=>{
  void(async()=>{
   const controller=new AbortController();
   outgoing.on("close",()=>{if(!outgoing.writableFinished){stats.cancelled++;controller.abort();}});
   const chunks=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
   const body=Buffer.concat(chunks).toString();
   const input=body?JSON.parse(body):{};
   const event=input.navigation?{prefetch:input.navigation.prefetch===true,url:input.navigation.url,cookie:input.navigation.headers?.cookie,hit:null as string|null,done:false}:undefined;
   if(event)stats.events.push(event);
   const delay=event?.prefetch?delayPrefetch:delayNavigation;
   if(event&&delay)await new Promise(resolve=>setTimeout(resolve,delay));
   controller.signal.throwIfAborted();
   const response=request.method==="OPTIONS"?OPTIONS():await POST(new Request("http://tuto.local/request",{
    method:"POST",body,headers:{"content-type":"text/plain"},signal:controller.signal,
   }));
   if(event)event.hit=response.headers.get("x-tuto-next-prefetch");
   outgoing.writeHead(response.status,Object.fromEntries(response.headers));
   if(response.body){const reader=response.body.getReader();for(;;){const chunk=await reader.read();if(chunk.done)break;if(!outgoing.write(chunk.value))await once(outgoing,"drain");}}
   outgoing.end();if(event)event.done=true;
  })().catch(error=>{if(!outgoing.destroyed)outgoing.destroy(error as Error);});
 });
 servers.push(server);server.listen(0,"127.0.0.1");await once(server,"listening");
 const port=(server.address() as {port:number}).port;
 await page.setContent(await(await executeNextRequestArtifact(artifact,{url:"/dashboard",hydrate:true,actionEndpoint:`http://127.0.0.1:${port}/request`})).text());
 await page.waitForFunction(()=>Boolean((globalThis as Record<string,unknown>).__TUTO_NEXT_ROUTER_STATE__));
 return stats;
}
const visible=(page:Page)=>page.locator('[data-viewport="visible"]');
const offscreen=(page:Page)=>page.locator('[data-viewport="offscreen"]');
test("visible Link warms without intent, distant and disabled Links do not",async({page})=>{
 const requests:string[]=[];page.on("request",request=>{if(request.headers()["next-router-prefetch"])requests.push(request.url());});
 const stats=await open(page);
 if(stock){await expect.poll(()=>requests.some(url=>url.includes("intent-one"))).toBe(true);expect(requests.some(url=>url.includes("intent-two"))).toBe(false);}
 else {await expect.poll(()=>stats.events.filter(event=>event.prefetch&&event.done).length).toBe(1);expect(stats.events[0].url).toBe("/dashboard/intent-one");}
 await offscreen(page).scrollIntoViewIfNeeded();
 if(stock)await expect.poll(()=>requests.some(url=>url.includes("intent-two"))).toBe(true);
 else await expect.poll(()=>stats.events.some(event=>event.prefetch&&event.url.endsWith("intent-two")&&event.done)).toBe(true);
});
test("leaving the viewport aborts pending speculation, re-entry warms again",async({page})=>{
 test.skip(Boolean(stock),"Tuto transport cancellation policy is bounded separately from stock batching.");
 const stats=await open(page,700);await expect.poll(()=>stats.events.length).toBe(1);
 await offscreen(page).scrollIntoViewIfNeeded();await expect.poll(()=>stats.cancelled).toBeGreaterThan(0);
 await visible(page).scrollIntoViewIfNeeded();await expect.poll(()=>stats.events.filter(event=>event.url.endsWith("intent-one")&&event.done).length).toBe(1);
});
test("refresh rewarms visible Links and preserves root state",async({page})=>{
 test.skip(Boolean(stock),"Asserts Tuto refresh-context replay rather than Next's private cache policy.");
 const stats=await open(page);await expect.poll(()=>stats.events.filter(event=>event.prefetch&&event.done).length).toBe(1);
 await page.locator('[data-counter="root"]').click();await page.locator('[data-refresh]').click();
 await expect.poll(()=>stats.events.filter(event=>event.prefetch&&event.done).length).toBe(2);
 await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
});
test("navigation preempts speculation, preserves root state and rewarms after history restore",async({page})=>{
 const stats=await open(page,700,200);await page.locator('[data-counter="root"]').click();
 if(!stock)await expect.poll(()=>stats.events.length).toBe(1);
 await page.locator('[data-viewport="disabled"]').click();await expect(page.locator('[data-intent-page]:visible')).toHaveText("two");
 if(!stock)await expect.poll(()=>stats.cancelled).toBeGreaterThan(0);
 await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
 await page.locator('[data-back]').click();await expect(page.locator('[data-path]')).toHaveText("/dashboard?");
 if(!stock)await expect.poll(()=>stats.events.some(event=>event.prefetch&&event.url.endsWith("intent-one")&&event.done)).toBe(true);
 await visible(page).click();await expect(page.locator('[data-intent-page]:visible')).toHaveText("one");
 await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
});
test("an explicit caller joining viewport work owns it after the Link unmounts",async({page})=>{
 test.skip(Boolean(stock),"Asserts Tuto's shared in-flight ticket ownership.");
 const stats=await open(page,500);await expect.poll(()=>stats.events.length).toBe(1);
 await page.evaluate(()=>{
  const globals=globalThis as Record<string,unknown>;
  void (globals.__TUTO_NEXT_PREFETCH__ as (href:string,options:unknown)=>Promise<void>)("/dashboard/intent-one",{_prefetchMode:"auto"});
 });
 await page.locator('[data-remove-viewport]').click();
 await expect.poll(()=>stats.events.filter(event=>event.prefetch&&event.done).length).toBe(1);expect(stats.cancelled).toBe(0);
});

test("touch intent interrupts viewport work and runs the chosen destination next",async({page})=>{
 test.skip(Boolean(stock),"Asserts Tuto's single-render transport ordering.");
 const stats=await open(page,700);await expect.poll(()=>stats.events.length).toBe(1);
 await page.locator('[data-enable-intent]').click();await page.locator('[data-viewport="priority"]').dispatchEvent("touchstart");
 await expect.poll(()=>stats.events.length).toBeGreaterThan(1);expect(stats.events[1].url).toBe("/dashboard/intent-two");
 await expect.poll(()=>stats.cancelled).toBeGreaterThan(0);
});
test("cookie-changing actions replay visible prefetch in the new request context",async({page})=>{
 test.skip(Boolean(stock),"Asserts Tuto's virtual request headers and action guard.");
 const stats=await open(page);await expect.poll(()=>stats.events.filter(event=>event.prefetch&&event.done).length).toBe(1);
 await page.locator('[data-retarget-viewport]').click();await expect.poll(()=>stats.events.some(event=>event.url.endsWith("prefetched")&&event.done)).toBe(true);
 await page.locator('[data-mutate]').click();await expect(page.locator('[data-prefetch-status]')).toHaveText("changed");
 await expect.poll(()=>stats.events.some(event=>event.prefetch&&event.cookie?.includes("identity=signed-in")&&event.done)).toBe(true);
 await visible(page).click();await expect(page.locator('[data-prefetched]')).toContainText('"identity":"signed-in"');
});
test("capacity evicts one ticket and notifies only its subscribers without replaying all visible Links",async({page})=>{
 test.skip(Boolean(stock),"Asserts Tuto's eight-entry cache and callback reentrancy guard.");
 const stats=await open(page);await expect.poll(()=>stats.events.filter(event=>event.prefetch&&event.done).length).toBe(1);
 const invalidated=await page.evaluate(async()=>{
  const globals=globalThis as Record<string,unknown>;
  const warm=globals.__TUTO_NEXT_PREFETCH__ as (href:string,options?:unknown)=>Promise<void>;
  const calls:number[]=[];
  for(let i=0;i<9;i++)await warm("/dashboard/prefetched?ticket="+i,{onInvalidate:()=>{
   calls.push(i);void warm("/dashboard/intent-two");
  }});
  return calls;
 });
 expect(invalidated).toEqual([0]);expect(stats.events.filter(event=>event.prefetch)).toHaveLength(10);
 await page.evaluate(()=>{const globals=globalThis as Record<string,unknown>;(globals.__TUTO_NEXT_NAVIGATE__ as (kind:string,path:string)=>void)("push","/dashboard/prefetched?ticket=8");});
 await expect(page.locator('[data-prefetched]')).toBeVisible();expect(stats.events.find(event=>!event.prefetch)?.hit).toBe("hit");
});
