import {afterAll,expect,test} from "vitest";
import {compileNextRequestWorkspace} from "../../lib/serverless-next/compiler";
import {POST} from "../../app/api/serverless/nextjs-runtime/request/route";
import {NextPrefetchTickets} from "../../lib/serverless-next/prefetch";
import type {NextRequestArtifact} from "../../lib/serverless-next/artifact";
import {closeNextRscWorkerPoolForTests} from "../../lib/serverless-next/rsc-worker-pool";
import {sharedSegmentsWorkspace} from "./fixtures/shared-segments-workspace";
afterAll(()=>closeNextRscWorkerPoolForTests());
const artifact={} as NextRequestArtifact;
test("segment receipts reject forged keys, another document/workspace and changed headers",()=>{
 const cache=new NextPrefetchTickets();const context=cache.segmentContext(artifact,"one",{cookie:"session=a"});const key=context+":layout";
 const grant=cache.issueSegments(artifact,"one",{cookie:"session=a"},[{key,slots:["children"]}])!;const refs=[{token:grant.token,keys:[key,"forged"]}];
 expect(cache.resolveSegments(artifact,"one",{cookie:"session=a"},refs)).toEqual([{key,slots:["children"]}]);
 expect(cache.resolveSegments(artifact,"two",{cookie:"session=a"},refs)).toEqual([]);
 expect(cache.resolveSegments({} as NextRequestArtifact,"one",{cookie:"session=a"},refs)).toEqual([]);
 expect(cache.resolveSegments(artifact,"one",{cookie:"session=b"},refs)).toEqual([]);
 expect(cache.resolveSegments(artifact,"one",{cookie:"session=a",authorization:"changed"},refs)).toEqual([]);
 expect(cache.resolveSegments(artifact,"one",{cookie:"session=a"},[{token:"forged",keys:[key]}])).toEqual([]);
});
test("segment receipts expire and artifact invalidation rejects outstanding receipts",()=>{
 let now=0;const cache=new NextPrefetchTickets(()=>now);const key=cache.segmentContext(artifact,"owner",{})+":layout";
 const grant=cache.issueSegments(artifact,"owner",{},[{key,slots:["children"]}])!;const refs=[{token:grant.token,keys:grant.keys}];now=30_000;
 expect(cache.resolveSegments(artifact,"owner",{},refs)).toEqual([]);now=0;
 cache.invalidate(artifact);expect(cache.resolveSegments(artifact,"owner",{},refs)).toEqual([]);
 expect(cache.segmentContext(artifact,"owner",{})+":layout").not.toBe(key);
});
test("segment receipt metadata stays bounded and malformed requests fail closed",()=>{
 const cache=new NextPrefetchTickets();const context=cache.segmentContext(artifact,"owner",{});
 const keys=Array.from({length:20},(_,i)=>context+":"+i);const first=cache.issueSegments(artifact,"owner",{},keys.map(key=>({key,slots:["children"]})))!;
 expect(first.keys).toHaveLength(16);for(let i=0;i<8;i++)cache.issueSegments(artifact,"owner",{},keys.map(key=>({key,slots:["children"]})));
 expect(cache.resolveSegments(artifact,"owner",{},[{token:first.token,keys:first.keys}])).toEqual([]);
 expect(cache.resolveSegments(artifact,"owner",{},[{token:first.token,keys:"oops"}])).toEqual([]);
 expect(cache.resolveSegments(artifact,"owner",{},Array(9).fill({}))).toEqual([]);
});
async function post(revision:string,input:object){return POST(new Request("http://tuto.local/request",{method:"POST",body:JSON.stringify({navigation:{revision,url:"/dashboard/shared/one",kind:"push",id:"segments-test",prefetchOwner:"owner",...input}})}));}
test("a completed shell grants reusable layouts/loading; sibling leaves remain fresh and raw hints cannot bypass rendering",async()=>{
 const artifact=await compileNextRequestWorkspace(sharedSegmentsWorkspace(),{workspaceKey:"segments-rendering",serverReferenceHashSalt:"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="});
 const warmed=await post(artifact.revision,{prefetch:true,prefetchMode:"auto"});expect(warmed.status).toBe(200);const {ticket,segmentGrant,shellFlight}=await warmed.json();expect(segmentGrant.keys.length).toBeGreaterThan(0);
 expect(Buffer.from(shellFlight,"base64").byteLength).toBeLessThanOrEqual(1024*1024);
 expect(Buffer.from(shellFlight,"base64").toString()).not.toContain('"data-shared-page"');
 const shell=await post(artifact.revision,{prefetchShell:true,prefetchMode:"auto",prefetchTicket:ticket});const original=await shell.text();expect(original).toContain("data-shared-root");expect(Buffer.from(shellFlight,"base64").toString()).toBe(original);
 const next=await post(artifact.revision,{url:"/dashboard/shared/two",segmentRefs:[{token:segmentGrant.token,keys:segmentGrant.keys}]});const flight=await next.text();
 expect(flight).not.toContain("data-shared-root");expect(flight).not.toContain("data-shared-layout");expect(flight).not.toContain("data-shared-loading");expect(flight).toContain("data-shared-page");expect(flight).toContain('["two:",1,":","anonymous"]');
 const forged=await post(artifact.revision,{url:"/dashboard/shared/one",segmentContext:"forged",reuseSegments:segmentGrant.keys});expect(await forged.text()).toContain("data-shared-root");
 const changed=await post(artifact.revision,{headers:{cookie:"identity=other"},segmentRefs:[{token:segmentGrant.token,keys:segmentGrant.keys}]});const updated=await changed.text();expect(updated).toContain("data-shared-root");expect(updated).toContain('"other"');expect(updated).not.toContain('"anonymous"');
});
test("discarded/replaced layout children remain unrendered and receive no reuse receipt",async()=>{
 for(const replacement of [false,true]) {
 const files=sharedSegmentsWorkspace();
 files.find(file=>file.path==="app/layout.tsx")!.content=replacement
  ? 'import {cloneElement} from "react";export default function Layout({children}){return <html><body>{cloneElement(children,{},<p>replaced child</p>)}</body></html>;}'
  : 'export default function Layout(){return <html><body><p>guarded layout</p></body></html>; }';
 files.find(file=>file.path==="app/dashboard/shared/one/page.tsx")!.content='export default function Page(){throw new Error("discarded child must not execute");}';
 const artifact=await compileNextRequestWorkspace(files,{workspaceKey:"segments-discarded-"+replacement,serverReferenceHashSalt:"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="});
 const warmed=await post(artifact.revision,{prefetch:true,prefetchMode:"auto"});expect(warmed.status).toBe(200);const {ticket,segmentGrant}=await warmed.json();
 expect(segmentGrant.keys).toHaveLength(1);expect(segmentGrant.keys[0]).toContain("app/layout.tsx");
 const original=await post(artifact.revision,{prefetchShell:true,prefetchMode:"auto",prefetchTicket:ticket});expect(await original.text()).toContain(replacement?"replaced child":"guarded layout");
 const next=await post(artifact.revision,{segmentRefs:[{token:segmentGrant.token,keys:segmentGrant.keys}]});const flight=await next.text();
 expect(flight).not.toContain("data-shared-page");expect(flight).not.toMatch(/(?:^|\n)[0-9a-f]+:E\{/);
 }
});
