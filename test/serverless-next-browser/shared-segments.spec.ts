import {expect,test,type Page} from "@playwright/test";
import {createServer,type Server} from "node:http";
import {once} from "node:events";
import {compileNextRequestWorkspace} from "../../lib/serverless-next/compiler";
import {POST,OPTIONS} from "../../app/api/serverless/nextjs-runtime/request/route";
import {executeNextRequestArtifact} from "../../lib/serverless-next/runtime";
import {sharedSegmentsWorkspace} from "../serverless-next/fixtures/shared-segments-workspace";
const stock=process.env.TUTO_NEXT_SEGMENTS_STOCK_URL;
const servers:Server[]=[];
test.afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
async function open(page:Page,delayFresh=0,failFresh=false,shortLifetime=false,invalidShell=false,validation:{ackDelay?:number;actionDelay?:number;missAck?:boolean;freshGate?:Promise<void>;failCombinedBody?:boolean}={}){
 const stats={cancelled:0,chunks:0,events:[] as Array<{url:string;prefetch:boolean;shell:boolean;ack:boolean;combined:boolean;bytes:number;mode?:string;kind?:string;hit?:string|null;headersSent?:boolean;done?:boolean;segments?:number}>};
 if(stock){await page.goto(stock+"/dashboard");await expect(page.locator('[data-counter="home"]')).toBeVisible();return stats;}
 await page.evaluate(()=>Object.defineProperty(globalThis,"IntersectionObserver",{value:undefined,configurable:true}));
 const artifact=await compileNextRequestWorkspace(sharedSegmentsWorkspace(),{workspaceKey:test.info().title,serverReferenceHashSalt:"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="});
 const server=createServer((request,outgoing)=>{void(async()=>{
  const controller=new AbortController();outgoing.on("close",()=>{if(!outgoing.writableFinished){stats.cancelled++;controller.abort();}});
  const chunks=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks).toString();const input=body?JSON.parse(body):{};
  const navigation=input.navigation;
  const event=navigation?{url:navigation.url,prefetch:navigation.prefetch===true,shell:navigation.prefetchShell===true,ack:navigation.prefetchShellAck===true,combined:navigation.prefetchShellStream===true,bytes:0,mode:navigation.prefetchMode,segments:(navigation.segmentRefs??[]).reduce((sum:number,ref:{keys:string[]})=>sum+ref.keys.length,0),kind:undefined as string|undefined,hit:null as string|null,headersSent:false,done:false}:undefined;
  if(event)stats.events.push(event);
  const fresh=event&&!event.prefetch&&(!event.shell||event.combined);
  if(fresh&&!event.combined&&validation.freshGate)await validation.freshGate;
  if(fresh&&!event.combined&&delayFresh)await new Promise(resolve=>setTimeout(resolve,delayFresh));controller.signal.throwIfAborted();
  if(event?.ack&&validation.missAck){const {nextPrefetchTickets}=await import("../../lib/serverless-next/prefetch");nextPrefetchTickets.invalidate(artifact);}
  let response=fresh&&failFresh?new Response("controlled navigation failure",{status:500,headers:{"access-control-allow-origin":"*"}}):request.method==="OPTIONS"?OPTIONS():await POST(new Request("http://tuto.local/request",{method:"POST",body:navigation?JSON.stringify(input):body,headers:{"content-type":"text/plain"},signal:controller.signal}));
  if(event?.prefetch&&shortLifetime&&response.status===200){const result=await response.json();response=Response.json({...result,ttlMs:1000,segmentGrant:{...result.segmentGrant,ttlMs:1000}},{headers:response.headers});}
  if(event?.prefetch&&invalidShell&&response.status===200){const result=await response.json();response=Response.json({...result,shellFlight:Buffer.from("invalid Flight").toString("base64")},{headers:response.headers});}
  if(event){event.hit=response.headers.get("x-tuto-next-prefetch");if(event.prefetch&&response.status===200)event.kind=(await response.clone().json()).kind;}
  if(event?.ack&&validation.ackDelay)await new Promise(resolve=>setTimeout(resolve,validation.ackDelay));
  if(input.action&&validation.actionDelay)await new Promise(resolve=>setTimeout(resolve,validation.actionDelay));
  controller.signal.throwIfAborted();
  outgoing.writeHead(response.status,Object.fromEntries(response.headers));
  outgoing.flushHeaders();if(event)event.headersSent=true;
  if(event?.combined){if(validation.freshGate)await validation.freshGate;if(delayFresh)await new Promise(resolve=>setTimeout(resolve,delayFresh));controller.signal.throwIfAborted();}
  if(event?.combined&&validation.failCombinedBody){outgoing.destroy(new Error("controlled combined stream failure"));return;}
  if(response.body){const reader=response.body.getReader();for(;;){const chunk=await reader.read();if(chunk.done)break;if(fresh)stats.chunks++;if(event)event.bytes+=chunk.value.byteLength;if(!outgoing.write(chunk.value))await once(outgoing,"drain");}}
  outgoing.end();if(event)event.done=true;
 })().catch(error=>{if(!outgoing.destroyed)outgoing.destroy(error as Error);});});
 servers.push(server);server.listen(0,"127.0.0.1");await once(server,"listening");const port=(server.address() as {port:number}).port;
 await page.setContent(await(await executeNextRequestArtifact(artifact,{url:"/dashboard",hydrate:true,actionEndpoint:`http://127.0.0.1:${port}/request`})).text());
 await page.waitForFunction(()=>Boolean((globalThis as Record<string,unknown>).__TUTO_NEXT_ROUTER_STATE__));return stats;
}
async function warm(page:Page,stats:Awaited<ReturnType<typeof open>>,href:string){
 await page.locator('[data-shell-target]').fill(href);await page.mouse.move(0,0);
 const before=stats.events.filter(event=>event.prefetch&&event.done).length;
 await page.locator('[data-shell-link="auto"]').hover();
 if(!stock){await expect.poll(()=>stats.events.filter(event=>event.prefetch&&event.done).length).toBe(before+1);
 await page.evaluate(async href=>{await (globalThis as typeof globalThis&{__TUTO_NEXT_PREFETCH__:(href:string,options:object)=>Promise<void>}).__TUTO_NEXT_PREFETCH__(href,{_prefetchMode:"auto"});},href);}
 else await page.waitForTimeout(300);
}
async function go(page:Page,name:string){await page.locator('[data-shell-link="auto"]').click();await expect(page.locator('[data-shared-page]:visible')).toContainText(name+":");}
async function delayFirstDecode(page:Page){await page.evaluate(()=>{
 const scope=globalThis as typeof globalThis&{__TUTO_NEXT_CLIENT_KERNEL__:{router:{collectSegments:(...args:unknown[])=>Promise<unknown>}};__decodeStarted?:boolean};
 const router=scope.__TUTO_NEXT_CLIENT_KERNEL__.router,collect=router.collectSegments;let first=true;
 router.collectSegments=async(...args)=>{const models=await collect(...args);if(first){first=false;scope.__decodeStarted=true;await new Promise(resolve=>setTimeout(resolve,1000));}return models;};
});}
test("warming sibling shells reuses templates before first display without mounting clients or executing dynamic leaves",async({page})=>{
 const stats=await open(page,300);const root=await page.locator('[data-shared-root]').textContent();
 await page.locator('[data-counter="root"]').click();await warm(page,stats,"/dashboard/shared/one");
 await expect(page.locator('[data-shared-layout]')).toHaveCount(0);await expect(page.locator('[data-shared-root]')).toHaveText(root!);
 expect(await page.evaluate(()=>(globalThis as typeof globalThis&{__sharedLayoutMounts?:number}).__sharedLayoutMounts??0)).toBe(0);
 await warm(page,stats,"/dashboard/shared/two");
 if(!stock)expect(stats.events.filter(event=>event.prefetch).at(-1)?.segments).toBeGreaterThan(0);
 await page.locator('[data-shell-link="auto"]').click();await expect(page.locator('[data-shared-loading]:visible')).toHaveText(stock?/^loading:\d+$/:"loading:1");await expect(page.locator('[data-shared-page]:visible')).toHaveText(stock?/^two:\d+:anonymous$/:"two:1:anonymous");
 await expect(page.locator('[data-shared-layout]')).toHaveText(stock?/^\d+:anonymous$/:"1:anonymous");await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
 await expect(page.locator('[data-counter="team-two"]')).toBeVisible();await expect(page.locator('[data-counter="detail-two"]')).toBeVisible();
 expect(await page.evaluate(()=>(globalThis as typeof globalThis&{__sharedLayoutMounts?:number}).__sharedLayoutMounts)).toBe(1);
 if(!stock){const combined=stats.events.find(event=>event.shell);expect(combined).toMatchObject({ack:true,combined:true,hit:"shell-stream-hit"});expect(combined?.bytes).toBeGreaterThan(0);expect(stats.events.filter(event=>!event.prefetch)).toHaveLength(1);}
});
test("refresh invalidates templates decoded before their first display",async({page})=>{
 test.skip(Boolean(stock),"Asserts Tuto receipt invalidation before first provisional display.");
 const stats=await open(page);await warm(page,stats,"/dashboard/shared/one");const root=await page.locator('[data-shared-root]').textContent();
 await page.locator('[data-refresh]').click();await expect(page.locator('[data-shared-root]')).not.toHaveText(root!);
 await warm(page,stats,"/dashboard/shared/two");expect(stats.events.filter(event=>event.prefetch).at(-1)?.segments).toBe(0);
 await go(page,"two");await expect(page.locator('[data-shared-layout]')).toHaveText("2:anonymous");
});
test("failed speculative decoding falls back to validated shell display and fresh descendants",async({page})=>{
 test.skip(Boolean(stock),"Uses controlled invalid prefetch Flight, retaining the valid server ticket.");
 const stats=await open(page,300,false,false,true);await warm(page,stats,"/dashboard/shared/one");await warm(page,stats,"/dashboard/shared/two");
 expect(stats.events.filter(event=>event.prefetch).at(-1)?.segments).toBe(0);await go(page,"two");
 await expect(page.locator('[data-shared-layout]')).toHaveText("2:anonymous");await expect(page.locator('[data-counter="detail-two"]')).toBeVisible();
 expect(stats.events.find(event=>event.shell)).toMatchObject({ack:false,hit:"shell-hit"});expect(stats.events.find(event=>event.shell)?.bytes).toBeGreaterThan(0);
});
for(const expired of [false,true])test(expired?"a delayed combined response cannot provisionally display an expired retained shell":"a combined validation miss streams fresh content without displaying its retained shell",async({page})=>{
 test.skip(Boolean(stock),"Controls Tuto acknowledgment validation and receipt expiry.");
 let release!:()=>void;const freshGate=new Promise<void>(resolve=>{release=resolve;});
 const stats=await open(page,0,false,expired,false,{freshGate,missAck:!expired,ackDelay:expired?1200:0});await page.locator('[data-counter="root"]').click();
 try {
 await warm(page,stats,"/dashboard/shared/one");const root=await page.locator('[data-shared-root]').textContent();await page.locator('[data-shell-link="auto"]').click();
 await expect.poll(()=>stats.events.some(event=>event.combined&&event.headersSent)).toBe(true);
 await expect(page.locator('[data-shared-layout]')).toHaveCount(0);await expect(page.locator('[data-shared-root]')).toHaveText(root!);
 release();
 await expect(page.locator('[data-shared-page]:visible')).toHaveText("one:1:anonymous");await expect(page.locator('[data-shared-layout]')).toHaveText(expired?"1:anonymous":"2:anonymous");
 expect(stats.events.find(event=>event.ack)).toMatchObject({hit:expired?"shell-stream-hit":"shell-stream-miss"});expect(stats.events.filter(event=>!event.prefetch)).toHaveLength(1);await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
 } finally {release();}
});
test("action invalidation while combined headers are pending prevents stale shell display",async({page})=>{
 test.skip(Boolean(stock),"Controls a validated acknowledgment and delayed action response.");
 let release!:()=>void;const freshGate=new Promise<void>(resolve=>{release=resolve;});
 const stats=await open(page,0,false,false,false,{freshGate,ackDelay:600,actionDelay:1000});await page.locator('[data-counter="root"]').click();const root=await page.locator('[data-shared-root]').textContent();
 try {
 await warm(page,stats,"/dashboard/shared/one");await page.locator('[data-shell-link="auto"]').click();await expect.poll(()=>stats.events.some(event=>event.ack&&event.hit==="shell-stream-hit")).toBe(true);
 await page.locator('[data-shell-action]').click();await expect.poll(()=>stats.cancelled).toBeGreaterThan(0);
 await expect(page.locator('[data-shared-layout]')).toHaveCount(0);await expect(page.locator('[data-counter="home"]')).toBeVisible();
 await expect(page.locator('[data-shell-action-status]')).toHaveText("changed");release();await expect(page.locator('[data-shared-root]')).not.toHaveText(root!);await expect(page.locator('[data-path]')).toHaveText("/dashboard?");
 await warm(page,stats,"/dashboard/shared/two");await go(page,"two");await expect(page.locator('[data-shared-page]:visible')).toHaveText("two:1:signed-in");await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
 } finally {release();}
});
test("superseded combined headers cannot display a retained shell or add canceled history",async({page})=>{
 test.skip(Boolean(stock),"Controls Tuto acknowledgment response timing.");
 const stats=await open(page,0,false,false,false,{ackDelay:1000});await page.locator('[data-counter="root"]').click();
 await warm(page,stats,"/dashboard/shared/one");await page.locator('[data-shell-link="auto"]').click();await expect.poll(()=>stats.events.some(event=>event.ack&&event.hit==="shell-stream-hit")).toBe(true);
 await page.locator('[data-go="settings"]').click();await expect(page.locator('[data-counter="settings"]')).toBeVisible();await page.waitForTimeout(1100);await expect(page.locator('[data-shared-layout]')).toHaveCount(0);
 await page.locator('[data-back]').click();await expect(page.locator('[data-counter="home"]')).toBeVisible();await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");expect(stats.cancelled).toBeGreaterThan(0);
});
test("retained loading stays interactive before combined Flight and canceling it omits canceled history",async({page})=>{
 test.skip(Boolean(stock),"Controls the combined Flight body after headers.");
 let release!:()=>void;const freshGate=new Promise<void>(resolve=>{release=resolve;});const stats=await open(page,0,false,false,false,{freshGate});
 try {
 await page.locator('[data-counter="root"]').click();await warm(page,stats,"/dashboard/shared/one");await warm(page,stats,"/dashboard/shared/two");await page.locator('[data-shell-link="auto"]').click();await expect(page.locator('[data-shared-loading]:visible')).toHaveText("loading:1");
 expect(stats.events.find(event=>event.combined)).toMatchObject({headersSent:true,hit:"shell-stream-hit",bytes:0});await expect(page.locator('[data-shared-page]:visible')).toHaveCount(0);
 await page.locator('[data-counter="root"]').click();await expect(page.locator('[data-counter="root"]')).toHaveText("root:2");
 await page.locator('[data-go="settings"]').click();release();await expect(page.locator('[data-counter="settings"]')).toBeVisible();await page.locator('[data-back]').click();await expect(page.locator('[data-path]')).toHaveText("/dashboard?");await expect(page.locator('[data-counter="root"]')).toHaveText("root:2");expect(stats.cancelled).toBeGreaterThan(0);
 } finally {release();}
});
test("combined Flight failure after retained-shell display restores the committed view and releases navigation",async({page})=>{
 test.skip(Boolean(stock),"Uses a controlled combined-body failure.");
 const stats=await open(page,500,false,false,false,{failCombinedBody:true});await page.locator('[data-counter="root"]').click();await warm(page,stats,"/dashboard/shared/one");await page.locator('[data-shell-link="auto"]').click();await expect(page.locator('[data-shared-loading]:visible')).toBeVisible();
 await expect(page.locator('[data-counter="home"]')).toBeVisible();await expect(page.locator('[data-shared-loading]:visible')).toHaveCount(0);await expect(page.locator('[data-path]')).toHaveText("/dashboard?");await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
 await page.locator('[data-go="settings"]').click();await expect(page.locator('[data-counter="settings"]')).toBeVisible();expect(stats.events.filter(event=>event.combined)).toHaveLength(1);
});
test("navigation cancels pending decoding and its late completion cannot restore stale templates",async({page})=>{
 test.skip(Boolean(stock),"Controls Tuto's speculative decode completion.");
 const stats=await open(page);await delayFirstDecode(page);
 await page.locator('[data-shell-target]').fill("/dashboard/shared/one");await page.locator('[data-shell-link="auto"]').hover();await page.waitForFunction(()=>(globalThis as typeof globalThis&{__decodeStarted?:boolean}).__decodeStarted);
 await go(page,"one");expect(stats.events.filter(event=>!event.prefetch&&!event.shell).at(-1)?.segments).toBe(0);
 await page.waitForTimeout(1100);await warm(page,stats,"/dashboard/shared/two");expect(stats.events.filter(event=>event.prefetch).at(-1)?.segments).toBe(0);
 await go(page,"two");await expect(page.locator('[data-shared-layout]')).toHaveText("3:anonymous");
});
test("a Link canceled during decoding can warm the same destination again",async({page})=>{
 test.skip(Boolean(stock),"Controls Tuto's speculative decode completion and Link interest.");
 const stats=await open(page);await delayFirstDecode(page);
 await page.locator('[data-shell-target]').fill("/dashboard/shared/one");await page.locator('[data-shell-link="auto"]').hover();await page.waitForFunction(()=>(globalThis as typeof globalThis&{__decodeStarted?:boolean}).__decodeStarted);
 await page.locator('[data-shell-target]').fill("/dashboard/shared/two");await page.waitForTimeout(100);
 await warm(page,stats,"/dashboard/shared/one");expect(stats.events.filter(event=>event.prefetch&&event.url==="/dashboard/shared/one")).toHaveLength(2);
 await page.waitForTimeout(1100);await go(page,"one");await expect(page.locator('[data-shared-layout]')).toHaveText("2:anonymous");
});
test("action cookies invalidate templates decoded before display",async({page})=>{
 const stats=await open(page);await warm(page,stats,"/dashboard/shared/one");await page.locator('[data-shell-action]').click();await expect(page.locator('[data-shell-action-status]')).toHaveText("changed");
 await warm(page,stats,"/dashboard/shared/two");if(!stock)expect(stats.events.filter(event=>event.prefetch).at(-1)?.segments).toBe(0);
 await go(page,"two");await expect(page.locator('[data-shared-layout]')).toContainText("signed-in");await expect(page.locator('[data-shared-page]:visible')).toHaveText(stock?/^two:\d+:signed-in$/:"two:1:signed-in");
});
test("expired pre-display templates cannot be reauthorized by a new receipt for the same keys",async({page})=>{
 test.skip(Boolean(stock),"Uses a controlled short Tuto receipt lifetime.");
 const stats=await open(page,0,false,true);await warm(page,stats,"/dashboard/shared/one");await page.waitForTimeout(1100);
 await warm(page,stats,"/dashboard/shared/two");expect(stats.events.filter(event=>event.prefetch).at(-1)?.segments).toBe(0);await go(page,"two");await expect(page.locator('[data-shared-layout]')).toHaveText("2:anonymous");
});
test("sibling shells reuse shared layout/loading output while fresh primary and nested slot descendants retain state",async({page})=>{
 const stats=await open(page,300);await page.locator('[data-counter="root"]').click();await page.locator('[data-counter="team-layout"]').click();
 await warm(page,stats,"/dashboard/shared/one");await page.locator('[data-shell-link="auto"]').click();
 await expect(page.locator('[data-shared-loading]:visible')).toBeVisible();const loading=await page.locator('[data-shared-loading]:visible').textContent();
 await expect(page.locator('[data-shared-page]:visible')).toContainText("one:");await page.locator('[data-counter="shared-layout"]').click();
 const root=await page.locator('[data-shared-root]').textContent();const shared=await page.locator('[data-shared-layout]').textContent();
 await page.locator('[data-counter="team-one"]').click();await page.locator('[data-counter="detail-one"]').click();
 await warm(page,stats,"/dashboard/shared/two");await page.locator('[data-shell-link="auto"]').click();
 await expect(page.locator('[data-shared-loading]:visible')).toHaveText(loading!);await expect(page.locator('[data-shared-page]:visible')).toContainText("two:");
 await expect(page.locator('[data-shared-root]')).toHaveText(root!);await expect(page.locator('[data-shared-layout]')).toHaveText(shared!);
 await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");await expect(page.locator('[data-counter="shared-layout"]')).toHaveText("shared-layout:1");
 await expect(page.locator('[data-counter="team-two"]')).toBeVisible();await expect(page.locator('[data-counter="detail-two"]')).toBeVisible();
 if(!stock){expect(stats.events.filter(event=>event.prefetch).at(-1)?.segments).toBeGreaterThan(0);expect(stats.events.filter(event=>!event.prefetch&&(!event.shell||event.combined)).at(-1)?.segments).toBeGreaterThan(0);}
 await page.locator('[data-back]').click();await expect(page.locator('[data-shared-page]:visible')).toContainText("one:");
 await expect(page.locator('[data-counter="team-one"]')).toHaveText(stock?"team-one:0":"team-one:1");
 await expect(page.locator('[data-counter="detail-one"]')).toHaveText(stock?"detail-one:0":"detail-one:1");
});
test("refresh discards shared server output without remounting root/layout state",async({page})=>{
 const stats=await open(page);await warm(page,stats,"/dashboard/shared/one");await go(page,"one");
 await page.locator('[data-counter="root"]').click();await page.locator('[data-counter="shared-layout"]').click();const before=await page.locator('[data-shared-layout]').textContent();
 await page.locator('[data-refresh]').click();await expect(page.locator('[data-shared-layout]')).not.toHaveText(before!);
 await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");await expect(page.locator('[data-counter="shared-layout"]')).toHaveText("shared-layout:1");
 if(!stock)expect(stats.events.at(-1)?.segments).toBe(0);
});
test("action-cookie invalidation drops old receipts and refreshes layout and page identity",async({page})=>{
 const stats=await open(page);await warm(page,stats,"/dashboard/shared/one");await go(page,"one");await page.locator('[data-counter="root"]').click();
 await page.locator('[data-shell-action]').click();await expect(page.locator('[data-shell-action-status]')).toHaveText("changed");
 await expect(page.locator('[data-shared-layout]')).toContainText("signed-in");await expect(page.locator('[data-shared-page]:visible')).toContainText("signed-in");
 await warm(page,stats,"/dashboard/shared/two");await go(page,"two");await expect(page.locator('[data-shared-layout]')).toContainText("signed-in");
 await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
});
test("superseded reused-shell navigation preserves committed layout state and omits canceled history",async({page})=>{
 test.skip(Boolean(stock),"Uses controlled Tuto transport delays and template snapshots.");
 const stats=await open(page,700);await warm(page,stats,"/dashboard/shared/one");await go(page,"one");await page.locator('[data-counter="shared-layout"]').click();
 await warm(page,stats,"/dashboard/shared/two");await page.locator('[data-shell-link="auto"]').click();await expect(page.locator('[data-shared-loading]:visible')).toBeVisible();
 await page.locator('[data-go="settings"]').click();await expect(page.locator('[data-counter="settings"]')).toBeVisible();
 await page.locator('[data-back]').click();await expect(page.locator('[data-shared-page]:visible')).toContainText("one:");await expect(page.locator('[data-counter="shared-layout"]')).toHaveText("shared-layout:1");
 await expect.poll(()=>stats.cancelled).toBeGreaterThan(0);
});

test("expired receipts drop old templates before warming a new sibling",async({page})=>{
 test.skip(Boolean(stock),"Uses a controlled short Tuto receipt lifetime.");
 const stats=await open(page,0,false,true);await warm(page,stats,"/dashboard/shared/one");await go(page,"one");
 await page.locator('[data-counter="shared-layout"]').click();const before=await page.locator('[data-shared-layout]').textContent();
 expect(stats.events.filter(event=>!event.prefetch&&(!event.shell||event.combined)).at(-1)?.segments).toBeGreaterThan(0);
 await page.waitForTimeout(1100);await warm(page,stats,"/dashboard/shared/two");expect(stats.events.filter(event=>event.prefetch).at(-1)?.segments).toBe(0);
 await go(page,"two");await expect(page.locator('[data-shared-layout]')).not.toHaveText(before!);
 await expect(page.locator('[data-counter="shared-layout"]')).toHaveText("shared-layout:1");
});

test("parameterized history selects the matching held template and retains layout client state",async({page})=>{
 test.skip(Boolean(stock),"Tuto conservatively keys complete branch params; stock parent layouts receive only owner params.");
 const stats=await open(page,300);await warm(page,stats,"/dashboard/shared/alpha");await go(page,"alpha");
 await page.locator('[data-counter="shared-layout"]').click();await expect(page.locator('[data-shared-param]')).toHaveText("alpha");
 const first=await page.locator('[data-shared-root]').textContent();
 await warm(page,stats,"/dashboard/shared/beta");await go(page,"beta");await expect(page.locator('[data-shared-param]')).toHaveText("beta");
 await page.locator('[data-back]').click();await expect(page.locator('[data-shared-page]:visible')).toContainText("alpha:");
 await expect(page.locator('[data-shared-param]')).toHaveText("alpha");await expect(page.locator('[data-shared-root]')).toHaveText(first!);
 await expect(page.locator('[data-counter="shared-layout"]')).toHaveText("shared-layout:1");
});
