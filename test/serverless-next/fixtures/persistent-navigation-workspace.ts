import type { WorkspaceFile } from "../../../lib/ide/types";

export function persistentNavigationWorkspace(): WorkspaceFile[] {
  const source: Record<string, string> = {
    "app/layout.tsx": `import Controls from "./controls";
import Counter from "./counter";
export default function Layout({ children, modal }) {
  return <html><body><Counter name="root" /><Controls />{children}{modal}<div style={{height: "1800px"}} /><p id="bottom">bottom</p></body></html>;
}`,
    "app/controls.tsx": `"use client";
import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
export default function Controls() {
  const router = useRouter();
  return <nav><output data-path>{usePathname()}?{useSearchParams().toString()}</output>
    <Link prefetch={false} data-go="home" href="/dashboard">home</Link>
    <Link prefetch={false} data-go="settings" href="/dashboard/settings?tab=team">settings</Link>
    <Link prefetch={false} data-go="team-only" href="/dashboard/team">team only</Link>
    <Link prefetch={false} data-go="views" href="/dashboard/views">views</Link>
    <Link prefetch={false} data-go="broken" href="/dashboard/broken">broken</Link>
    <Link prefetch={false} data-go="missing" href="/dashboard/missing">missing</Link>
    <Link prefetch={false} data-go="photo" href="/photo/7">photo</Link>
    <Link prefetch={false} data-go="slow" href="/dashboard/slow">slow</Link>
    <Link prefetch={false} data-go="bottom" href="#bottom">bottom</Link>
    <button data-refresh onClick={() => router.refresh()}>refresh</button>
    <button data-back onClick={() => router.back()}>back</button>
    <button data-forward onClick={() => router.forward()}>forward</button>
    <button data-replace onClick={() => router.replace("/dashboard/views?replaced=yes", {scroll:false})}>replace</button>
  </nav>;
}`,
    "app/counter.tsx": `"use client";
import { useState } from "react";
export default function Counter({ name }) {
  const [count, setCount] = useState(0);
  return <section><button data-counter={name} onClick={() => setCount(count + 1)}>{name}:{count}</button><input data-input={name} defaultValue="" /></section>;
}`,
    "app/dashboard/layout.tsx": `import Counter from "../counter";
import Selection from "./selection";
import {read} from "./data";
export default function Layout({ children, team, analytics }) {
  return <main><Counter name="dashboard" /><Selection /><output data-layout-server>{read()}</output><section data-primary>{children}</section><aside data-team>{team}</aside><aside data-analytics>{analytics}</aside></main>;
}`,
    "app/dashboard/selection.tsx": `"use client";
import { useParams, useSelectedLayoutSegments, useSelectedLayoutSegment } from "next/navigation";
export default function Selection() {
  return <output data-selection>{JSON.stringify({params:useParams(), children:useSelectedLayoutSegments(), team:useSelectedLayoutSegment("team"), analytics:useSelectedLayoutSegments("analytics")})}</output>;
}`,
    "app/dashboard/data.ts": `let reads = 0; export function read() { return ++reads; }`,
    "app/dashboard/page.tsx": `import Counter from "../counter"; import {read} from "./data";
export default function Page() { return <><p data-server>home:{read()}</p><Counter name="home" /></>; }`,
    "app/dashboard/default.tsx": `export default function Default() { return <p data-children-default>children default</p>; }`,
    "app/dashboard/@team/team/page.tsx": `import Counter from "../../../counter"; export default function Page() { return <Counter name="team-only" />; }`,
    "app/dashboard/settings/page.tsx": `import Counter from "../../counter"; import styles from "./settings.module.css"; export default function Page() { return <div className={styles.settings}><Counter name="settings" /></div>; }`,
    "app/dashboard/settings/settings.module.css": `.settings button { color: rgb(102, 51, 153); }`,
    "app/dashboard/views/page.tsx": `import Counter from "../../counter"; export default function Page() { return <Counter name="views" />; }`,
    "app/dashboard/broken/page.tsx": `export default function Page() { return <p>main broken</p>; }`,
    "app/dashboard/missing/page.tsx": `export default function Page() { return <p>main missing</p>; }`,
    "app/dashboard/slow/page.tsx": `export default async function Page() { await new Promise(resolve => setTimeout(resolve, 300)); return <p data-slow>slow</p>; }`,
    "app/dashboard/@team/layout.tsx": `import Counter from "../../counter";
export default function Layout({ children, detail }) { return <section><Counter name="team-layout" />{children}<div data-detail>{detail}</div></section>; }`,
    "app/dashboard/@team/page.tsx": `import Counter from "../../counter"; export default function Page() { return <Counter name="team-home" />; }`,
    "app/dashboard/@team/settings/page.tsx": `import Counter from "../../../counter"; export default function Page() { return <Counter name="team-settings" />; }`,
    "app/dashboard/@team/default.tsx": `export default function Default() { return <p data-team-default>team default</p>; }`,
    "app/dashboard/@team/@detail/page.tsx": `import Counter from "../../../counter"; export default function Page() { return <Counter name="detail-home" />; }`,
    "app/dashboard/@team/@detail/settings/page.tsx": `import Counter from "../../../../counter"; export default function Page() { return <Counter name="detail-settings" />; }`,
    "app/dashboard/@team/@detail/default.tsx": `export default function Default() { return <p>detail default</p>; }`,
    "app/dashboard/@team/error.tsx": `"use client"; import {useRouter} from "next/navigation"; export default function Error({reset}) { const router = useRouter(); return <button data-team-error onClick={() => {router.refresh();reset();}}>retry team</button>; }`,
    "app/dashboard/@team/not-found.tsx": `export default function NotFound() { return <p data-team-not-found>team missing</p>; }`,
    "app/dashboard/@team/broken/page.tsx": `let attempts = 0; export default function Page() { if (++attempts === 1) throw new Error("team retry"); return <p data-team-recovered>team recovered</p>; }`,
    "app/dashboard/@team/missing/page.tsx": `import {notFound} from "next/navigation"; export default function Page() { notFound(); }`,
    "app/dashboard/@analytics/page.tsx": `import Counter from "../../counter"; export default function Page() { return <Counter name="analytics-home" />; }`,
    "app/dashboard/@analytics/views/page.tsx": `import Counter from "../../../counter"; export default function Page() { return <Counter name="analytics-views" />; }`,
    "app/dashboard/@analytics/default.tsx": `export default function Default() { return <p data-analytics-default>analytics default</p>; }`,
    "app/@modal/default.tsx": `export default function Default() { return null; }`,
    "app/@modal/[...catchall]/page.tsx": `export default function Page() { return null; }`,
    "app/@modal/(.)photo/[id]/page.tsx": `import Counter from "../../../counter"; export default async function Page({params}) { return <dialog open data-modal><p>modal:{(await params).id}</p><Counter name="modal" /></dialog>; }`,
    "app/photo/[id]/page.tsx": `export default async function Page({params}) { return <article data-canonical>photo:{(await params).id}</article>; }`,
    "app/not-found.tsx": `export default function NotFound() { return <p data-root-not-found>unknown</p>; }`,
  };
  return Object.entries(source).map(([path, content]) => ({ path, content, language: path.endsWith(".css") ? "css" : "tsx" }));
}
