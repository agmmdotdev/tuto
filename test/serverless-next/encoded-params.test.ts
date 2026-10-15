import {afterAll,expect,test} from "vitest";
import {compileNextRequestWorkspace} from "../../lib/serverless-next/compiler";
import {executeNextRequestArtifact} from "../../lib/serverless-next/runtime";
import {closeNextRscWorkerPoolForTests} from "../../lib/serverless-next/rsc-worker-pool";
import {closeNextSsrWorkerPoolForTests} from "../../lib/serverless-next/ssr-worker-pool";
import {encodedCases,encodedParamsWorkspace} from "./fixtures/encoded-params-workspace";
const salt="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
function output(html:string,attr:string){const text=new RegExp(`<output[^>]*${attr}[^>]*>(.*?)</output>`).exec(html)![1];return JSON.parse(text.replaceAll("&quot;",'"').replaceAll("&#x27;","'").replaceAll("&amp;","&"));}
afterAll(async()=>{await closeNextRscWorkerPoolForTests();await closeNextSsrWorkerPoolForTests();});
test("component/root/default/hook values are canonical encoded segments while handlers decode once",async()=>{
  const artifact=await compileNextRequestWorkspace(encodedParamsWorkspace(),{workspaceKey:"encoded-projections",serverReferenceHashSalt:salt});
  for(const item of encodedCases){
    const html=await(await executeNextRequestArtifact(artifact,{url:"/caf%c3%a9/docs/"+item.input})).text();
    const expected={tenant:"caf%C3%A9",parts:[item.rendered]};
    for(const attr of ["data-all-page","data-all-default","data-all-client","data-nested-layout"])expect(output(html,attr)).toEqual(expected);
    expect(output(html,"data-root-layout")).toEqual({tenant:"caf%C3%A9"});
    expect(html.includes('data-root-value="true">caf%C3%A9')).toBe(true);
    const handler=await(await executeNextRequestArtifact(artifact,{url:"/api/caf%c3%a9/docs/"+item.input})).json();
    expect(handler.params.value).toEqual([item.decoded]);
    const client=await(await executeNextRequestArtifact(artifact,{url:"/acme/client/"+item.input})).text();
    expect(output(client,"data-all-client-page")).toEqual({tenant:"acme",parts:[item.rendered]});
  }
});
test("canonical aliases share page cache entries while encoded separators and repeated encoding remain distinct",async()=>{
  const artifact=await compileNextRequestWorkspace(encodedParamsWorkspace(),{workspaceKey:"encoded-cache-keys",serverReferenceHashSalt:salt});
  async function read(path:string){return output(await(await executeNextRequestArtifact(artifact,{url:path})).text(),"data-cache");}
  const lower=await read("/acme/docs/a%2fb"),upper=await read("/acme/docs/a%2Fb");expect(upper).toEqual(lower);expect(lower.count).toBe(1);
  expect((await read("/acme/docs/a/b")).shape.value).toEqual(["a","b"]);
  expect((await read("/acme/docs/a%252Fb")).shape.value).toEqual(["a%252Fb"]);
  expect((await read("/acme/docs/%41")).shape.value).toEqual(["A"]);expect((await read("/acme/docs/A")).count).toBe(1);
});
test("metadata receives decoded matcher inputs exactly once and malformed inputs reject without poisoning the worker",async()=>{
  const artifact=await compileNextRequestWorkspace(encodedParamsWorkspace(),{workspaceKey:"encoded-metadata-errors",serverReferenceHashSalt:salt});
  for(const item of encodedCases){
    const html=await(await executeNextRequestArtifact(artifact,{url:"/acme/scalar/"+item.input})).text();
    expect(output(html,"data-all-page")).toEqual({tenant:"acme",parts:item.rendered});
    const title=/<title>(.*?)<\/title>/.exec(html)![1].replaceAll("&quot;",'"').replaceAll("&#x27;","'").replaceAll("&amp;","&");expect(JSON.parse(title)).toEqual({tenant:"acme",parts:item.decoded});
  }
  for(const bad of ["%ZZ","%E0%A4%A"]){for(const prefix of ["/acme/docs/","/api/acme/docs/"])await expect(executeNextRequestArtifact(artifact,{url:prefix+bad})).rejects.toThrow(/URI|decode/i);}
  expect((await executeNextRequestArtifact(artifact,{url:"/acme/docs/valid"})).status).toBe(200);
});
