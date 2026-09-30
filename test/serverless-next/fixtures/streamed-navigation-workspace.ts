import type { WorkspaceFile } from "../../../lib/ide/types";
import { persistentNavigationWorkspace } from "./persistent-navigation-workspace";

export function streamedNavigationWorkspace(): WorkspaceFile[] {
  const additions: Record<string, string> = {
    "app/dashboard/slow/loading.tsx": `export default function Loading() { return <p data-primary-loading>loading primary</p>; }`,
    "app/dashboard/slow/page.tsx": `import {Suspense} from "react"; import Counter from "../../counter";
async function Details() { await new Promise(resolve => setTimeout(resolve, 1300)); return <p data-stream-details>stream details</p>; }
export default async function Page() {
  await new Promise(resolve => setTimeout(resolve, 600));
  return <><Counter name="slow" /><Suspense fallback={<p data-details-loading>loading details</p>}><Details /></Suspense></>;
}`,
    "app/dashboard/@team/slow/loading.tsx": `export default function Loading() { return <p data-team-loading>loading team</p>; }`,
    "app/dashboard/@team/slow/page.tsx": `import Counter from "../../../counter"; export default async function Page() { await new Promise(resolve => setTimeout(resolve, 2200)); return <Counter name="team-slow" />; }`,
    "app/dashboard/@team/@detail/slow/loading.tsx": `export default function Loading() { return <p data-detail-loading>loading detail</p>; }`,
    "app/dashboard/@team/@detail/slow/page.tsx": `import Counter from "../../../../counter"; export default async function Page() { await new Promise(resolve => setTimeout(resolve, 2400)); return <Counter name="detail-slow" />; }`,
    "app/dashboard/stream-error/loading.tsx": `export default function Loading() { return <p data-error-loading>loading error</p>; }`,
    "app/dashboard/stream-error/error.tsx": `"use client"; export default function Error({reset}) { return <button data-stream-error onClick={reset}>retry stream</button>; }`,
    "app/dashboard/stream-error/page.tsx": `export default async function Page() { await new Promise(resolve => setTimeout(resolve, 500)); throw new Error("stream failure"); }`,
    "app/dashboard/stream-missing/loading.tsx": `export default function Loading() { return <p data-missing-loading>loading missing</p>; }`,
    "app/dashboard/stream-missing/not-found.tsx": `export default function NotFound() { return <p data-stream-not-found>stream missing</p>; }`,
    "app/dashboard/stream-missing/page.tsx": `import {notFound} from "next/navigation"; export default async function Page() { await new Promise(resolve => setTimeout(resolve, 500)); notFound(); }`,
    "app/dashboard/stream-redirect/loading.tsx": `export default function Loading() { return <p data-redirect-loading>loading redirect</p>; }`,
    "app/dashboard/stream-redirect/page.tsx": `import {redirect} from "next/navigation"; export default async function Page() { await new Promise(resolve => setTimeout(resolve, 500)); redirect("/dashboard/settings?redirected=yes"); }`,
  };
  const controls = persistentNavigationWorkspace().find(file => file.path === "app/controls.tsx")!;
  additions[controls.path] = controls.content.replace("<button data-refresh", ["stream-error", "stream-missing", "stream-redirect"].map(name => `<Link data-go="${name}" href="/dashboard/${name}">${name}</Link>`).join("\n") + "<button data-refresh");
  return [
    ...persistentNavigationWorkspace().filter(file => !Object.hasOwn(additions, file.path)),
    ...Object.entries(additions).map(([path, content]) => ({path,content,language:"tsx" as const})),
  ];
}
