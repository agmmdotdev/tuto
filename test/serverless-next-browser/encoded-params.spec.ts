import {randomUUID} from "node:crypto";
import {createServer,type Server} from "node:http";
import {once} from "node:events";
import {expect,test,type Page} from "@playwright/test";
import {compileNextRequestWorkspace} from "../../lib/serverless-next/compiler";
import {executeNextRequestArtifact} from "../../lib/serverless-next/runtime";
import {POST,OPTIONS} from "../../app/api/serverless/nextjs-runtime/request/route";
import {encodedCases,encodedParamsWorkspace} from "../serverless-next/fixtures/encoded-params-workspace";
const stock=process.env.TUTO_NEXT_ENCODED_PARAMS_STOCK_ORIGIN;
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
    const artifact=await compileNextRequestWorkspace(encodedParamsWorkspace(),{workspaceKey:"optional-browser-"+randomUUID(),serverReferenceHashSalt:"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="});
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
  check(`${target}: encoded separators, Unicode and repeated encoding match each rendered/handler context`,async({page})=>{
    for(const item of encodedCases){
      const call=await open(page,"/caf%c3%a9/docs/"+item.input);
      const expected={tenant:"caf%C3%A9",parts:[item.rendered]};
      for(const attr of ["data-all-page","data-all-default","data-all-client","data-nested-layout"])await shape(page,attr,expected);
      await shape(page,"data-root-layout",{tenant:"caf%C3%A9"});await expect(page.locator("[data-root-value]:visible")).toHaveText("caf%C3%A9");
      await shape(page,"data-selected",["docs",item.rendered]);
      const response=await call("/api/acme/docs/"+item.input);expect(response.status).toBe(200);expect((await response.json()).params.value).toEqual([item.decoded]);
    }
    await open(page,"/acme/client/a%2fb");await shape(page,"data-all-client-page",{tenant:"acme",parts:["a%2Fb"]});
    await open(page,"/acme/scalar/%252F");await shape(page,"data-all-page",{tenant:"acme",parts:"%252F"});await expect(page).toHaveTitle(JSON.stringify({tenant:"acme",parts:"%2F"}));
  });
  check(`${target}: navigation and cache aliases preserve boundaries and parent state through refresh/history`,async({page})=>{
    const call=await open(page,"/acme/docs/a%2fb");
    const before=JSON.parse((await page.locator("[data-cache]:visible").textContent())!);await page.locator("[data-counter]:visible").click();
    async function go(path:string,parts:string[]){await page.locator("[data-target]:visible").fill(path);await page.locator("[data-go]:visible").click();await shape(page,"data-all-page",{tenant:"acme",parts});await shape(page,"data-all-client",{tenant:"acme",parts});}
    await go("/acme/docs/a%2Fb",["a%2Fb"]);expect(JSON.parse((await page.locator("[data-cache]:visible").textContent())!)).toEqual(before);
    await go("/acme/docs/a%252Fb",["a%252Fb"]);await page.locator("[data-back]:visible").click();await shape(page,"data-all-page",{tenant:"acme",parts:["a%2Fb"]});
    expect((await call("/api/invalidate","POST",JSON.stringify({tenant:"acme"}))).status).toBe(200);await page.locator("[data-refresh]:visible").click();
    await expect.poll(async()=>JSON.parse((await page.locator("[data-cache]:visible").textContent())!).count).toBe(before.count+1);await expect(page.locator("[data-counter]:visible")).toHaveText("parent:1");
  });
  check(`${target}: malformed escapes are rejected and a following valid request still works`,async({page})=>{
    const call=await open(page);
    for(const bad of ["%ZZ","%E0%A4%A","%C0%AF","%ED%A0%80"]){for(const prefix of ["/acme/docs/","/api/acme/docs/"]){
      if(target==="stock")expect((await call(prefix+bad)).status).toBe(500);
      else await expect(call(prefix+bad)).rejects.toThrow(/URI|decode/i);
    }}
    if(target==="tuto"){
      const response=await POST(new Request("http://encoded.local/request",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({files:encodedParamsWorkspace(),workspaceKey:"malformed-"+randomUUID(),request:{path:"/acme/docs/%ZZ"}})}));
      expect(response.status).toBe(400);expect((await response.json()).success).toBe(false);
    }
    expect((await call("/api/acme/docs/valid")).status).toBe(200);
  });
  if(target==="tuto")check("encoded full prefetch invalidation cannot alias a decoded separator or lose parent state",async({page})=>{
    const events:Array<{prefetch:boolean;hit:string|null}>=[];const call=await open(page,"/acme/docs/a%2Fb",events);await page.locator("[data-counter]:visible").click();
    await page.evaluate(async()=>{await(globalThis as typeof globalThis&{__TUTO_NEXT_PREFETCH__:(url:string,options:object)=>Promise<void>}).__TUTO_NEXT_PREFETCH__("/acme/docs/a%252Fb",{_prefetchMode:"full"});});
    expect(events.some(event=>event.prefetch)).toBe(true);await call("/api/invalidate","POST",JSON.stringify({tenant:"acme"}));
    await page.locator("[data-target]:visible").fill("/acme/docs/a%252Fb");await page.locator("[data-go]:visible").click();await shape(page,"data-all-page",{tenant:"acme",parts:["a%252Fb"]});
    expect(events.filter(event=>!event.prefetch).at(-1)?.hit).toBe("miss");await expect(page.locator("[data-counter]:visible")).toHaveText("parent:1");
  });
}
