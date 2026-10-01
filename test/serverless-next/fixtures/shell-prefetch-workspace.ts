import type {WorkspaceFile} from "../../../lib/ide/types";
import {streamedNavigationWorkspace} from "./streamed-navigation-workspace";

export function shellPrefetchWorkspace(): WorkspaceFile[] {
 const files=streamedNavigationWorkspace();
 const controls=files.find(file=>file.path==="app/controls.tsx")!;
 controls.content=controls.content.replace(/<Link (?![^>]*prefetch=)/g,"<Link prefetch={false} ")
   .replace('import Link','import ShellLinks from "./shell-links";\nimport Link')
   .replace('<button data-refresh','<ShellLinks /><button data-refresh');
 const additions:Record<string,string>={
  "app/shell-links.tsx":`"use client"; import {useState} from "react"; import Link from "next/link"; import {change} from "./actions";
export default function Links(){const [href,setHref]=useState("/dashboard/shell");const [status,setStatus]=useState("idle");const [full,setFull]=useState(false);return <nav>
<Link data-shell-link="auto" href={href}>auto shell</Link>{full&&<Link data-shell-link="full" prefetch={true} href={href}>full shell</Link>}
<button data-shell-enable-full onClick={()=>setFull(true)}>enable full</button>
<input data-shell-target value={href} onChange={event=>setHref(event.target.value)} />
<Link data-shell-link="intercepted" href="/photo/7">intercept</Link>
<button data-shell-action onClick={async()=>setStatus(await change())}>change identity</button><output data-shell-action-status>{status}</output></nav>;}`,
  "app/actions.ts":`"use server"; import {cookies} from "next/headers"; import {revalidatePath} from "next/cache";
export async function change(){(await cookies()).set("identity","signed-in");revalidatePath("/dashboard/shell");return "changed";}`,
  "app/dashboard/shell/loading.tsx":`export default function Loading(){return <p data-shell-loading>shell loading</p>;}`,
  "app/dashboard/shell/page.tsx":`import {headers,cookies} from "next/headers"; import {Suspense} from "react"; import Counter from "../../counter";
async function Details(){await new Promise(resolve=>setTimeout(resolve,750));return <p data-shell-details>fresh details</p>;}
export default async function Page(){const h=await headers();const jar=await cookies();await new Promise(resolve=>setTimeout(resolve,250));
return <><output data-shell-time>{Date.now()}</output><output data-shell-fresh>{h.get("x-fresh")??"fresh"}:{jar.get("identity")?.value??"anonymous"}</output><Counter name="shell" /><Suspense fallback={<p data-shell-details-loading>details loading</p>}><Details /></Suspense></>;}`,
  "app/dashboard/shell/nested/loading.tsx":`export default function Loading(){return <p data-inner-shell-loading>inner loading</p>;}`,
  "app/dashboard/shell/nested/page.tsx":`throw new Error("Nested page must not be evaluated while prefetching its outer shell"); export default function Page(){return <p>unreachable</p>;}`,
  "app/@modal/(.)photo/[id]/loading.tsx":`export default function Loading(){return <p data-modal-shell-loading>modal loading</p>;}`,
  "app/@modal/(.)photo/[id]/page.tsx":`import Counter from "../../../counter"; export default async function Page({params}){await new Promise(resolve=>setTimeout(resolve,250));return <dialog open data-modal><p>modal:{(await params).id}</p><Counter name="modal" /></dialog>;}`,
 };
 return [...files.filter(file=>!Object.hasOwn(additions,file.path)),...Object.entries(additions).map(([path,content])=>({path,content,language:"tsx" as const}))];
}
