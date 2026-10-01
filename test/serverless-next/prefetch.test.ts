import {afterAll,expect,test} from "vitest";
import {compileNextRequestWorkspace} from "../../lib/serverless-next/compiler";
import {POST} from "../../app/api/serverless/nextjs-runtime/request/route";
import {executeNextRequestArtifact} from "../../lib/serverless-next/runtime";
import {NextPrefetchTickets,nextPrefetchKey} from "../../lib/serverless-next/prefetch";
import type {NextRequestArtifact} from "../../lib/serverless-next/artifact";
import {closeNextRscWorkerPoolForTests} from "../../lib/serverless-next/rsc-worker-pool";
import {closeNextSsrWorkerPoolForTests} from "../../lib/serverless-next/ssr-worker-pool";
import {prefetchWorkspace} from "./fixtures/prefetch-workspace";
afterAll(async()=>{await closeNextRscWorkerPoolForTests();await closeNextSsrWorkerPoolForTests();});
const salt="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
async function compile(key:string, proxy=false){return compileNextRequestWorkspace([...prefetchWorkspace(),...(proxy?[{path:"proxy.ts",language:"ts" as const,content:`import {NextResponse} from "next/server"; let calls=0; export function proxy(){ const response=NextResponse.next();response.headers.set("x-proxy-calls",String(++calls));return response;}`}]:[])],{workspaceKey:key,serverReferenceHashSalt:salt});}
async function post(artifact:NextRequestArtifact, extra:object={}) {
 return POST(new Request("http://tuto.local/request",{method:"POST",headers:{"content-type":"text/plain"},body:JSON.stringify({navigation:{revision:artifact.revision,url:"/dashboard/prefetched",kind:"push",id:"unit-prefetch",prefetch:true,prefetchOwner:"owner",...extra}})}));
}
test("reuses page Flight exactly once and never speculatively invokes handlers or proxies",async()=>{
 const artifact=await compile("prefetch-api");
 const warmed=await post(artifact);expect(warmed.status).toBe(200);const {ticket}=await warmed.json();
 const hit=await post(artifact,{prefetch:false,prefetchTicket:ticket});expect(hit.headers.get("x-tuto-next-prefetch")).toBe("hit");expect(await hit.text()).toContain(String.raw`\"reads\":2`);
 const miss=await post(artifact,{prefetch:false,prefetchTicket:ticket});expect(miss.headers.get("x-tuto-next-prefetch")).toBe("miss");await miss.text();
 expect((await post(artifact,{url:"/api/effect"})).status).toBe(204);
 expect(await (await executeNextRequestArtifact(artifact,{url:"/api/effect"})).json()).toEqual({calls:1});
 const guarded=await compile("prefetch-proxy",true);expect((await post(guarded)).status).toBe(204);
 const normal=await executeNextRequestArtifact(guarded,{url:"/dashboard"});expect(normal.headers.get("x-proxy-calls")).toBe("1");await normal.text();
});
test("refresh invalidates previously issued tickets and changed headers cannot consume them",async()=>{
 const artifact=await compile("prefetch-invalidation");
 const {ticket}=await (await post(artifact)).json();
 const changed=await post(artifact,{prefetch:false,prefetchTicket:ticket,headers:{cookie:"identity=other",authorization:"Bearer other"}});
 expect(changed.headers.get("x-tuto-next-prefetch")).toBe("miss");expect(await changed.text()).toContain("other");
 const refresh=await post(artifact,{prefetch:false,kind:"refresh",url:"/dashboard"});await refresh.text();
 const stale=await post(artifact,{prefetch:false,prefetchTicket:ticket});expect(stale.headers.get("x-tuto-next-prefetch")).toBe("miss");await stale.text();
});
test("bounds tickets, expiry, owner and artifact isolation, and rejects renders racing invalidation",async()=>{
 let now=0;const cache=new NextPrefetchTickets(()=>now);
 const artifact={} as NextRequestArtifact;const other={} as NextRequestArtifact;
 const entry={artifact,owner:"a",key:"route",epoch:0,body:new Uint8Array([1]),headers:[] as Array<[string,string]>,status:200};
 const ticket=cache.put(entry)!;
 expect(cache.take(ticket,other,"a","route")).toBeNull();expect(cache.take(ticket,artifact,"b","route")).toBeNull();
 expect(cache.take(ticket,artifact,"a","route")?.body).toEqual(entry.body);expect(cache.take(ticket,artifact,"a","route")).toBeNull();
 const expired=cache.put(entry)!;now=30_000;expect(cache.take(expired,artifact,"a","route")).toBeNull();
 const oldest=cache.put({...entry,key:"first"})!;for(let i=0;i<8;i++)cache.put({...entry,key:String(i)});expect(cache.take(oldest,artifact,"a","first")).toBeNull();
 cache.invalidate(artifact);expect(cache.put(entry)).toBeNull();
 expect(cache.put({...entry,epoch:cache.epoch(artifact),body:new Uint8Array(1024*1024+1)})).toBeNull();
});


test("keys include complete request context and slot history but omit transport IDs and hashes",()=>{
 const state={navigationId:"old",slots:{team:{page:"team",url:"/team"}}} as unknown as import("../../lib/serverless-next/navigation").NextRouterState;
 const key=nextPrefetchKey("rev","/target?q=1#one",{Cookie:"auth=a",Authorization:"Bearer one"},state);
 expect(nextPrefetchKey("rev","/target?q=1#two",{authorization:"Bearer one",cookie:"auth=a"},{...state,navigationId:"new"})).toBe(key);
 expect(nextPrefetchKey("rev","/target?q=2",{cookie:"auth=a",authorization:"Bearer one"},state)).not.toBe(key);
 expect(nextPrefetchKey("rev","/target?q=1",{cookie:"auth=b",authorization:"Bearer one"},state)).not.toBe(key);
 expect(nextPrefetchKey("new","/target?q=1",{cookie:"auth=a",authorization:"Bearer one"},state)).not.toBe(key);
 expect(nextPrefetchKey("rev","/target?q=1",{cookie:"auth=a",authorization:"Bearer one"},{...state,slots:{}})).not.toBe(key);
});

test("a Server Action invalidates tickets held by another document",async()=>{
 const artifact=await compile("prefetch-action-invalidation");
 const {ticket}=await (await post(artifact)).json();
 const actionId=Object.entries(artifact.actionManifest).find(([,reference])=>reference.exportName==="change")![0];
 const action=await POST(new Request("http://tuto.local/request",{method:"POST",headers:{"content-type":"text/plain"},body:JSON.stringify({action:{revision:artifact.revision,url:"/dashboard",actionId,body:{kind:"string",value:"[]"}}})}));
 expect(action.status).toBe(200);await action.text();
 const response=await post(artifact,{prefetch:false,prefetchTicket:ticket});
 expect(response.headers.get("x-tuto-next-prefetch")).toBe("miss");
 expect(await response.text()).toContain(String.raw`\"version\":1`);
});


test("aborting speculative Flight does not issue a ticket or block the next request",async()=>{
 const {streamedNavigationWorkspace}=await import("./fixtures/streamed-navigation-workspace");
 const artifact=await compileNextRequestWorkspace(streamedNavigationWorkspace(),{workspaceKey:"prefetch-abort",serverReferenceHashSalt:salt});
 const controller=new AbortController();
 const response=POST(new Request("http://tuto.local/request",{method:"POST",signal:controller.signal,headers:{"content-type":"text/plain"},body:JSON.stringify({navigation:{revision:artifact.revision,url:"/dashboard/slow",kind:"push",prefetch:true,prefetchOwner:"abort",id:"abort-prefetch"}})}));
 await new Promise(resolve=>setImmediate(resolve));controller.abort();
 expect((await response).status).toBeGreaterThanOrEqual(400);
 const next=await post(artifact,{prefetch:false,url:"/dashboard"});
 expect(next.status).toBe(200);expect(await next.text()).toContain("home");
});
