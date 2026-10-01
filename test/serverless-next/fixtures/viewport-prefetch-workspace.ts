import {linkPrefetchWorkspace} from "./link-prefetch-workspace";
export function viewportPrefetchWorkspace(){
 const files=linkPrefetchWorkspace();
 const controls=files.find(file=>file.path==="app/controls.tsx")!;
 // Keep controls above the distant Link so clicking refresh does not also scroll
 // a second eligible destination into view.
 controls.content=controls.content.replace("<IntentLinks />", "").replace("</nav>", "<IntentLinks /></nav>");
 files.find(file=>file.path==="app/intent-links.tsx")!.content=`"use client";
import Link from "next/link"; import {useState} from "react";
export default function Links(){const [show,setShow]=useState(true);const [intent,setIntent]=useState(false);const [href,setHref]=useState("/dashboard/intent-one");return <>
{show&&<Link data-viewport="visible" href={href}>visible</Link>}
<Link data-viewport="disabled" href="/dashboard/intent-two" prefetch={false}>disabled</Link>
<Link data-viewport="priority" href="/dashboard/intent-two" prefetch={intent?true:false}>priority</Link>
<button data-enable-intent onClick={()=>setIntent(true)}>enable intent</button>
<button data-retarget-viewport onClick={()=>setHref("/dashboard/prefetched")}>retarget</button>
<button data-remove-viewport onClick={()=>setShow(false)}>remove</button>
<div style={{height:2200}} />
<Link data-viewport="offscreen" href="/dashboard/intent-two">offscreen</Link>
</>;}`;
 return files;
}
