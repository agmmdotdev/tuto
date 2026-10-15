import {afterAll,expect,test} from "vitest";
import {compileNextRequestWorkspace} from "../../lib/serverless-next/compiler";
import {executeNextRequestArtifact} from "../../lib/serverless-next/runtime";
import {buildNextRouteManifest,matchNextRoute,matchNextRouteHandler} from "../../lib/serverless-next/route-manifest";
import {closeNextRscWorkerPoolForTests} from "../../lib/serverless-next/rsc-worker-pool";
import {closeNextSsrWorkerPoolForTests} from "../../lib/serverless-next/ssr-worker-pool";
import {optionalParamsWorkspace} from "./fixtures/optional-params-workspace";
const salt="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const omitted={keys:["tenant"],own:false,value:null,kind:"undefined"};
const present={keys:["parts","tenant"],own:true,value:["a","two words"],kind:"array"};
function output(html:string,attr:string){const text=new RegExp(`<output[^>]*${attr}[^>]*>(.*?)</output>`).exec(html)![1];return JSON.parse(text.replaceAll("&quot;",'"').replaceAll("&#x27;","'").replaceAll("&amp;","&"));}
afterAll(async()=>{await closeNextRscWorkerPoolForTests();await closeNextSsrWorkerPoolForTests();});

test("page and handler matchers omit unmatched optional own keys without changing present values",()=>{
  const manifest=buildNextRouteManifest(optionalParamsWorkspace().map(file=>file.path));
  for(const [match,prefix] of [[matchNextRoute,"/acme/docs"],[matchNextRouteHandler,"/api/acme/docs"]] as const){
    for(const suffix of ["","/"]){const params=match(manifest,new URL(prefix+suffix,"http://next.local"))!.params;expect(Object.keys(params)).toEqual(["tenant"]);expect(Object.hasOwn(params,"parts")).toBe(false);}
    expect(match(manifest,new URL(prefix+"/a/two%20words","http://next.local"))!.params).toEqual({tenant:"acme",parts:["a","two words"]});
  }
});

test("server pages, parallel defaults, and SSR client hooks omit the same optional key and share the explicit-empty cache argument",async()=>{
  const artifact=await compileNextRequestWorkspace(optionalParamsWorkspace(),{workspaceKey:"optional-own-pages",serverReferenceHashSalt:salt});
  for(const [suffix,shape] of [["",omitted],["/a/two%20words",present],["",omitted]] as const){
    const html=await(await executeNextRequestArtifact(artifact,{url:"/acme/docs"+suffix})).text();
    for(const attr of ["data-page-params","data-default-params","data-client-params"])expect(output(html,attr)).toEqual(shape);
    const cache=output(html,"data-cache");expect(cache.actual).toEqual({shape,count:1});expect(cache.omitted).toEqual({shape:omitted,count:1});
  }
});

test("GET/POST handler params share omitted cache keys and tag invalidation stays tenant-scoped",async()=>{
  const artifact=await compileNextRequestWorkspace(optionalParamsWorkspace(),{workspaceKey:"optional-own-handlers",serverReferenceHashSalt:salt});
  async function probe(url:string,method="GET"){const response=await executeNextRequestArtifact(artifact,{url,method});expect(response.status).toBe(200);return response.json();}
  for(const method of ["GET","POST"]){const result=await probe("/api/acme/docs",method);expect(result.params).toEqual(omitted);expect(result.actual).toEqual(result.omitted);expect(result.actual.count).toBe(1);}
  expect((await probe("/api/acme/docs/a/two%20words")).params).toEqual(present);
  expect((await probe("/api/beta/docs")).actual.count).toBe(1);
  expect((await executeNextRequestArtifact(artifact,{url:"/api/invalidate",method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({tenant:"acme"})})).status).toBe(200);
  const fresh=await probe("/api/acme/docs");expect(fresh.actual).toEqual(fresh.omitted);expect(fresh.actual.count).toBe(2);expect((await probe("/api/beta/docs")).actual.count).toBe(1);
});

test("promised client-page props, scalar parameters and required catch-alls preserve their shapes",async()=>{
  const files=optionalParamsWorkspace();
  files.push({path:"app/(workspace)/[tenant]/reexport/[[...parts]]/page.tsx",language:"tsx",content:'export {default} from "../../client/[[...parts]]/page";'});
  const artifact=await compileNextRequestWorkspace(files,{workspaceKey:"optional-own-client-page",serverReferenceHashSalt:salt});
  for(const [url,attr,expected] of [["/acme/client","data-client-page",{...present,value:[""]}],["/acme/reexport","data-client-page",{...present,value:[""]}],["/acme/client/a/two%20words","data-client-page",present],["/acme/required/a/two%20words","data-page-params",present],["/acme/scalar/zero","data-page-params",{...present,value:"zero",kind:"string"}]] as const){
    expect(output(await(await executeNextRequestArtifact(artifact,{url})).text(),attr)).toEqual(expected);
  }
});

test("an omitted prototype-named optional key cannot become an inherited default parameter",async()=>{
  const artifact=await compileNextRequestWorkspace([
    {path:"app/layout.tsx",language:"tsx",content:'export default function Root({children}){return <html><body>{children}</body></html>;}'},
    {path:"app/[[...constructor]]/layout.tsx",language:"tsx",content:'export default function Layout({children,aside}){return <>{children}{aside}</>;}'},
    {path:"app/[[...constructor]]/page.tsx",language:"tsx",content:'export default async function Page({params}){return <output data-page-keys>{JSON.stringify(Object.keys(await params))}</output>;}'},
    {path:"app/[[...constructor]]/@aside/default.tsx",language:"tsx",content:'export default async function Default({params}){return <output data-default-keys>{JSON.stringify(Object.keys(await params))}</output>;}'},
  ],{workspaceKey:"optional-prototype-default",serverReferenceHashSalt:salt});
  const html=await(await executeNextRequestArtifact(artifact,{url:"/"})).text();expect(output(html,"data-page-keys")).toEqual([]);expect(output(html,"data-default-keys")).toEqual([]);
});
