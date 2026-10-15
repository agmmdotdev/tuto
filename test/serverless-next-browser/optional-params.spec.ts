import {randomUUID} from "node:crypto";
import {createServer,type Server} from "node:http";
import {once} from "node:events";
import {expect,test,type Page} from "@playwright/test";
import {compileNextRequestWorkspace} from "../../lib/serverless-next/compiler";
import {executeNextRequestArtifact} from "../../lib/serverless-next/runtime";
import {POST,OPTIONS} from "../../app/api/serverless/nextjs-runtime/request/route";
import {optionalParamsWorkspace} from "../serverless-next/fixtures/optional-params-workspace";
const stock=process.env.TUTO_NEXT_OPTIONAL_PARAMS_STOCK_ORIGIN;
const omitted={keys:["tenant"],own:false,value:null,kind:"undefined"};
const present={keys:["parts","tenant"],own:true,value:["a","two"],kind:"array"};
const servers:Server[]=[];
test.afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
async function shape(page:Page,attr:string,expected:object){await expect(page.locator(`[${attr}]:visible`)).toHaveText(JSON.stringify(expected));}

for(const target of ["tuto","stock"] as const){
  async function open(page:Page,url="/acme/docs",events:Array<{prefetch:boolean;hit:string|null}>=[]){
    if(target==="stock"){
      for(const tenant of ["acme","beta"])expect((await fetch(stock!+"/api/invalidate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({tenant})})).status).toBe(200);
      await page.goto(stock!+url);
      return (path:string,method="GET",body?:string)=>fetch(stock!+path,{method,headers:body?{"content-type":"application/json"}:{},body});
    }
    const artifact=await compileNextRequestWorkspace(optionalParamsWorkspace(),{workspaceKey:"optional-browser-"+randomUUID(),serverReferenceHashSalt:"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="});
    const server=createServer((incoming,outgoing)=>{void(async()=>{
      const controller=new AbortController();outgoing.on("close",()=>{if(!outgoing.writableFinished)controller.abort();});
      const chunks=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk));
      const body=Buffer.concat(chunks).toString();
      const response=incoming.method==="OPTIONS"?OPTIONS():await POST(new Request("http://optional.local/request",{method:"POST",headers:{"content-type":"text/plain"},body,signal:controller.signal}));
      const navigation=body?JSON.parse(body).navigation:undefined;
      if(navigation)events.push({prefetch:navigation.prefetch===true,hit:response.headers.get("x-tuto-next-prefetch")});
      outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.flushHeaders();
      if(response.body){const reader=response.body.getReader();for(;;){const chunk=await reader.read();if(chunk.done)break;if(!outgoing.write(chunk.value))await once(outgoing,"drain");}}
      outgoing.end();
    })().catch(error=>{if(!outgoing.destroyed)outgoing.destroy(error as Error);});});
    servers.push(server);server.listen(0,"127.0.0.1");await once(server,"listening");const port=(server.address() as {port:number}).port;
    await page.setContent(await(await executeNextRequestArtifact(artifact,{url,hydrate:true,actionEndpoint:`http://127.0.0.1:${port}/request`})).text());
    await page.waitForFunction(()=>Boolean((globalThis as Record<string,unknown>).__TUTO_NEXT_ROUTER_STATE__));
    return (path:string,method="GET",body?:string)=>executeNextRequestArtifact(artifact,{url:path,method,headers:body?{"content-type":"application/json"}:{},body});
  }
  const check=target==="stock"&&!stock?test.skip:test;
  check(`${target}: omitted page/default/client keys stay absent through hydration, navigation, history and refresh`,async({page})=>{
    const hydrationErrors:string[]=[];page.on("console",message=>{if(message.type()==="error"&&/hydration|#418/i.test(message.text()))hydrationErrors.push(message.text());});
    await open(page);
    for(const attr of ["data-page-params","data-default-params","data-client-params"])await shape(page,attr,omitted);
    const first=JSON.parse((await page.locator("[data-cache]:visible").textContent())!);expect(first.actual).toEqual(first.omitted);
    await page.locator("[data-counter]:visible").click();await page.locator("[data-present]:visible").click();
    for(const attr of ["data-page-params","data-default-params","data-client-params"])await shape(page,attr,present);
    await expect(page.locator("[data-counter]:visible")).toHaveText("parent:1");
    await page.locator("[data-back]:visible").click();await shape(page,"data-page-params",omitted);await shape(page,"data-client-params",omitted);
    await page.locator("[data-forward]:visible").click();await shape(page,"data-page-params",present);
    await page.locator("[data-empty]:visible").click();await shape(page,"data-page-params",omitted);
    await page.locator("[data-refresh]:visible").click();await shape(page,"data-default-params",omitted);await shape(page,"data-client-params",omitted);
    await expect(page.locator("[data-counter]:visible")).toHaveText("parent:1");
    expect(JSON.parse((await page.locator("[data-cache]:visible").textContent())!).actual).toEqual(first.actual);expect(hydrationErrors).toEqual([]);
  });
  check(`${target}: GET/POST omitted handler keys share the canonical empty argument and invalidate by tenant`,async({page})=>{
    const call=await open(page);
    // Seed with the handler bundle so fixture counters are comparable on stock.
    expect((await call("/api/invalidate","POST",JSON.stringify({tenant:"acme"}))).status).toBe(200);
    const initial=await(await call("/api/acme/docs")).json();expect(initial.params).toEqual(omitted);expect(initial.actual).toEqual(initial.omitted);
    const post=await(await call("/api/acme/docs","POST")).json();expect(post).toEqual(initial);
    const filled=await(await call("/api/acme/docs/a/two")).json();expect(filled.params).toEqual(present);expect(filled.omitted).toEqual(initial.omitted);
    const encoded=await(await call("/api/acme/docs/a/two%20words")).json();expect(encoded.params).toEqual({...present,value:["a","two words"]});
    const other=await(await call("/api/beta/docs")).json();
    expect((await call("/api/invalidate","POST",JSON.stringify({tenant:"acme"}))).status).toBe(200);
    const fresh=await(await call("/api/acme/docs")).json();expect(fresh.actual).toEqual(fresh.omitted);expect(fresh.actual.count).toBe(initial.actual.count+1);
    expect((await(await call("/api/beta/docs")).json()).actual).toEqual(other.actual);
  });
  check(`${target}: client page promises project an empty segment while hooks omit it and required/scalar values stay intact`,async({page})=>{
    await open(page,"/acme/client");await shape(page,"data-client-page",{...present,value:[""]});await shape(page,"data-client-params",omitted);
    await open(page,"/acme/client/a/two");await shape(page,"data-client-page",present);await shape(page,"data-client-params",present);
    await open(page,"/acme/required/a/two");await shape(page,"data-page-params",present);
    await open(page,"/acme/scalar/zero");await shape(page,"data-page-params",{...present,value:"zero",kind:"string"});
    // Pinned stock Cache Components keep encoded page values; handlers decode.
    // Record this existing value-projection gap separately from own-key parity.
    await open(page,"/acme/docs/a/two%20words");
    const encoded={...present,value:["a",target==="stock"?"two%20words":"two words"]};
    for(const attr of ["data-page-params","data-default-params","data-client-params"])await shape(page,attr,encoded);
  });
  if(target==="tuto")check("an omitted optional prefetch cannot survive its cache tag mutation or restore a phantom client key",async({page})=>{
    const events:Array<{prefetch:boolean;hit:string|null}>=[];
    const call=await open(page,"/acme/docs",events);
    const before=JSON.parse((await page.locator("[data-cache]:visible").textContent())!).actual;
    await page.locator("[data-counter]:visible").click();await page.locator("[data-present]:visible").click();await shape(page,"data-page-params",present);
    await page.evaluate(async()=>{await(globalThis as typeof globalThis&{__TUTO_NEXT_PREFETCH__:(url:string,options:object)=>Promise<void>}).__TUTO_NEXT_PREFETCH__("/acme/docs",{_prefetchMode:"full"});});
    expect(events.some(event=>event.prefetch)).toBe(true);
    expect((await call("/api/invalidate","POST",JSON.stringify({tenant:"acme"}))).status).toBe(200);
    await page.locator("[data-empty]:visible").click();
    for(const attr of ["data-page-params","data-default-params","data-client-params"])await shape(page,attr,omitted);
    const cached=JSON.parse((await page.locator("[data-cache]:visible").textContent())!);expect(cached.actual).toEqual(cached.omitted);expect(cached.actual.count).toBe(before.count+1);
    expect(events.filter(event=>!event.prefetch).at(-1)?.hit).toBe("miss");await expect(page.locator("[data-counter]:visible")).toHaveText("parent:1");
  });
}
