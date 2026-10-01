import { afterAll, expect, test } from "vitest";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import { POST } from "../../app/api/serverless/nextjs-runtime/request/route";
import { closeNextRscWorkerPoolForTests } from "../../lib/serverless-next/rsc-worker-pool";
import { closeNextSsrWorkerPoolForTests } from "../../lib/serverless-next/ssr-worker-pool";
import type { NextRequestArtifact } from "../../lib/serverless-next/artifact";
import { revalidationPrefetchWorkspace } from "./fixtures/revalidation-prefetch-workspace";

afterAll(async () => { await closeNextRscWorkerPoolForTests(); await closeNextSsrWorkerPoolForTests(); });
const salt="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const compile=(workspaceKey:string)=>compileNextRequestWorkspace(revalidationPrefetchWorkspace(),{workspaceKey,serverReferenceHashSalt:salt});
async function navigate(artifact:NextRequestArtifact,extra:object={}) {
  return POST(new Request("http://tuto.local/request",{method:"POST",headers:{"content-type":"text/plain"},
    body:JSON.stringify({navigation:{revision:artifact.revision,url:"/dashboard/prefetched",kind:"push",prefetchOwner:"owner",prefetch:true,...extra}})}));
}
async function mutate(artifact:NextRequestArtifact,kind:string) {
  const response=await executeNextRequestArtifact(artifact,{url:"/api/revalidate",method:"POST",body:JSON.stringify({kind}),headers:{"content-type":"application/json"}});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({kind});
}

for(const kind of ["tag","page"]){
  test(`Route Handler ${kind} invalidation expires unused full Flight across documents without affecting another workspace`,async()=>{
    const artifact=await compile("route-invalidate-"+kind),other=await compile("route-isolated-"+kind);
    const warmed=await(await navigate(artifact)).json(),second=await(await navigate(artifact,{prefetchOwner:"other-document"})).json();
    const isolated=await(await navigate(other)).json();
    await mutate(artifact,kind);
    const response=await navigate(artifact,{prefetch:false,prefetchTicket:warmed.ticket});
    expect(response.headers.get("x-tuto-next-prefetch")).toBe("miss");
    expect(await response.text()).toContain('"data-tagged-leaf":true,"children":2');
    const alsoExpired=await navigate(artifact,{prefetch:false,prefetchOwner:"other-document",prefetchTicket:second.ticket});
    expect(alsoExpired.headers.get("x-tuto-next-prefetch")).toBe("miss");await alsoExpired.text();
    const unaffected=await navigate(other,{prefetch:false,prefetchTicket:isolated.ticket});
    expect(unaffected.headers.get("x-tuto-next-prefetch")).toBe("hit");await unaffected.text();
    const again=await(await navigate(artifact)).json();
    const hit=await navigate(artifact,{prefetch:false,prefetchTicket:again.ticket});
    expect(hit.headers.get("x-tuto-next-prefetch")).toBe("hit");await hit.text();
  });
}

for(const kind of ["tag","layout","dynamic"]){
  test(`Route Handler ${kind} invalidation rejects old shell receipts and renders fresh layout/page models`,async()=>{
    const artifact=await compile("route-shell-invalidate-"+kind);
    const url=kind==="dynamic"?"/dashboard/shared/three":"/dashboard/shared/one";
    const args={url,prefetchMode:"auto"};
    // Prime page data as well as shell/layout data before the mutation.
    await(await navigate(artifact,{prefetch:false,url})).text();
    const {ticket,segmentGrant}=await(await navigate(artifact,args)).json();
    expect(segmentGrant.keys.length).toBeGreaterThan(0);
    await mutate(artifact,kind);
    const fresh=await navigate(artifact,{...args,prefetch:false,prefetchTicket:ticket,prefetchShell:true,prefetchShellAck:true,prefetchShellStream:true,segmentRefs:[segmentGrant]});
    expect(fresh.headers.get("x-tuto-next-prefetch")).toBe("shell-stream-miss");
    const flight=await fresh.text();expect(flight).toContain("data-shared-root");expect(flight).toContain("data-tagged-layout");
    if(kind!=="dynamic")expect(flight).toContain('"data-tagged-layout":true,"children":2');
    else expect(flight).toMatch(/data-tagged-dynamic[^\n]+"three",":",2/);
    const next=await(await navigate(artifact,args)).json();
    const hit=await navigate(artifact,{...args,prefetch:false,prefetchTicket:next.ticket,prefetchShell:true,prefetchShellAck:true,prefetchShellStream:true,segmentRefs:[next.segmentGrant]});
    expect(hit.headers.get("x-tuto-next-prefetch")).toBe("shell-stream-hit");
    expect(await hit.text()).not.toContain("data-tagged-layout");
  });
}

test("max-profile revalidation evicts warmed Flight while preserving Next stale-while-revalidate data semantics",async()=>{
  const artifact=await compile("route-max-invalidate");
  const {ticket}=await(await navigate(artifact)).json();
  await mutate(artifact,"max");
  const fresh=await navigate(artifact,{prefetch:false,prefetchTicket:ticket});
  expect(fresh.headers.get("x-tuto-next-prefetch")).toBe("miss");
  expect(await fresh.text()).toContain('"data-tagged-leaf":true,"children":1');
  const refreshed=await navigate(artifact,{prefetch:false});
  expect(await refreshed.text()).toContain('"data-tagged-leaf":true,"children":2');
});
