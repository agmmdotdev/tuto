import {expect,test,type Page} from "@playwright/test";
import {createServer,type Server} from "node:http";
import {once} from "node:events";
import {compileNextRequestWorkspace} from "../../lib/serverless-next/compiler";
import {POST,OPTIONS} from "../../app/api/serverless/nextjs-runtime/request/route";
import {executeNextRequestArtifact} from "../../lib/serverless-next/runtime";
import {linkPrefetchWorkspace} from "../serverless-next/fixtures/link-prefetch-workspace";

const stock = process.env.TUTO_NEXT_LINK_STOCK_URL;
const servers:Server[]=[];
test.afterEach(async()=>{
 for(const server of servers.splice(0)){
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
 }
});
async function open(page:Page,delayPrefetch=0,delayNavigation=0){
 const stats={cancelled:0,events:[] as Array<{prefetch:boolean;url:string;hit?:string|null;done?:boolean}>};
 if(stock){await page.goto(stock+"/dashboard");await expect(page.locator('[data-counter="home"]')).toBeVisible();return stats;}
 await page.evaluate(()=>Object.defineProperty(globalThis,"IntersectionObserver",{value:undefined,configurable:true}));
 const artifact=await compileNextRequestWorkspace(linkPrefetchWorkspace(),{
  workspaceKey:test.info().title,serverReferenceHashSalt:"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
 });
 const server=createServer((request,outgoing)=>{
  void(async()=>{
   const controller=new AbortController();
   outgoing.on("close",()=>{if(!outgoing.writableFinished){stats.cancelled++;controller.abort();}});
   const chunks=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
   const body=Buffer.concat(chunks).toString();
   const input=body?JSON.parse(body):{};
   const event=input.navigation?{prefetch:input.navigation.prefetch===true,url:input.navigation.url,hit:null as string|null,done:false}:undefined;
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
const link=(page:Page,name:string)=>page.locator(`[data-intent="${name}"]`);

test("Link replace and scroll options survive the raw-anchor fallback",async({page})=>{
 await open(page);
 await page.locator('[data-counter="root"]').click();
 await link(page,"false").click();await expect(page.locator('[data-intent-page]:visible')).toHaveText("two");
 await page.evaluate(()=>window.scrollTo(0,400));
 await link(page,"replace").dispatchEvent("click",{button:0});
 await expect(page.locator('[data-intent-page]:visible')).toHaveText("one");
 await expect.poll(()=>page.evaluate(()=>window.scrollY)).toBe(400);
 await page.locator('[data-back]').click();await expect(page.locator('[data-path]')).toHaveText("/dashboard?");
 await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
});

test("hover and touch deduplicate warming and preserve handlers, refs and layout state",async({page})=>{
 const stats=await open(page);
 await page.locator('[data-counter="root"]').click();
 await link(page,"default").hover();
 await expect(page.locator('[data-intent-events]')).toHaveText("1");
 if(!stock)await expect.poll(()=>stats.events.filter(event=>event.prefetch&&event.done).length).toBe(1);
 await link(page,"default").dispatchEvent("touchstart");
 await expect(page.locator('[data-intent-events]')).toHaveText("2");
 for(const name of ["true","auto","null"])await link(page,name).hover();
 if(!stock)expect(stats.events.filter(event=>event.prefetch)).toHaveLength(1);
 await expect(page.locator('[data-path]')).toHaveText("/dashboard?");
 await expect(page.locator('[data-intent-page]')).not.toBeVisible();
 await page.locator('[data-inspect-ref]').click();
 await expect(page.locator('[data-intent-events]')).toHaveText("100");
 await link(page,"default").click();
 await expect(page.locator('[data-intent-page]')).toHaveText("one");
 if(!stock)expect(stats.events.filter(event=>!event.prefetch).at(-1)?.hit).toBe("hit");
 await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
 await page.locator('[data-back]').click();
 await expect(page.locator('[data-path]')).toHaveText("/dashboard?");
});

test("prefetch false disables hover and touch while preserving normal and prevented clicks",async({page})=>{
 const stats=await open(page);
 const requests:string[]=[];page.on("request",request=>{if(request.url().includes("intent-two"))requests.push(request.url());});
 await link(page,"false").hover();await link(page,"false").dispatchEvent("touchstart");
 await expect(page.locator('[data-intent-events]')).toHaveText("2");
 await link(page,"blocked").click();
 await expect(page.locator('[data-path]')).toHaveText("/dashboard?");
 expect(requests).toHaveLength(0);if(!stock)expect(stats.events).toHaveLength(0);
 await link(page,"false").click();await expect(page.locator('[data-intent-page]')).toHaveText("two");
 if(!stock){expect(stats.events).toHaveLength(1);expect(stats.events[0].prefetch).toBe(false);}
});

test("excludes external, download, new-window and hash-only intents",async({page})=>{
 test.skip(Boolean(stock),"Tuto intentionally excludes these intents; stock viewport warming has different eligibility.");
 const stats=await open(page);
 for(const name of ["external","target","download","hash"]){await link(page,name).hover();await link(page,name).dispatchEvent("touchstart");}
 // Check native download click eligibility without initiating a browser download.
 const prevented=await link(page,"download").evaluate(anchor=>{
  let intercepted=false;
  const stop=(event:MouseEvent)=>{intercepted=event.defaultPrevented;event.preventDefault();};
  window.addEventListener("click",stop,{once:true});
  anchor.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,button:0}));
  return intercepted;
 });
 expect(prevented).toBe(false);expect(stats.events).toHaveLength(0);
});

test("reads current href and prefetch props, and rewarms after refresh",async({page})=>{
 test.skip(Boolean(stock),"Exercises explicit Tuto ticket expiry and refresh invalidation.");
 const stats=await open(page);
 await page.locator('[data-toggle-intent]').click();
 await link(page,"dynamic").hover();expect(stats.events).toHaveLength(0);
 await page.locator('[data-retarget-intent]').click();await page.locator('[data-toggle-intent]').click();
 await link(page,"dynamic").hover();await expect.poll(()=>stats.events.filter(event=>event.prefetch&&event.done).length).toBe(1);
 expect(stats.events[0].url).toBe("/dashboard/intent-two");
 await page.locator('[data-refresh]').click();await expect.poll(()=>stats.events.some(event=>!event.prefetch&&event.done)).toBe(true);
 await link(page,"dynamic").hover();await expect.poll(()=>stats.events.filter(event=>event.prefetch&&event.done).length).toBe(2);
});

test("navigation cancels slow speculation and blocks new intents until commit",async({page})=>{
 test.skip(Boolean(stock),"Exercises controlled Tuto transport delays and cancellation.");
 const stats=await open(page,800,250);
 await link(page,"default").hover();await expect.poll(()=>stats.events.length).toBe(1);
 await link(page,"false").click();await expect.poll(()=>stats.events.some(event=>!event.prefetch)).toBe(true);
 await link(page,"true").dispatchEvent("touchstart");
 await expect(page.locator('[data-intent-page]')).toHaveText("two");
 await expect.poll(()=>stats.cancelled).toBeGreaterThan(0);
 expect(stats.events.filter(event=>event.prefetch)).toHaveLength(1);
 await page.locator('[data-back]').click();await expect(page.locator('[data-path]')).toHaveText("/dashboard?");
 await link(page,"default").hover();await expect.poll(()=>stats.events.filter(event=>event.prefetch&&event.done).length).toBe(1);
 await link(page,"default").click();await expect(page.locator('[data-intent-page]:visible')).toHaveText("one");
 expect(stats.events.filter(event=>!event.prefetch).at(-1)?.hit).toBe("hit");
});
