import {shellPrefetchWorkspace} from "./shell-prefetch-workspace";
export function sharedSegmentsWorkspace(){
 const files=shellPrefetchWorkspace();
 const root=files.find(file=>file.path==="app/layout.tsx")!;
 root.content='import {probe} from "./shared-probe";\n'+root.content.replace('<Counter name="root" />','<output data-shared-root>{probe("root")}</output><Counter name="root" />');
 const additions:Record<string,string>={
  "app/shared-probe.ts":`const calls={};export function probe(name){return calls[name]=(calls[name]??0)+1;}`,
  "app/shell-links.tsx":`"use client";import Link from "next/link";import {useState} from "react";import {change} from "./actions";
export default function Links(){const [href,setHref]=useState("/dashboard/shared/one");const [status,setStatus]=useState("idle");return <>
<input data-shell-target value={href} onChange={event=>setHref(event.target.value)} />
<Link data-shell-link="auto" href={href}>shared shell</Link>
<button data-shell-action onClick={async()=>setStatus(await change())}>change identity</button><output data-shell-action-status>{status}</output>
</>;}`,
  "app/dashboard/shared/layout.tsx":`import {cookies} from "next/headers";import Counter from "../../counter";import {probe} from "../../shared-probe";
export default async function Layout({children,params}){const jar=await cookies();return <section><output data-shared-param>{(await params).id??"none"}</output><output data-shared-layout>{probe("layout")}:{jar.get("identity")?.value??"anonymous"}</output><Counter name="shared-layout" />{children}</section>;}`,
  "app/dashboard/shared/loading.tsx":`import {probe} from "../../shared-probe";export default function Loading(){return <p data-shared-loading>loading:{probe("loading")}</p>;}`,
 };
 for(const name of ["one","two"]){
  additions[`app/dashboard/shared/${name}/page.tsx`]=`import {cookies} from "next/headers";import Counter from "../../../counter";import {probe} from "../../../shared-probe";
export default async function Page(){const jar=await cookies();await new Promise(resolve=>setTimeout(resolve,200));return <><output data-shared-page>${name}:{probe("${name}")}:{jar.get("identity")?.value??"anonymous"}</output><Counter name="${name}" /></>;}`;
  additions[`app/dashboard/@team/shared/${name}/page.tsx`]=`import Counter from "../../../../counter";export default function Page(){return <Counter name="team-${name}" />;}`;
  additions[`app/dashboard/@team/@detail/shared/${name}/page.tsx`]=`import Counter from "../../../../../counter";export default function Page(){return <Counter name="detail-${name}" />;}`;
 }
 additions["app/dashboard/shared/[id]/page.tsx"]=`import {cookies} from "next/headers";export default async function Page({params}){await new Promise(resolve=>setTimeout(resolve,200));return <output data-shared-page>{(await params).id}:{(await cookies()).get("identity")?.value??"anonymous"}</output>;}`;
 return [...files.filter(file=>!Object.hasOwn(additions,file.path)),...Object.entries(additions).map(([path,content])=>({path,content,language:"tsx" as const}))];
}
