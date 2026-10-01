import {expect,test,type Page} from "@playwright/test";
import {createServer,type Server} from "node:http";
import {once} from "node:events";
import {compileNextRequestWorkspace} from "../../lib/serverless-next/compiler";
import {POST,OPTIONS} from "../../app/api/serverless/nextjs-runtime/request/route";
import {executeNextRequestArtifact} from "../../lib/serverless-next/runtime";
import {shellPrefetchWorkspace} from "../serverless-next/fixtures/shell-prefetch-workspace";
const stock=process.env.TUTO_NEXT_SHELL_STOCK_URL;
const servers:Server[]=[];
test.afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
async function open(page:Page,delayFresh=0,failFresh=false){
 const stats={cancelled:0,chunks:0,events:[] as Array<{url:string;prefetch:boolean;shell:boolean;mode?:string;kind?:string;hit?:string|null;done?:boolean}>};
 if(stock){await page.goto(stock+"/dashboard");await expect(page.locator('[data-counter="home"]')).toBeVisible();return stats;}
 await page.evaluate(()=>Object.defineProperty(globalThis,"IntersectionObserver",{value:undefined,configurable:true}));
 const artifact=await compileNextRequestWorkspace(shellPrefetchWorkspace(),{workspaceKey:test.info().title,serverReferenceHashSalt:"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="});
 const server=createServer((request,outgoing)=>{void(async()=>{
  const controller=new AbortController();outgoing.on("close",()=>{if(!outgoing.writableFinished){stats.cancelled++;controller.abort();}});
  const chunks=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks).toString();const input=body?JSON.parse(body):{};
  const navigation=input.navigation;
  const event=navigation?{url:navigation.url,prefetch:navigation.prefetch===true,shell:navigation.prefetchShell===true,mode:navigation.prefetchMode,kind:undefined as string|undefined,hit:null as string|null,done:false}:undefined;
  if(event)stats.events.push(event);
  const fresh=event&&!event.prefetch&&!event.shell;
  // Probe fresh page execution without relying on SecureExec's frozen clock.
  if(fresh&&!navigation.prefetchTicket)navigation.headers={...navigation.headers,"x-fresh":"navigation"};
  if(fresh&&delayFresh)await new Promise(resolve=>setTimeout(resolve,delayFresh));controller.signal.throwIfAborted();
  const response=fresh&&failFresh?new Response("controlled navigation failure",{status:500,headers:{"access-control-allow-origin":"*"}}):request.method==="OPTIONS"?OPTIONS():await POST(new Request("http://tuto.local/request",{method:"POST",body:navigation?JSON.stringify(input):body,headers:{"content-type":"text/plain"},signal:controller.signal}));
  if(event){event.hit=response.headers.get("x-tuto-next-prefetch");if(event.prefetch&&response.status===200)event.kind=(await response.clone().json()).kind;}
  outgoing.writeHead(response.status,Object.fromEntries(response.headers));
  if(response.body){const reader=response.body.getReader();for(;;){const chunk=await reader.read();if(chunk.done)break;if(fresh)stats.chunks++;if(!outgoing.write(chunk.value))await once(outgoing,"drain");}}
  outgoing.end();if(event)event.done=true;
 })().catch(error=>{if(!outgoing.destroyed)outgoing.destroy(error as Error);});});
 servers.push(server);server.listen(0,"127.0.0.1");await once(server,"listening");const port=(server.address() as {port:number}).port;
 await page.setContent(await(await executeNextRequestArtifact(artifact,{url:"/dashboard",hydrate:true,actionEndpoint:`http://127.0.0.1:${port}/request`})).text());
 await page.waitForFunction(()=>Boolean((globalThis as Record<string,unknown>).__TUTO_NEXT_ROUTER_STATE__));return stats;
}
async function warm(page:Page,stats:Awaited<ReturnType<typeof open>>,mode="auto"){
 const before=stats.events.filter(event=>event.prefetch&&event.done).length;
 if(mode==="full")await page.locator('[data-shell-enable-full]').click();
 await page.mouse.move(0,0);
 await page.locator(`[data-shell-link="${mode}"]`).hover();
 if(!stock)await expect.poll(()=>stats.events.filter(event=>event.prefetch&&event.done).length).toBe(before+1);
 else await page.waitForTimeout(300); // Allow production viewport/hover prefetch to settle; no stock cache-policy assertion.
}
test("default intent displays a validated loading shell then streams fresh descendants while layouts and slots retain state",async({page})=>{
 const stats=await open(page,500);
 await page.locator('[data-counter="root"]').click();await page.locator('[data-counter="analytics-home"]').click();
 await warm(page,stats);if(!stock)expect(stats.events[0].kind).toBe("shell");
 await expect(page.locator('[data-shell-loading]')).not.toBeVisible();await expect(page.locator('[data-path]')).toHaveText("/dashboard?");
 const clickTime=Date.now();await page.locator('[data-shell-link="auto"]').click();
 await expect(page.locator('[data-shell-loading]:visible')).toBeVisible();
 await page.locator('[data-counter="root"]').click();await expect(page.locator('[data-counter="root"]')).toHaveText("root:2");
 await expect(page.locator('[data-shell-fresh]')).toHaveText(stock?"fresh:anonymous":"navigation:anonymous");
 if(stock||process.env.TUTO_NEXT_EXECUTION_MODE!=="secure-exec")expect(Number(await page.locator('[data-shell-time]').textContent())).toBeGreaterThanOrEqual(clickTime);
 await expect(page.locator('[data-shell-details-loading]')).toBeVisible();await expect(page.locator('[data-shell-details]')).toHaveText("fresh details");
 await expect(page.locator('[data-counter="analytics-home"]')).toHaveText("analytics-home:1");
 await page.locator('[data-counter="shell"]').click();await page.locator('[data-back]').click();await expect(page.locator('[data-counter="home"]')).toBeVisible();
 // Stock production remounts this dynamic leaf on history restoration; Tuto
 // deliberately retains its bounded Activity entries.
 await page.locator('[data-forward]').click();await expect(page.locator('[data-counter="shell"]')).toHaveText(stock?"shell:0":"shell:1");
 await expect(page.locator('[data-path]')).toHaveText("/dashboard/shell?");
 if(!stock){
  await page.locator('[data-back]').click();await expect(page.locator('[data-path]')).toHaveText("/dashboard?");
  await warm(page,stats);await page.locator('[data-shell-link="auto"]').click();
  await expect(page.locator('[data-counter="shell"]')).toHaveText("shell:1");
 }
 if(!stock){expect(stats.events.some(event=>event.shell&&["shell-hit","shell-ack"].includes(event.hit??""))).toBe(true);expect(stats.chunks).toBeGreaterThan(1);}
});
test("explicit true upgrades an automatic shell to full Flight without serving it as a shell",async({page})=>{
 test.skip(Boolean(stock),"Tests Tuto's distinct bounded ticket strategies and upgrade selection.");
 const stats=await open(page);await warm(page,stats);await warm(page,stats,"full");
 expect(stats.events.filter(event=>event.prefetch).map(event=>event.kind)).toEqual(["shell","full"]);
 await page.locator('[data-shell-link="auto"]').click();await expect(page.locator('[data-shell-details]')).toBeVisible();
 await expect(page.locator('[data-shell-fresh]')).toHaveText("fresh:anonymous");
 expect(stats.events.filter(event=>!event.prefetch)).toHaveLength(1);expect(stats.events.at(-1)?.hit).toBe("hit");
});
test("canceling after provisional display preserves old slot selection and omits the canceled history entry",async({page})=>{
 test.skip(Boolean(stock),"Uses controlled delays before Tuto's fresh Flight shell.");
 const stats=await open(page,500);await page.locator('[data-counter="root"]').click();await page.locator('[data-counter="analytics-home"]').click();
 await warm(page,stats);await page.locator('[data-shell-link="auto"]').click();await expect(page.locator('[data-shell-loading]:visible')).toBeVisible();
 await page.locator('[data-go="settings"]').click();await expect(page.locator('[data-counter="settings"]')).toBeVisible();
 await expect.poll(()=>stats.cancelled).toBeGreaterThan(0);await expect(page.locator('[data-counter="analytics-home"]')).toHaveText("analytics-home:1");
 await page.locator('[data-back]').click();await expect(page.locator('[data-path]')).toHaveText("/dashboard?");await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
});
test("fresh transport failure restores the committed view and releases the prefetch guard",async({page})=>{
 test.skip(Boolean(stock),"Uses a controlled fresh-navigation HTTP failure.");
 const stats=await open(page,300,true);await page.locator('[data-counter="home"]').click();await warm(page,stats);
 await page.locator('[data-shell-link="auto"]').click();await expect(page.locator('[data-shell-loading]:visible')).toBeVisible();
 await expect(page.locator('[data-counter="home"]')).toHaveText("home:1");await expect(page.locator('[data-shell-loading]:visible')).not.toBeVisible();
 await expect(page.locator('[data-path]')).toHaveText("/dashboard?");await warm(page,stats);
 expect(stats.events.filter(event=>event.prefetch)).toHaveLength(2);
});
test("action cookie changes invalidate warmed shells before fresh navigation",async({page})=>{
 const stats=await open(page);await page.locator('[data-counter="root"]').click();await warm(page,stats);
 await page.locator('[data-shell-action]').click();await expect(page.locator('[data-shell-action-status]')).toHaveText("changed");
 await page.locator('[data-shell-link="auto"]').click();await expect(page.locator('[data-shell-fresh]')).toHaveText(stock?"fresh:signed-in":"navigation:signed-in");
 await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
 if(!stock)expect(stats.events.filter(event=>event.shell)).toHaveLength(0);
});
test("prefetched intercepted loading preserves its background, refresh and native modal history",async({page})=>{
 const stats=await open(page);await page.locator('[data-counter="home"]').click();
 const before=stats.events.length;await page.locator('[data-shell-link="intercepted"]').hover();
 if(!stock)await expect.poll(()=>stats.events.slice(before).some(event=>event.prefetch&&event.done)).toBe(true);
 await page.locator('[data-shell-link="intercepted"]').click();await expect(page.locator('[data-modal]')).toBeVisible();
 await expect(page.locator('[data-counter="home"]')).toHaveText("home:1");await page.locator('[data-counter="modal"]').click();
 await page.locator('[data-refresh]').click();await expect(page.locator('[data-counter="modal"]')).toHaveText("modal:1");
 await page.locator('[data-back]').click();await expect(page.locator('[data-counter="home"]')).toHaveText("home:1");
 await page.locator('[data-forward]').click();await expect(page.locator('[data-counter="modal"]')).toHaveText(stock?"modal:0":"modal:1");
 if(!stock)expect(stats.events.some(event=>event.shell&&["shell-hit","shell-ack"].includes(event.hit??""))).toBe(true);
});

test("shell navigation keeps streamed error, notFound and redirect control flow local",async({page})=>{
 const stats=await open(page);await page.locator('[data-counter="root"]').click();
 for(const [path,selector] of [["stream-error","[data-stream-error]"],["stream-missing","[data-stream-not-found]"],["stream-redirect",'[data-counter="settings"]']]){
  await page.locator('[data-shell-target]').fill("/dashboard/"+path);await warm(page,stats);
  await page.locator('[data-shell-link="auto"]').click();await expect(page.locator(selector)).toBeVisible();
  await expect(page.locator('[data-counter="root"]')).toHaveText("root:1");
 }
 await expect(page.locator('[data-path]')).toHaveText("/dashboard/settings?redirected=yes");
 if(!stock)expect(stats.events.filter(event=>event.shell&&["shell-hit","shell-ack"].includes(event.hit??""))).toHaveLength(3);
});

test("prefetched primary and nested slot loading stream independently without remounting shared slot layouts",async({page})=>{
 const stats=await open(page,500);
 await page.locator('[data-counter="team-layout"]').click();await page.locator('[data-counter="analytics-home"]').click();
 await page.locator('[data-shell-target]').fill("/dashboard/slow");await warm(page,stats);
 await page.locator('[data-shell-link="auto"]').click();
 await expect(page.locator('[data-primary-loading]:visible')).toBeVisible();
 await expect(page.locator('[data-team-loading]:visible')).toBeVisible();
 await expect(page.locator('[data-detail-loading]:visible')).toBeVisible();
 await expect(page.locator('[data-counter="slow"]')).toBeVisible();await expect(page.locator('[data-stream-details]')).toBeVisible();
 await expect(page.locator('[data-counter="team-slow"]')).toBeVisible();await expect(page.locator('[data-counter="detail-slow"]')).toBeVisible();
 await expect(page.locator('[data-counter="team-layout"]')).toHaveText("team-layout:1");
 await expect(page.locator('[data-counter="analytics-home"]')).toHaveText("analytics-home:1");
 if(!stock)expect(stats.events.some(event=>event.shell&&["shell-hit","shell-ack"].includes(event.hit??""))).toBe(true);
});
