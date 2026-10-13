import {randomUUID} from "node:crypto";
import {createServer, type Server} from "node:http";
import {once} from "node:events";
import {expect, test, type Page} from "@playwright/test";
import {compileNextRequestWorkspace} from "../../lib/serverless-next/compiler";
import {executeNextRequestArtifact} from "../../lib/serverless-next/runtime";
import {POST, OPTIONS} from "../../app/api/serverless/nextjs-runtime/request/route";
import {nestedLayoutWorkspace} from "../serverless-next/fixtures/nested-layout-workspace";
const stock=process.env.TUTO_NEXT_LAYOUT_PARAMS_STOCK_ORIGIN;
const servers:Server[]=[];
test.afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
const own={org:"acme",project:"red"};
const layout=(page:Page,name:string)=>page.locator(`[data-layout="${name}"]:visible`);
const count=(page:Page,name:string)=>page.locator(`[data-count="${name}"]:visible`);
const cache=(page:Page,name:string)=>page.locator(`[data-cache="${name}"]:visible`);

for(const target of ["tuto","stock"] as const){
  async function open(page:Page,url="/acme/projects/red/items/one"){
    if(target==="stock"){
      for(const level of ["org","project"])expect((await fetch(stock!+"/api/invalidate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({level})})).status).toBe(200);
      await page.goto(stock!+url);
      return async(level:string)=>{expect((await fetch(stock!+"/api/invalidate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({level})})).status).toBe(200);};
    }
    const artifact=await compileNextRequestWorkspace(nestedLayoutWorkspace(),{workspaceKey:"layout-browser-"+randomUUID(),serverReferenceHashSalt:"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="});
    const server=createServer((incoming,outgoing)=>{void(async()=>{
      const controller=new AbortController();outgoing.on("close",()=>{if(!outgoing.writableFinished)controller.abort();});
      const chunks=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk));
      const response=incoming.method==="OPTIONS"?OPTIONS():await POST(new Request("http://layout.local/request",{method:"POST",headers:{"content-type":"text/plain"},body:Buffer.concat(chunks).toString(),signal:controller.signal}));
      outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.flushHeaders();
      if(response.body){const reader=response.body.getReader();for(;;){const chunk=await reader.read();if(chunk.done)break;if(!outgoing.write(chunk.value))await once(outgoing,"drain");}}
      outgoing.end();
    })().catch(error=>{if(!outgoing.destroyed)outgoing.destroy(error as Error);});});
    servers.push(server);server.listen(0,"127.0.0.1");await once(server,"listening");const port=(server.address() as {port:number}).port;
    await page.setContent(await(await executeNextRequestArtifact(artifact,{url,hydrate:true,actionEndpoint:`http://127.0.0.1:${port}/request`})).text());
    await page.waitForFunction(()=>Boolean((globalThis as Record<string,unknown>).__TUTO_NEXT_ROUTER_STATE__));
    return async(level:string)=>{expect((await executeNextRequestArtifact(artifact,{url:"/api/invalidate",method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({level})})).status).toBe(200);};
  }
  const check=target==="stock"&&!stock?test.skip:test;
  check(`${target}: promised client/server layout params stay scoped through sibling and owner navigation`,async({page})=>{
    await open(page);
    await expect(layout(page,"org")).toHaveText('{"org":"acme"}');
    for(const level of ["project","client-items","audit"])await expect(layout(page,level)).toHaveText(JSON.stringify(own));
    await expect(page.locator("[data-use-params]:visible")).toHaveText('{"org":"acme","project":"red","id":"one"}');
    const before=JSON.parse((await cache(page,"project").textContent())!);
    for(const level of ["org","project","client-items","item","audit"])await count(page,level).click();
    await page.locator("[data-next]:visible").click();
    await expect(page.locator("[data-page]:visible")).toHaveText('{"org":"acme","project":"red","id":"two"}');
    await expect(page.locator("[data-use-params]:visible")).toHaveText('{"org":"acme","project":"red","id":"two"}');
    for(const level of ["org","project","client-items","audit"])await expect(count(page,level)).toHaveText(level+":1");
    await expect(count(page,"item")).toHaveText("item:0");
    await expect(cache(page,"project")).toHaveText(JSON.stringify(before));
    await page.locator("[data-project]:visible").click();
    await expect(layout(page,"project")).toHaveText('{"org":"acme","project":"blue"}');
    await expect(count(page,"org")).toHaveText("org:1");
    await expect(count(page,"project")).toHaveText("project:0");
    await page.locator("[data-org]:visible").click();
    await expect(layout(page,"org")).toHaveText('{"org":"beta"}');
    await expect(count(page,"org")).toHaveText("org:0");
  });
  check(`${target}: tag refresh keeps layout/client state while recomputing the scoped cached value`,async({page})=>{
    const invalidate=await open(page);
    const before=JSON.parse((await cache(page,"project").textContent())!);
    const ancestor=await cache(page,"org").textContent();
    for(const level of ["org","project","client-items"])await count(page,level).click();
    await invalidate("project");await page.locator("[data-refresh]:visible").click();
    await expect.poll(async()=>JSON.parse((await cache(page,"project").textContent())!).count).toBe(before.count+1);
    await expect(cache(page,"org")).toHaveText(ancestor!);
    for(const level of ["org","project","client-items"])await expect(count(page,level)).toHaveText(level+":1");
    await expect(layout(page,"client-items")).toHaveText(JSON.stringify(own));
  });
  check(`${target}: intercepted slot layout gets its own param and history preserves the background layouts`,async({page})=>{
    await open(page);await count(page,"project").click();await count(page,"client-items").click();
    await page.locator("[data-photo]:visible").click();
    await expect(layout(page,"modal")).toHaveText('{"org":"acme","project":"red","photoId":"seven"}');
    for(const level of ["project","client-items","audit"])await expect(layout(page,level)).toHaveText(JSON.stringify(own));
    const params=JSON.parse((await page.locator("[data-use-params]:visible").textContent())!);
    expect(params).toEqual({org:"acme",project:"red",id:"one",photoId:"seven"});
    await expect(count(page,"project")).toHaveText("project:1");
    await expect(count(page,"client-items")).toHaveText("client-items:1");
    await page.locator("[data-back]:visible").click();
    await expect(layout(page,"modal")).toHaveCount(0);
    await expect(page.locator("[data-use-params]:visible")).toHaveText('{"org":"acme","project":"red","id":"one"}');
    await expect(count(page,"client-items")).toHaveText("client-items:1");
  });
  check(`${target}: dynamic interception markers and up-level targets retain applicable owner parameters`,async({page})=>{
    await open(page);await page.locator("[data-dynamic]:visible").click();
    await expect(layout(page,"dynamic-modal")).toHaveText('{"org":"acme","project":"red","token":"seven"}');
    await count(page,"dynamic-modal").click();
    await page.locator("[data-dynamic-next]:visible").click();
    await expect(layout(page,"dynamic-modal")).toHaveText('{"org":"acme","project":"red","token":"eight"}');
    await expect(count(page,"dynamic-modal")).toHaveText("dynamic-modal:0");
    await page.locator("[data-back]:visible").click();
    await expect(layout(page,"dynamic-modal")).toHaveText('{"org":"acme","project":"red","token":"seven"}');
    await page.locator("[data-back]:visible").click();await expect(layout(page,"dynamic-modal")).toHaveCount(0);
    await page.locator("[data-up]:visible").click();
    await expect(layout(page,"up-modal")).toHaveText('{"org":"acme","project":"red","otherId":"seven"}');
    await count(page,"up-modal").click();
    await page.locator("[data-refresh]:visible").click();
    await expect(layout(page,"up-modal")).toHaveText('{"org":"acme","project":"red","otherId":"seven"}');
    await expect(count(page,"up-modal")).toHaveText("up-modal:1");
    await expect(layout(page,"project")).toHaveText(JSON.stringify(own));
    await expect(layout(page,"client-items")).toHaveText(JSON.stringify(own));
    await page.locator("[data-project]:visible").click();
    await expect(layout(page,"project")).toHaveText('{"org":"acme","project":"blue"}');
    await expect(layout(page,"up-modal")).toHaveCount(0);
  });
  check(`${target}: catch-all values and optional own keys match the layout segment`,async({page})=>{
    await open(page,"/acme/archive/red/blue");
    await expect(layout(page,"archive")).toHaveText('{"org":"acme"}');
    await expect(layout(page,"parts")).toHaveText('{"org":"acme","parts":["red","blue"]}');
    await open(page,"/acme/optional");
    await expect(layout(page,"optional")).toHaveText('{"org":"acme"}');
    await expect(page.locator("[data-layout-keys]:visible")).toHaveText('["org"]');
    await open(page,"/acme/optional/a/b");
    await expect(layout(page,"optional")).toHaveText('{"org":"acme","parts":["a","b"]}');
  });
}
