import {afterAll, expect, test} from "vitest";
import {compileNextRequestWorkspace} from "../../lib/serverless-next/compiler";
import {executeNextRequestArtifact} from "../../lib/serverless-next/runtime";
import {closeNextRscWorkerPoolForTests} from "../../lib/serverless-next/rsc-worker-pool";
import {closeNextSsrWorkerPoolForTests} from "../../lib/serverless-next/ssr-worker-pool";
import {nestedLayoutWorkspace} from "./fixtures/nested-layout-workspace";
const salt="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
function output(html:string,attribute:string,value?:string){const text=new RegExp(`<output[^>]*${attribute}="${value ?? '(?:true|)'}"[^>]*>(.*?)</output>`).exec(html)![1];return JSON.parse(text.replaceAll("&quot;",'"').replaceAll("&#x27;","'").replaceAll("&amp;","&"));}
afterAll(async()=>{await closeNextRscWorkerPoolForTests();await closeNextSsrWorkerPoolForTests();});

test("server/client intermediate layouts and nested slots receive only ancestor and own parameters",async()=>{
  const artifact=await compileNextRequestWorkspace(nestedLayoutWorkspace(),{workspaceKey:"nested-layout-props",serverReferenceHashSalt:salt});
  const html=await(await executeNextRequestArtifact(artifact,{url:"/acme/projects/red/items/one"})).text();
  for(const [level,params] of Object.entries({root:{},org:{org:"acme"},project:{org:"acme",project:"red"},"client-items":{org:"acme",project:"red"},item:{org:"acme",project:"red",id:"one"},audit:{org:"acme",project:"red"},"audit-item":{org:"acme",project:"red",id:"one"}}))expect(output(html,"data-layout",level)).toEqual(params);
  expect(output(html,"data-page")).toEqual({org:"acme",project:"red",id:"one"});
  expect(output(html,"data-audit-page")).toEqual({org:"acme",project:"red",id:"one"});
  expect(output(html,"data-use-params")).toEqual({org:"acme",project:"red",id:"one"});
  const sibling=await(await executeNextRequestArtifact(artifact,{url:"/acme/projects/red/items/two"})).text();
  expect(output(sibling,"data-cache","project")).toEqual({params:{org:"acme",project:"red"},count:1});
  const changed=await(await executeNextRequestArtifact(artifact,{url:"/acme/projects/blue/items/one"})).text();
  expect(output(changed,"data-cache","project")).toEqual({params:{org:"acme",project:"blue"},count:1});
  expect(output(changed,"data-cache","org")).toEqual({params:{org:"acme"},count:1});
});

test("catch-all layout values remain arrays and absent optional parameters have no own key",async()=>{
  const artifact=await compileNextRequestWorkspace(nestedLayoutWorkspace(),{workspaceKey:"nested-layout-arrays",serverReferenceHashSalt:salt});
  const html=await(await executeNextRequestArtifact(artifact,{url:"/acme/archive/red/blue"})).text();
  expect(output(html,"data-layout","archive")).toEqual({org:"acme"});
  expect(output(html,"data-layout","parts")).toEqual({org:"acme",parts:["red","blue"]});
  const empty=await(await executeNextRequestArtifact(artifact,{url:"/acme/optional"})).text();
  expect(output(empty,"data-layout","optional")).toEqual({org:"acme"});
  expect(output(empty,"data-layout-keys")).toEqual(["org"]);
  const present=await(await executeNextRequestArtifact(artifact,{url:"/acme/optional/a/b"})).text();
  expect(output(present,"data-layout","optional")).toEqual({org:"acme",parts:["a","b"]});
});

test("intercepted layouts scope their own branch while the primary layout keeps its background parameters",async()=>{
  const artifact=await compileNextRequestWorkspace(nestedLayoutWorkspace(),{workspaceKey:"nested-layout-intercept",serverReferenceHashSalt:salt});
  const response=await executeNextRequestArtifact(artifact,{url:"/acme/projects/red/photo/seven",headers:{"next-url":"/acme/projects/red/items/one"}});
  const html=await response.text();
  expect(output(html,"data-layout","project")).toEqual({org:"acme",project:"red"});
  expect(output(html,"data-layout","client-items")).toEqual({org:"acme",project:"red"});
  expect(output(html,"data-layout","modal")).toEqual({org:"acme",project:"red",photoId:"seven"});
  expect(output(html,"data-page")).toEqual({org:"acme",project:"red",id:"one"});
  const canonical=await(await executeNextRequestArtifact(artifact,{url:"/acme/projects/red/photo/seven"})).text();
  expect(output(canonical,"data-canonical-page")).toEqual({org:"acme",project:"red",photoId:"seven"});
});

test("loading shells keep scoped layout props and tag refresh changes only the applicable data partition",async()=>{
  const artifact=await compileNextRequestWorkspace(nestedLayoutWorkspace(),{workspaceKey:"nested-layout-shell",serverReferenceHashSalt:salt});
  const url="/acme/projects/red/items/one";
  const before=await(await executeNextRequestArtifact(artifact,{url})).text();
  const shell=await(await executeNextRequestArtifact(artifact,{url,loading:true})).text();
  expect(output(shell,"data-layout","org")).toEqual({org:"acme"});
  expect(output(shell,"data-layout","project")).toEqual({org:"acme",project:"red"});
  expect(shell.includes("project loading")).toBe(true);
  expect(shell.includes("data-page=")).toBe(false);
  const changed=await executeNextRequestArtifact(artifact,{url:"/api/invalidate",method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({level:"project"})});expect(changed.status).toBe(200);
  const after=await(await executeNextRequestArtifact(artifact,{url})).text();
  expect(output(after,"data-cache","project").count).toBe(output(before,"data-cache","project").count+1);
  expect(output(after,"data-cache","org")).toEqual(output(before,"data-cache","org"));
});

test("marked dynamic layouts and up-level interception retain owner params without leaking primary leaf params",async()=>{
  const files=nestedLayoutWorkspace();
  files.push({path:"app/[org]/missing/[id]/page.tsx",language:"tsx",content:'import {notFound} from "next/navigation";export default function Page(){notFound();}'});
  const artifact=await compileNextRequestWorkspace(files,{workspaceKey:"nested-layout-markers",serverReferenceHashSalt:salt});
  const headers={"next-url":"/acme/projects/red/items/one"};
  for(const [url,level,params] of [
    ["/acme/projects/red/seven","dynamic-modal",{org:"acme",project:"red",token:"seven"}],
    ["/acme/projects/other/seven/view","up-modal",{org:"acme",project:"red",otherId:"seven"}],
  ] as const){
    const html=await(await executeNextRequestArtifact(artifact,{url,headers})).text();
    expect(output(html,"data-layout",level)).toEqual(params);
    expect(output(html,"data-layout","project")).toEqual({org:"acme",project:"red"});
    expect(output(html,"data-page")).toEqual({org:"acme",project:"red",id:"one"});
  }
  const missing=await executeNextRequestArtifact(artifact,{url:"/acme/missing/one"});
  expect(missing.status).toBe(404);
  expect(output(await missing.text(),"data-layout","root")).toEqual({});
});
