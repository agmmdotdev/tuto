import type { WorkspaceFile } from "../../../lib/ide/types";

// The same cache functions run through stock Next's production server and both
// Tuto backends. Runtime probes avoid build-time cache/module counter seeding.
export function cacheLifetimeParityWorkspace(): WorkspaceFile[] {
  const source: Record<string, string> = {
    "app/layout.tsx": 'export default function Layout({children}){return <html><body>{children}</body></html>;}',
    "app/page.tsx": 'export default function Page(){return <p>cache lifetime comparison</p>;}',
    "app/cache-data.ts": `import {cacheLife,cacheTag,unstable_cache} from "next/cache";
const counts=new Map();
function count(key){const value=(counts.get(key)??0)+1;counts.set(key,value);return value;}
export function source(id){return {id,value:count("fetch:"+id)};}
export const incremental=unstable_cache(async id=>{await new Promise(resolve=>setTimeout(resolve,60));return {id,value:count("incremental:"+id)};},["parity-incremental"],{revalidate:1,tags:["parity-incremental"]});
export async function component(id,profile="short"){"use cache";
cacheLife(profile==="stale"?{stale:1,revalidate:10,expire:20}:profile==="long"?{stale:30,revalidate:30,expire:60}:{stale:10,revalidate:1,expire:3});
cacheTag("parity-"+id);await new Promise(resolve=>setTimeout(resolve,60));return {id,value:count("component:"+profile+":"+id)};}
export async function inner(id){"use cache";cacheLife({stale:1,revalidate:1,expire:400});cacheTag("parity-inner-"+id);await new Promise(resolve=>setTimeout(resolve,60));return {id,value:count("inner:"+id)};}
export async function inherited(id){"use cache";const data=await inner(id);return {id,value:count("inherited:"+id),inner:data};}
export async function nested(id,shared){"use cache";cacheLife({stale:10,revalidate:1,expire:3});const data=await component(shared,"short");return {id,value:count("nested:"+id),inner:data};}
export async function explicit(id){"use cache";cacheLife({stale:30,revalidate:30,expire:60});const data=await component(id,"short");return {id,value:count("explicit:"+id),inner:data};}
export async function read(kind,id){if(kind==="incremental")return incremental(id);if(kind==="inherited")return inherited(id);if(kind==="explicit")return explicit(id);return component(id,kind==="stale"?"stale":kind==="long"?"long":"short");}`,
    "app/api/probe/route.ts": `import {connection} from "next/server";import {read,nested,component} from "../../cache-data";
export async function GET(request){await connection();const query=new URL(request.url).searchParams,kind=query.get("kind")??"component",id=query.get("id")??"one";
if(kind==="fetch")return Response.json(await(await fetch(query.get("origin")+"/api/source?id="+encodeURIComponent(id),{next:{revalidate:1,tags:["parity-fetch"]}})).json());
if(kind==="partitions"){const tenant=query.get("tenant")??"one";return Response.json(await Promise.all([component(tenant+":a","long"),component(tenant+":a","long"),component(tenant+":b","long")]));}
if(kind==="nested-parallel")return Response.json(await Promise.all([nested(id+":a",id+":shared"),nested(id+":b",id+":shared"),nested(id+":a",id+":shared")]));
return Response.json(await read(kind,id));}`,
    "app/api/source/route.ts": 'import {connection} from "next/server";import {source} from "../../cache-data";export async function GET(request){await connection();return Response.json(source(new URL(request.url).searchParams.get("id")));}',
    "app/show/[kind]/[id]/page.tsx": `import {connection} from "next/server";import {read} from "../../../cache-data";
export default async function Page({params}){await connection();const {kind,id}=await params;return <output data-probe>{JSON.stringify(await read(kind,id))}</output>;}`,
  };
  return Object.entries(source).map(([path, content]) => ({ path, content, language: path.endsWith(".ts") ? "ts" : "tsx" }));
}
