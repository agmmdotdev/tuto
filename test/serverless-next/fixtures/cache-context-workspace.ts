import type { WorkspaceFile } from "../../../lib/ide/types";

export function cacheContextWorkspace(): WorkspaceFile[] {
  const files: Record<string, string> = {
    "app/layout.tsx": `import {Suspense} from "react";import Controls from "./controls";
export default function Layout({children}){return <html><body><Controls /><Suspense fallback={<p data-loading>loading</p>}>{children}</Suspense></body></html>;}`,
    "app/controls.tsx": `"use client";import {useState} from "react";import {useRouter} from "next/navigation";
export default function Controls(){const [count,setCount]=useState(0),router=useRouter();return <><button data-root-count onClick={()=>setCount(value=>value+1)}>root:{count}</button><button data-go onClick={()=>router.push("/cards")}>cards</button><button data-refresh onClick={()=>router.refresh()}>refresh</button></>;}`,
    "app/counter.tsx": `"use client";import {useState} from "react";
export default function Counter({id}){const [count,setCount]=useState(0);return <button data-card-count={id} onClick={()=>setCount(value=>value+1)}>{id}:{count}</button>;}`,
    "app/page.tsx": `export default function Page(){return <p data-home>home</p>;}`,
    "app/data.ts": `import {cacheLife,cacheTag} from "next/cache";
const reads=new Map();
export async function readCard(id,tenant){"use cache";cacheLife("hours");await new Promise(resolve=>setTimeout(resolve,15));cacheTag("nested-"+id);const key=id+":"+tenant,value=(reads.get(key)??0)+1;reads.set(key,value);return value;}`,
    "app/card.tsx": `import {cacheLife,cacheTag} from "next/cache";import {readCard} from "./data";import Counter from "./counter";
export default async function Card({id,tenant}){"use cache";cacheLife("hours");await new Promise(resolve=>setTimeout(resolve,id==="a"?25:40));cacheTag("nested-"+id);const value=await readCard(id,tenant);return <section><output data-card={id}>{id+":"+tenant+":"+value}</output><Counter id={id} /></section>;}`,
    "app/cards/page.tsx": `import {Suspense} from "react";import {headers,cookies} from "next/headers";import Card from "../card";
async function RequestTail(){await new Promise(resolve=>setTimeout(resolve,10));return <output data-session>{(await cookies()).get("session")?.value??"none"}</output>;}
export default async function Page(){await new Promise(resolve=>setTimeout(resolve,5));const tenant=(await headers()).get("x-tenant")??"public";return <><Suspense fallback={<p>card a loading</p>}><Card id="a" tenant={tenant} /></Suspense><Suspense fallback={<p>card b loading</p>}><Card id="b" tenant={tenant} /></Suspense><Suspense fallback={<p>session loading</p>}><RequestTail /></Suspense></>;}`,
    "app/api/revalidate/route.ts": `import {revalidateTag} from "next/cache";
export async function POST(request){const {id}=await request.json();revalidateTag("nested-"+id,{expire:0});return Response.json({id});}`,
    "app/api/unsafe/route.ts": `import {cookies} from "next/headers";import {cacheLife} from "next/cache";import {connection} from "next/server";
async function Secret(kind){"use cache";cacheLife("hours");
if(kind==="then")return new Promise(resolve=>setTimeout(resolve,10)).then(()=>cookies()).then(jar=>jar.get("session")?.value);
if(kind==="timer")return new Promise((resolve,reject)=>setTimeout(()=>{try{cookies().then(jar=>resolve(jar.get("session")?.value),reject);}catch(error){reject(error);}},10));
await new Promise(resolve=>setTimeout(resolve,10));return (await cookies()).get("session")?.value;}
export async function GET(request){await connection();try{return Response.json({value:await Secret(new URL(request.url).searchParams.get("kind"))});}catch(error){return Response.json({blocked:true,message:error.message},{status:400});}}`,
  };
  return Object.entries(files).map(([path, content]) => ({
    path,
    content,
    language: path.endsWith(".ts") ? "ts" : "tsx",
  }));
}
