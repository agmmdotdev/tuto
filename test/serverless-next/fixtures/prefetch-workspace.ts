import type { WorkspaceFile } from "../../../lib/ide/types";
import { persistentNavigationWorkspace } from "./persistent-navigation-workspace";

export function prefetchWorkspace(): WorkspaceFile[] {
  const files = persistentNavigationWorkspace();
  const controls = files.find(file => file.path === "app/controls.tsx")!;
  const additions: Record<string,string> = {
    "app/dashboard/data.ts": `let reads = 0; let version = 0;
export function read() { return ++reads; }
export function snapshot() { return {reads:++reads,version}; }
export function mutate() { version++; }`,
    "app/actions.ts": `"use server";
import {cookies} from "next/headers"; import {revalidatePath} from "next/cache"; import {mutate} from "./dashboard/data";
export async function change() { await new Promise(resolve => setTimeout(resolve,100)); mutate(); (await cookies()).set("identity","signed-in"); revalidatePath("/dashboard/prefetched"); return "changed"; }`,
    "app/dashboard/prefetched/page.tsx": `import {cookies,headers} from "next/headers"; import {snapshot} from "../data"; import Counter from "../../counter";
export default async function Page() { const data=snapshot(); const jar=await cookies(); const requestHeaders=await headers();
return <><output data-prefetched>{JSON.stringify({...data,identity:jar.get("identity")?.value ?? "anonymous",tenant:requestHeaders.get("x-tenant") ?? "none"})}</output><Counter name="prefetched" /></>; }`,
    "app/api/effect/route.ts": `let calls=0; export function GET(){return Response.json({calls:++calls});}`,
  };
  additions[controls.path] = controls.content
    .replace('import Link', 'import {useState} from "react"; import {change} from "./actions";\nimport Link')
    .replace('  const router = useRouter();','  const router = useRouter();\n  const [href,setHref]=useState("/dashboard/prefetched"); const [status,setStatus]=useState("idle"); const [invalidations,setInvalidations]=useState(0);')
    .replace('<button data-refresh', `<input data-prefetch-href value={href} onChange={event=>setHref(event.target.value)} />
<button data-prefetch onClick={()=>{setStatus("pending"); Promise.resolve(router.prefetch(href,{onInvalidate:()=>setInvalidations(value=>value+1)})).then(()=>setStatus("done"));}}>prefetch</button>
<button data-prefetch-go onClick={()=>router.push(href)}>go prefetched</button>
<button data-mutate onClick={async()=>{setStatus(await change());}}>mutate</button>
<output data-prefetch-status>{status}</output><output data-invalidations>{invalidations}</output>
<button data-refresh`);
  return [...files.filter(file => !Object.hasOwn(additions,file.path)),
    ...Object.entries(additions).map(([path,content])=>({path,content,language:"tsx" as const}))];
}
