import { sharedSegmentsWorkspace } from "./shared-segments-workspace";

export function revalidationPrefetchWorkspace() {
  const files = sharedSegmentsWorkspace();
  const root = files.find(file => file.path === "app/layout.tsx")!;
  root.content = 'import RevalidationControls from "./revalidation-controls";\n' + root.content.replace('<Counter name="root" />', '<Counter name="root" /><RevalidationControls />');
  const additions: Record<string, string> = {
    "app/revalidation-controls.tsx": `"use client";import {useState} from "react";import {useRouter} from "next/navigation";
export default function Controls(){const router=useRouter();const [status,setStatus]=useState("idle"),[invalidations,setInvalidations]=useState(0);
return <><button data-prefetch onClick={()=>{setStatus("pending");Promise.resolve(router.prefetch("/dashboard/prefetched",{onInvalidate:()=>setInvalidations(value=>value+1)})).then(()=>setStatus("done"));}}>prefetch</button>
<button data-prefetch-go onClick={()=>router.push("/dashboard/prefetched")}>go prefetched</button><output data-prefetch-status>{status}</output><output data-invalidations>{invalidations}</output></>;}`,
    "app/cached-data.ts": `import {unstable_cache} from "next/cache";
let leafReads=0,layoutReads=0;
export const leaf=unstable_cache(async()=>++leafReads,["preview-leaf"],{revalidate:3600,tags:["preview-leaf"]});
export const layout=unstable_cache(async()=>++layoutReads,["preview-layout"],{revalidate:3600,tags:["preview-layout"]});`,
    "app/dashboard/prefetched/page.tsx": `import {leaf} from "../../cached-data";import Counter from "../../counter";
export default async function Page(){return <><output data-tagged-leaf>{await leaf()}</output><Counter name="prefetched" /></>;}`,
    "app/dashboard/shared/layout.tsx": `import {layout} from "../../cached-data";import Counter from "../../counter";
export default async function Layout({children}){return <section><output data-tagged-layout>{await layout()}</output><Counter name="shared-layout" />{children}</section>;}`,
    "app/dashboard/shared/[id]/page.tsx": `import {leaf} from "../../../cached-data";
export default async function Page({params}){await new Promise(resolve=>setTimeout(resolve,100));return <output data-tagged-dynamic>{(await params).id}:{await leaf()}</output>;}`,
    "app/api/revalidate/route.ts": `import {revalidatePath,revalidateTag} from "next/cache";
export async function POST(request){const {kind}=await request.json();
if(kind==="tag"){revalidateTag("preview-leaf",{expire:0});revalidateTag("preview-layout",{expire:0});}
else if(kind==="max"){revalidateTag("preview-leaf","max");}
else if(kind==="page"){revalidatePath("/dashboard/prefetched");}
else if(kind==="layout"){revalidatePath("/dashboard/shared","layout");}
else if(kind==="dynamic"){revalidatePath("/dashboard/shared/[id]","page");}
else return Response.json({error:"unknown mutation"},{status:400});
return Response.json({kind});}`,
  };
  return [...files.filter(file => !Object.hasOwn(additions, file.path)),
    ...Object.entries(additions).map(([path, content]) => ({ path, content, language: "tsx" as const }))];
}
