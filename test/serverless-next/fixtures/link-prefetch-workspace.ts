import type { WorkspaceFile } from "../../../lib/ide/types";
import { prefetchWorkspace } from "./prefetch-workspace";

export function linkPrefetchWorkspace(): WorkspaceFile[] {
  const files = prefetchWorkspace();
  const controls = files.find(file => file.path === "app/controls.tsx")!;
  controls.content = controls.content.replace(/<Link (?![^>]*prefetch=)/g, "<Link prefetch={false} ")
    .replace('<input data-prefetch-href', '<IntentLinks /><input data-prefetch-href')
    .replace('import Link', 'import IntentLinks from "./intent-links";\nimport Link');
  return [...files, {
    path: "app/intent-links.tsx", language: "tsx", content: `"use client";
import {useState,useRef} from "react"; import Link from "next/link";
export default function IntentLinks(){
 const [disabled,setDisabled]=useState(false); const [href,setHref]=useState("/dashboard/intent-one");
 const [events,setEvents]=useState(0); const ref=useRef(null);
 const handler=()=>setEvents(value=>value+1);
 return <nav>
 <Link data-intent="default" href="/dashboard/intent-one" onMouseEnter={handler} onTouchStart={handler} ref={ref}>default</Link>
 <Link data-intent="true" href="/dashboard/intent-one" prefetch={true}>true</Link>
 <Link data-intent="auto" href="/dashboard/intent-one" prefetch="auto">auto</Link>
 <Link data-intent="null" href="/dashboard/intent-one" prefetch={null}>null</Link>
 <Link data-intent="false" href="/dashboard/intent-two" prefetch={false} onMouseEnter={handler} onTouchStart={handler}>disabled</Link>
 <Link data-intent="dynamic" href={href} prefetch={disabled?false:true}>dynamic</Link>
 <Link data-intent="external" href="https://example.com/">external</Link>
 <Link data-intent="target" href="/dashboard/intent-two" target="_blank">target</Link>
 <Link data-intent="download" href="/dashboard/intent-two" download>download</Link>
 <Link data-intent="hash" href="#bottom">hash</Link>
 <Link data-intent="blocked" href="/dashboard/intent-two" prefetch={false} onClick={event=>event.preventDefault()}>blocked</Link>
 <Link data-intent="replace" href="/dashboard/intent-one" prefetch={false} replace scroll={false}>replace</Link>
 <button data-toggle-intent onClick={()=>setDisabled(value=>!value)}>toggle</button>
 <button data-retarget-intent onClick={()=>setHref("/dashboard/intent-two")}>retarget</button>
 <button data-inspect-ref onClick={()=>setEvents(ref.current?.getAttribute("data-intent")==="default"?100:-100)}>inspect</button>
 <output data-intent-events>{events}</output>
 </nav>;
}`,
  }, ...["one", "two"].map(name => ({
    path: `app/dashboard/intent-${name}/page.tsx`, language: "tsx" as const,
    content: `import {headers} from "next/headers"; import Counter from "../../counter";
export default async function Page(){await headers();return <><output data-intent-page>${name}</output><Counter name="intent-${name}" /></>;}`,
  }))];
}
