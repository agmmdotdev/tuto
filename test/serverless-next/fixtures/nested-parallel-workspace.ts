import type { WorkspaceFile } from "../../../lib/ide/types";

// A dashboard with slots inside slots, repeated names at different owners,
// dynamic params, and a branch that must never activate outside /archive.
export function nestedParallelWorkspace(): WorkspaceFile[] {
  const sources: Record<string, string> = {
    "app/layout.tsx": `export default function Layout({ children, workspace, info }) {
      return <html><body><header>nested-dashboard</header><main>{children}</main><aside data-root-info>{info}</aside><section data-workspace>{workspace}</section></body></html>;
    }`,
    "app/projects/[project]/page.tsx": `export default async function Page({ params }) {
      return <p data-primary>primary:{(await params).project}:</p>;
    }`,
    "app/projects/[project]/[outcome]/page.tsx": `export default async function Page({ params }) {
      const { project, outcome } = await params;
      return <p data-primary>primary:{project}:{outcome}</p>;
    }`,
    "app/@info/default.tsx": `export default function Default() { return <p>root-info</p>; }`,
    "app/@workspace/layout.tsx": `export default function Layout({ children, info }) {
      return <div data-workspace-layout>{children}<aside data-workspace-info>{info}</aside></div>;
    }`,
    "app/@workspace/default.tsx": `export default function Default() { return <p>workspace-default</p>; }`,
    "app/@workspace/@info/default.tsx": `export default function Default() { return <p>workspace-info</p>; }`,
    "app/@workspace/projects/[project]/layout.tsx": `export default function Layout({ children, metrics }) {
      return <section data-project-layout>{children}<aside data-metrics>{metrics}</aside></section>;
    }`,
    "app/@workspace/projects/[project]/page.tsx": `export default async function Page({ params }) {
      return <p data-workspace-page>workspace:{(await params).project}</p>;
    }`,
    "app/@workspace/projects/[project]/[outcome]/page.tsx": `export default async function Page({ params }) {
      return <p data-workspace-page>workspace:{(await params).project}</p>;
    }`,
    "app/@workspace/projects/[project]/@metrics/default.tsx": `export default async function Default({ params }) {
      return <p data-metrics-default>metrics-default:{(await params).project}</p>;
    }`,
    "app/@workspace/projects/[project]/@metrics/layout.tsx": `export default function Layout({ children, detail }) {
      return <div data-metrics-layout>{children}<section data-detail>{detail}</section></div>;
    }`,
    "app/@workspace/projects/[project]/@metrics/[outcome]/page.tsx": `export default async function Page({ params }) {
      return <p data-metrics-page>metrics:{(await params).outcome}</p>;
    }`,
    "app/@workspace/projects/[project]/@metrics/error.tsx": `"use client";
      export default function Error({ error }) { return <p data-metrics-error>metrics-error:{error.message}</p>; }`,
    "app/@workspace/projects/[project]/@metrics/@detail/default.tsx": `export default function Default() { return <p data-detail-default>detail-default</p>; }`,
    "app/@workspace/projects/[project]/@metrics/@detail/layout.tsx": `import { headers } from "next/headers";
      export default async function Layout({ children, badge }) {
      if ((await headers()).get("x-detail-layout-error") === "1") throw new Error("detail layout exploded");
      return <div data-detail-layout>{children}<aside data-badge>{badge}</aside></div>;
    }`,
    "app/@workspace/projects/[project]/@metrics/@detail/[outcome]/page.tsx": `import { notFound } from "next/navigation";
      import Counter from "./counter";
      import "./detail.css";
      export default async function Page({ params }) {
        const { project, outcome } = await params;
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (outcome === "error") throw new Error("detail page exploded");
        if (outcome === "missing") notFound();
        return <p data-detail-page>detail:{project}:{outcome}<Counter /></p>;
      }`,
    "app/@workspace/projects/[project]/@metrics/@detail/[outcome]/counter.tsx": `"use client";
      import { useState } from "react";
      export default function Counter() {
        const [count, setCount] = useState(0);
        return <button data-nested-counter onClick={() => setCount(count + 1)}>nested-count:{count}</button>;
      }`,
    "app/@workspace/projects/[project]/@metrics/@detail/[outcome]/detail.css": `[data-detail-page] { color: rgb(102, 51, 153); }`,
    "app/@workspace/projects/[project]/@metrics/@detail/error.tsx": `"use client";
      import "./boundary.css";
      export default function Error({ error }) { return <p data-detail-error>detail-error:{error.message}</p>; }`,
    "app/@workspace/projects/[project]/@metrics/@detail/boundary.css": `[data-detail-error], [data-detail-not-found] { color: rgb(12, 34, 56); }`,
    "app/@workspace/projects/[project]/@metrics/@detail/not-found.tsx": `import "./boundary.css";
      export default function NotFound() { return <p data-detail-not-found>detail-not-found</p>; }`,
    "app/@workspace/projects/[project]/@metrics/@detail/loading.tsx": `export default function Loading() { return <p data-detail-loading>detail-loading</p>; }`,
    "app/@workspace/projects/[project]/@metrics/@detail/@badge/default.tsx": `import { headers } from "next/headers";
      export default async function Default({ params }) {
      if ((await headers()).get("x-badge-error") === "1") throw new Error("badge default exploded");
      const { project, outcome } = await params;
      return <p>badge:{project}:{outcome ?? "default"}</p>;
    }`,
    "app/@workspace/projects/[project]/archive/layout.tsx": `export default function Layout({ children, unused }) { return <section>{children}{unused}</section>; }`,
    "app/@workspace/projects/[project]/archive/page.tsx": `export default function Page() { return <p>archive</p>; }`,
    "app/@workspace/projects/[project]/archive/@unused/default.tsx": `export default function Default() { throw new Error("inactive slot executed"); }`,
  };
  return Object.entries(sources).map(([filePath, content]) => ({
    content,
    language: filePath.endsWith(".css") ? "css" : "tsx",
    path: filePath,
  }));
}
