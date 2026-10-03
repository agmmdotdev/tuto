import { revalidationPrefetchWorkspace } from "./revalidation-prefetch-workspace";

export function selectivePrefetchWorkspace() {
  const files = revalidationPrefetchWorkspace();
  const handler = files.find(
    (file) => file.path === "app/api/revalidate/route.ts",
  )!;
  handler.content = handler.content.replace(
    'if(kind==="tag")',
    'if(kind==="unrelated"){revalidateTag("independent",{expire:0});}\nelse if(kind==="first-tag"){revalidateTag("first-tag",{expire:0});}\nelse if(kind==="leaf"){revalidateTag("preview-leaf",{expire:0});}\nelse if(kind==="nested"){revalidateTag("inner-tag",{expire:0});}\nelse if(kind==="plain"){revalidatePath("/plain");}\nelse if(kind==="tag")',
  );
  const additions: Record<string, string> = {
    "app/shared-key-data.ts": `import {unstable_cache} from "next/cache";let reads=0;const shared=async()=>++reads;
export const first=unstable_cache(shared,["same-key"],{tags:["first-tag"]});
export const second=unstable_cache(shared,["same-key"],{tags:["second-tag"]});`,
    "app/first-key/page.tsx": `import {first} from "../shared-key-data";export default async function Page(){return <output data-shared-key>{await first()}</output>;}`,
    "app/second-key/page.tsx": `import {second} from "../shared-key-data";export default async function Page(){return <output data-shared-key>{await second()}</output>;}`,
    "app/independent-data.ts": `import {cacheTag,cacheLife} from "next/cache";
let reads=0;export async function independent(){"use cache";cacheTag("independent");cacheLife({stale:30,revalidate:3600,expire:7200});return ++reads;}
export async function inner(){"use cache";cacheTag("inner-tag");return "inner";}
export async function outer(){"use cache";cacheTag("outer-tag");return "outer:"+await inner();}`,
    "app/independent/page.tsx": `import {independent} from "../independent-data";export default async function Page(){return <output data-independent>{await independent()}</output>;}`,
    "app/nested-cache/page.tsx": `import {outer} from "../independent-data";export default async function Page(){return <output data-nested-cache>{await outer()}</output>;}`,
    "app/also-leaf/page.tsx": `import {leaf} from "../cached-data";export default async function Page(){return <output data-also-leaf>{await leaf()}</output>;}`,
    "app/plain/page.tsx": `export default function Page(){return <p data-plain>uncached</p>;}`,
    "app/slow/page.tsx": `import {leaf} from "../cached-data";export default async function Page(){await new Promise(resolve=>setTimeout(resolve,350));return <output data-slow>{await leaf()}</output>;}`,
  };
  return [
    ...files,
    ...Object.entries(additions).map(([path, content]) => ({
      path,
      content,
      language: "tsx" as const,
    })),
  ];
}
