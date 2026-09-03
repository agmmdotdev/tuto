import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import type { WorkspaceFile } from "../../lib/ide/types";
import { getServerlessNextjsRuntimeTemplate } from "../../lib/ide/templates";
import {
  clearNextRequestArtifactsForTests,
  diffNextRequestArtifacts,
  getNextRequestArtifact,
} from "../../lib/serverless-next/artifact";
import {
  compileNextRequestWorkspace,
  compileNextRequestWorkspaceWithStatus,
} from "../../lib/serverless-next/compiler";
import { clearNextTransformCacheForTests } from "../../lib/serverless-next/next-compiler-adapter";
import {
  clearNextCacheAdapterForTests,
  setNextCacheAdapter,
} from "../../lib/serverless-next/cache-adapter";
import {
  DurableNextCacheAdapter,
  MemoryNextCacheInvalidationCoordinator,
  MemoryNextCacheValueStore,
} from "../../lib/serverless-next/durable-cache-adapter";
import {
  executeNextProgressiveActionArtifact,
  executeNextServerActionArtifact,
  executeNextRequestArtifact,
  invokeNextServerAction,
  invokeNextRouteHandler,
  renderHydratableNextRequestArtifact,
  renderNextRequestArtifact,
  serializeNextActionBody,
} from "../../lib/serverless-next/runtime";
import { closeNextRscWorkerPoolForTests } from "../../lib/serverless-next/rsc-worker-pool";
import { closeNextSsrWorkerPoolForTests } from "../../lib/serverless-next/ssr-worker-pool";
import {
  GET as previewRoute,
  POST as requestRoute,
} from "../../app/api/serverless/nextjs-runtime/request/route";

const actionSalt = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const runtimeRequire = createRequire(path.join(process.cwd(), "package.json"));
(
  globalThis as typeof globalThis & { __webpack_require__?: () => unknown }
).__webpack_require__ ??= () => undefined;
const rscClient = runtimeRequire(
  "next/dist/compiled/react-server-dom-webpack/client.node",
) as {
  encodeReply(value: unknown): Promise<FormData | string>;
};
const rscBrowserClient = runtimeRequire(
  "next/dist/compiled/react-server-dom-webpack/client.browser",
) as {
  createFromReadableStream(
    stream: ReadableStream<Uint8Array>,
    options: {
      callServer(id: string, args: unknown[]): Promise<unknown>;
    },
  ): Promise<unknown>;
};

function workspace(serverMarker: string): WorkspaceFile[] {
  return [
    {
      content: `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body><header>shared-layout</header>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `import Counter from './counter';
export default async function Page() {
  const marker = await Promise.resolve(${JSON.stringify(serverMarker)});
  return <main><h1>{marker}</h1><Counter initial={2} /></main>;
}`,
      language: "tsx",
      path: "app/page.tsx",
    },
    {
      content: `"use client";
import { useState } from 'react';
export default function Counter({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial);
  return <button data-client="counter" onClick={() => setCount((value) => value + 1)}>count:{count}</button>;
}`,
      language: "tsx",
      path: "app/counter.tsx",
    },
  ];
}

function frameworkAssetWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `import { NextResponse, type NextRequest } from "next/server";
export const config = { matcher: ["/mark-alias"] };
export function proxy(request: NextRequest) {
  const response = NextResponse.rewrite(new URL("/mark.svg", request.url));
  response.headers.set("x-asset-proxy", "rewritten");
  return response;
}`,
      language: "ts",
      path: "proxy.ts",
    },
    {
      content: `import "./global.css";
export const metadata = {
  description: "Request-compiled lessons",
  title: { default: "Tuto", template: "%s | Tuto" },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `import "./page.css";
import LessonCard from "./lesson-card";
export async function generateMetadata({ searchParams }: {
  searchParams: Promise<{ lesson?: string }>;
}) {
  const lesson = (await searchParams).lesson ?? "RSC";
  return { openGraph: { title: lesson }, title: "Lesson " + lesson };
}
export default function Page() {
  return <main><LessonCard /></main>;
}`,
      language: "tsx",
      path: "app/page.tsx",
    },
    {
      content: `"use client";
import styles from "./lesson-card.module.css";
export default function LessonCard() {
  return <button className={styles.card}>interactive lesson</button>;
}`,
      language: "tsx",
      path: "app/lesson-card.tsx",
    },
    {
      content: "body { background: rgb(1, 2, 3); }",
      language: "css",
      path: "app/global.css",
    },
    {
      content: "main { padding: 17px; }",
      language: "css",
      path: "app/page.css",
    },
    {
      content: ".card { color: rebeccapurple; }",
      language: "css",
      path: "app/lesson-card.module.css",
    },
    {
      content: `import "./unused.css";
export const metadata = { title: "Other" };
export default function Other() { return <main>other route</main>; }`,
      language: "tsx",
      path: "app/other/page.tsx",
    },
    {
      content: "main { border: 99px solid red; }",
      language: "css",
      path: "app/other/unused.css",
    },
    {
      content:
        '<svg xmlns="http://www.w3.org/2000/svg"><title>Tuto mark</title></svg>',
      language: "html",
      path: "public/mark.svg",
    },
    {
      content: "User-agent: *\nDisallow:",
      language: "md",
      path: "public/robots.txt",
    },
  ];
}

function routeWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body><header>root-layout</header>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `export default function NotFound() { return <main>root-not-found</main>; }`,
      language: "tsx",
      path: "app/not-found.tsx",
    },
    {
      content: `export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return <section><h2>blog-layout</h2>{children}</section>;
}`,
      language: "tsx",
      path: "app/blog/layout.tsx",
    },
    {
      content: `export default function NewPost() { return <p>static-new-post</p>; }`,
      language: "tsx",
      path: "app/blog/new/page.tsx",
    },
    {
      content: `export default async function Post({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ slug }, { tab }] = await Promise.all([params, searchParams]);
  return <p>dynamic-post:{slug}:tab:{tab ?? "overview"}</p>;
}`,
      language: "tsx",
      path: "app/blog/[slug]/page.tsx",
    },
    {
      content: `export default async function Docs({ params }: { params: Promise<{ parts: string[] }> }) {
  return <p>docs:{(await params).parts.join("|")}</p>;
}`,
      language: "tsx",
      path: "app/docs/[...parts]/page.tsx",
    },
    {
      content: `export default async function Optional({ params }: { params: Promise<{ rest?: string[] }> }) {
  return <p>optional:{(await params).rest?.join("|") ?? "empty"}</p>;
}`,
      language: "tsx",
      path: "app/optional/[[...rest]]/page.tsx",
    },
  ];
}

function actionWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `"use server";
let total = 0;
export async function increment(delta: number) {
  total += delta;
  return total;
}
export async function current() { return total; }`,
      language: "ts",
      path: "app/actions.ts",
    },
    {
      content: `import { current } from "./actions";
import ActionButton from "./action-button";
export default async function Page() {
  return <main><h1>server-total:{await current()}</h1><ActionButton /></main>;
}`,
      language: "tsx",
      path: "app/page.tsx",
    },
    {
      content: `"use client";
import { useState } from "react";
import { increment } from "./actions";
export default function ActionButton() {
  const [result, setResult] = useState<number | null>(null);
  return <button data-action="increment" onClick={async () => setResult(await increment(3))}>
    action-result:{result ?? "idle"}
  </button>;
}`,
      language: "tsx",
      path: "app/action-button.tsx",
    },
  ];
}

function capturedActionWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `export default function Page() {
  const lessonId = "rsc";
  async function save(prefix: string, formData: FormData) {
    "use server";
    return lessonId + ":" + prefix + ":" + formData.get("title");
  }
  const action = save.bind(null, "saved");
  return <main><form action={action}><input name="title" /></form></main>;
}`,
      language: "tsx",
      path: "app/page.tsx",
    },
  ];
}

function progressiveActionWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `"use client";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

function Submit() {
  const { pending } = useFormStatus();
  return <button data-pending disabled={pending}>{pending ? "Saving" : "Save"}</button>;
}

export default function ActionForm({ action }: {
  action(previous: string, formData: FormData): Promise<string>;
}) {
  const [state, formAction] = useActionState(action, "idle");
  return <form action={formAction}>
    <input name="title" />
    <Submit />
    <p data-action-state>action-state:{state}</p>
  </form>;
}`,
      language: "tsx",
      path: "app/action-form.tsx",
    },
    {
      content: `import ActionForm from "./action-form";
export default function Page() {
  const lessonId = "rsc";
  async function save(prefix: string, previous: string, formData: FormData) {
    "use server";
    return prefix + ":" + lessonId + ":" + previous + ":" + formData.get("title");
  }
  return <main><ActionForm action={save.bind(null, "saved")} /></main>;
}`,
      language: "tsx",
      path: "app/page.tsx",
    },
  ];
}

function controlFlowWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `export default function NotFound() { return <main>lesson-not-found</main>; }`,
      language: "tsx",
      path: "app/not-found.tsx",
    },
    {
      content: `"use client";
export default function ErrorView({ error, reset }: { error: Error; reset(): void }) {
  return <main><p>lesson-error:{error.message}</p><button onClick={reset}>retry lesson</button></main>;
}`,
      language: "tsx",
      path: "app/error.tsx",
    },
    {
      content: `import { notFound, permanentRedirect, redirect } from "next/navigation";
export default async function Page({ searchParams }: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;
  if (mode === "missing") notFound();
  if (mode === "redirect") redirect("/destination");
  if (mode === "permanent") permanentRedirect("/permanent-destination");
  if (mode === "error") throw new Error("page exploded");
  return <main>control-flow-ok</main>;
}`,
      language: "tsx",
      path: "app/page.tsx",
    },
    {
      content: `"use server";
import { notFound, redirect } from "next/navigation";
export async function redirectAction() { redirect("/after-action"); }
export async function missingAction() { notFound(); }
export async function failingAction() { throw new Error("lesson exploded"); }`,
      language: "ts",
      path: "app/actions.ts",
    },
  ];
}

function boundaryWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body><p>root-boundary-layout</p>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `"use client";
export default function RootError({ error }: { error: Error }) {
  return <main>root-error:{error.message}</main>;
}`,
      language: "tsx",
      path: "app/error.tsx",
    },
    {
      content: `export default function NotFound() { return <main>root-boundary-not-found</main>; }`,
      language: "tsx",
      path: "app/not-found.tsx",
    },
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <section><p>dashboard-layout</p>{children}</section>;
}`,
      language: "tsx",
      path: "app/dashboard/layout.tsx",
    },
    {
      content: `"use client";
export default function DashboardError({ error, reset }: { error: Error; reset(): void }) {
  return <main><p>dashboard-error:{error.message}</p><button onClick={reset}>retry dashboard</button></main>;
}`,
      language: "tsx",
      path: "app/dashboard/error.tsx",
    },
    {
      content: `export default function Loading() { return <p>dashboard-loading</p>; }`,
      language: "tsx",
      path: "app/dashboard/loading.tsx",
    },
    {
      content: `export default function NotFound() { return <main>dashboard-not-found</main>; }`,
      language: "tsx",
      path: "app/dashboard/not-found.tsx",
    },
    {
      content: `import Link from "next/link";
import { notFound } from "next/navigation";
export default async function Page({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const { mode } = await searchParams;
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (mode === "missing") notFound();
  if (mode === "error") throw new Error("dashboard exploded");
  return <main><Link href="/dashboard?mode=error">open failure</Link><p>dashboard-ok</p></main>;
}`,
      language: "tsx",
      path: "app/dashboard/page.tsx",
    },
    {
      content: `"use client";
export default function WrongError({ error }: { error: Error }) {
  return <main>wrong-broken-error:{error.message}</main>;
}`,
      language: "tsx",
      path: "app/broken/error.tsx",
    },
    {
      content: `export default function BrokenLayout({ children }: { children: React.ReactNode }) {
  throw new Error("broken layout exploded");
  return <section>{children}</section>;
}`,
      language: "tsx",
      path: "app/broken/layout.tsx",
    },
    {
      content: `export default function Page() { return <main>unreachable</main>; }`,
      language: "tsx",
      path: "app/broken/page.tsx",
    },
    {
      content: `import { notFound } from "next/navigation";
export default function MissingLayout({ children }: { children: React.ReactNode }) {
  notFound();
  return <section>{children}</section>;
}`,
      language: "tsx",
      path: "app/missing-layout/layout.tsx",
    },
    {
      content: `export default function WrongNotFound() { return <main>wrong-layout-not-found</main>; }`,
      language: "tsx",
      path: "app/missing-layout/not-found.tsx",
    },
    {
      content: `export default function Page() { return <main>unreachable</main>; }`,
      language: "tsx",
      path: "app/missing-layout/page.tsx",
    },
    {
      content: `"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
export default function NavigationState() {
  const router = useRouter();
  return <button data-navigation-state onClick={() => router.replace("/dashboard")}>
    {usePathname()}:{useSearchParams().get("tab")}
  </button>;
}`,
      language: "tsx",
      path: "app/navigation-state.tsx",
    },
    {
      content: `import NavigationState from "../navigation-state";
export default function Page() { return <main><NavigationState /></main>; }`,
      language: "tsx",
      path: "app/navigation/page.tsx",
    },
  ];
}

function findElementProp(value: unknown, prop: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const props = record.props as Record<string, unknown> | undefined;
  if (props && prop in props) return props[prop];
  if (props) {
    for (const child of Object.values(props)) {
      const found = findElementProp(child, prop);
      if (found !== undefined) return found;
    }
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findElementProp(child, prop);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function decodeHtmlAttribute(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function hiddenFormData(html: string) {
  const formData = new FormData();
  const input = /<input type="hidden"([^>]*)\/?>(?:<\/input>)?/g;
  for (const match of html.matchAll(input)) {
    const name = /\bname="([^"]+)"/.exec(match[1]);
    if (!name) continue;
    const value = /\bvalue="([^"]*)"/.exec(match[1]);
    formData.append(
      decodeHtmlAttribute(name[1]),
      decodeHtmlAttribute(value?.[1] ?? ""),
    );
  }
  return formData;
}

function cacheWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `import { cache } from "react";
import { unstable_cache } from "next/cache";
let tagReads = 0;
let pathReads = 0;
let memoReads = 0;
export const getMemoizedValue = cache(async () => ++memoReads);
export const getTaggedValue = unstable_cache(async () => ++tagReads, ["tagged-value"], {
  revalidate: 3600,
  tags: ["lesson-posts"],
});
export const getPathValue = unstable_cache(async () => ++pathReads, ["path-value"], {
  revalidate: 3600,
});`,
      language: "ts",
      path: "app/cache/data.ts",
    },
    {
      content: `"use server";
import { revalidatePath, revalidateTag, updateTag } from "next/cache";
export async function expireTag() { updateTag("lesson-posts"); return "expired"; }
export async function staleTag() { revalidateTag("lesson-posts", "max"); return "stale"; }
export async function expirePath() { revalidatePath("/cache"); return "path"; }`,
      language: "ts",
      path: "app/cache/actions.ts",
    },
    {
      content: `import { getMemoizedValue, getPathValue, getTaggedValue } from "./data";
export default async function CachePage() {
  const [tagged, path] = await Promise.all([getTaggedValue(), getPathValue()]);
  const memoA = await getMemoizedValue();
  const memoB = await getMemoizedValue();
  return <main><p>tag-read:{tagged}</p><p>path-read:{path}</p><p>memo-read:{memoA}:{memoB}</p></main>;
}`,
      language: "tsx",
      path: "app/cache/page.tsx",
    },
  ];
}

function cacheComponentsWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `import { cacheLife, cacheTag } from "next/cache";
let reads = 0;
export async function getCachedLesson(id: string) {
  "use cache";
  cacheLife({ stale: 30, revalidate: 3600, expire: 7200 });
  cacheTag("cache-component-" + id);
  return { id, reads: ++reads };
}`,
      language: "ts",
      path: "app/components/data.ts",
    },
    {
      content: `"use client";
export default function CachedBadge({ label }: { label: string }) {
  return <button data-cached-client>{label}</button>;
}`,
      language: "tsx",
      path: "app/components/cached-badge.tsx",
    },
    {
      content: `import { cacheLife, cacheTag } from "next/cache";
import CachedBadge from "./cached-badge";
let renders = 0;
export default async function CachedCard({ id }: { id: string }) {
  "use cache";
  cacheLife("hours");
  cacheTag("cache-component-" + id);
  return <section>cached-card:{id}:{++renders}<CachedBadge label={id} /></section>;
}`,
      language: "tsx",
      path: "app/components/cached-card.tsx",
    },
    {
      content: `"use server";
import { revalidateTag, updateTag } from "next/cache";
export async function expireComponent(id: string) {
  updateTag("cache-component-" + id);
  return id;
}
export async function staleComponent(id: string) {
  revalidateTag("cache-component-" + id, "max");
  return id;
}`,
      language: "ts",
      path: "app/components/actions.ts",
    },
    {
      content: `import CachedCard from "./cached-card";
import { getCachedLesson } from "./data";
export default async function CacheComponentsPage() {
  const first = await getCachedLesson("rsc");
  const second = await getCachedLesson("rsc");
  return <main><p>component-read:{first.id}:{first.reads}</p><p>deduped-read:{second.reads}</p><CachedCard id="rsc" /></main>;
}`,
      language: "tsx",
      path: "app/components/page.tsx",
    },
  ];
}

function fetchCacheWorkspace(originUrl: string): WorkspaceFile[] {
  return [
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `export async function getOriginValue() {
  const response = await fetch(${JSON.stringify(originUrl)}, {
    next: { revalidate: 3600, tags: ["fetch-lesson"] },
  });
  return response.json() as Promise<{ reads: number }>;
}`,
      language: "ts",
      path: "app/fetch/data.ts",
    },
    {
      content: `"use server";
import { updateTag } from "next/cache";
export async function expireFetch() { updateTag("fetch-lesson"); }`,
      language: "ts",
      path: "app/fetch/actions.ts",
    },
    {
      content: `import { getOriginValue } from "./data";
export default async function FetchPage() {
  const value = await getOriginValue();
  return <main>fetch-read:{value.reads}</main>;
}`,
      language: "tsx",
      path: "app/fetch/page.tsx",
    },
  ];
}

function routeHandlerWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `import { revalidateTag, unstable_cache } from "next/cache";
import { cookies, headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

let reads = 0;
const getLesson = unstable_cache(
  async (lessonId: string) => ({ lessonId, reads: ++reads }),
  ["route-handler-lesson"],
  { revalidate: 3600, tags: ["route-handler-lessons"] },
);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ lessonId: string }> },
) {
  const { lessonId } = await params;
  const requestHeaders = await headers();
  const requestCookies = await cookies();
  const lesson = await getLesson(lessonId);
  requestCookies.set("tuto-visited", lessonId, { httpOnly: true, path: "/" });
  const response = NextResponse.json(
    {
      cookie: requestCookies.get("session")?.value ?? null,
      header: requestHeaders.get("x-lesson-mode"),
      lesson,
      query: request.nextUrl.searchParams.get("mode"),
    },
    { status: 201, headers: { "x-route-kind": "lesson" } },
  );
  response.cookies.set("response-cookie", "next-response");
  return response;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ lessonId: string }> },
) {
  const input = await request.json() as { title: string };
  revalidateTag("route-handler-lessons", { expire: 0 });
  return Response.json(
    { lessonId: (await params).lessonId, method: request.method, title: input.title },
    { status: 202 },
  );
}`,
      language: "ts",
      path: "app/api/lessons/[lessonId]/route.ts",
    },
    {
      content: `export function GET() {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("first:"));
      controller.enqueue(encoder.encode("second"));
      controller.close();
    },
  }), { headers: { "content-type": "text/plain; charset=utf-8" } });
}`,
      language: "ts",
      path: "app/api/stream/route.ts",
    },
  ];
}

function proxyWorkspace(entry = "proxy.ts"): WorkspaceFile[] {
  return [
    {
      content: `import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";

let waited = false;

export const config = {
  matcher: [
    "/protected/:path*",
    "/api/:path*",
    "/rewrite",
    "/redirect",
    "/direct",
    "/wait/:path*",
    {
      source: "/guarded/:path*",
      has: [{ type: "header", key: "x-run-proxy", value: "yes" }],
      missing: [{ type: "header", key: "x-skip-proxy" }],
    },
  ],
};

export async function ${entry.startsWith("middleware") ? "middleware" : "proxy"}(
  request: NextRequest,
  event: NextFetchEvent,
) {
  const pathname = request.nextUrl.pathname;
  if (pathname === "/redirect") {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (pathname === "/rewrite") {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-from-proxy", "rewrite");
    const response = NextResponse.rewrite(
      new URL("/destination?source=proxy", request.url),
      { request: { headers: requestHeaders }, headers: { "x-proxy-response": "rewrite" } },
    );
    response.cookies.set("proxy-cookie", "rewrite", { path: "/" });
    return response;
  }
  if (pathname === "/direct" || pathname === "/wait/status") {
    return NextResponse.json(
      { direct: pathname, session: request.cookies.get("session")?.value ?? null, waited },
      { status: pathname === "/direct" ? 418 : 200 },
    );
  }
  if (pathname === "/wait/start") {
    event.waitUntil(Promise.resolve().then(() => { waited = true; }));
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-from-proxy", pathname);
  const response = NextResponse.next({
    request: { headers: requestHeaders },
    headers: { "x-proxy-response": "next" },
  });
  response.cookies.set("proxy-cookie", "continued", { httpOnly: true, path: "/" });
  return response;
}`,
      language: "ts",
      path: entry,
    },
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `export default function Page() { return <main>public-page</main>; }`,
      language: "tsx",
      path: "app/page.tsx",
    },
    {
      content: `import { cookies, headers } from "next/headers";
export default async function Protected() {
  const requestHeaders = await headers();
  const requestCookies = await cookies();
  return <main>protected:{requestHeaders.get("x-from-proxy")}:cookie:{requestCookies.get("proxy-cookie")?.value ?? "none"}</main>;
}`,
      language: "tsx",
      path: "app/protected/page.tsx",
    },
    {
      content: `import { headers } from "next/headers";
export default async function Destination({ searchParams }: { searchParams: Promise<{ source?: string }> }) {
  return <main>destination:{(await searchParams).source}:header:{(await headers()).get("x-from-proxy")}</main>;
}`,
      language: "tsx",
      path: "app/destination/page.tsx",
    },
    {
      content: `import { headers } from "next/headers";
export default async function Guarded() {
  return <main>guarded:{(await headers()).get("x-from-proxy") ?? "skipped"}</main>;
}`,
      language: "tsx",
      path: "app/guarded/[slug]/page.tsx",
    },
    {
      content: `export default function Login() { return <main>login-page</main>; }`,
      language: "tsx",
      path: "app/login/page.tsx",
    },
    {
      content: `export default function Wait() { return <main>wait-page</main>; }`,
      language: "tsx",
      path: "app/wait/[stage]/page.tsx",
    },
    {
      content: `import { cookies, headers } from "next/headers";
export async function POST(request: Request) {
  return Response.json({
    body: await request.json(),
    cookie: (await cookies()).get("proxy-cookie")?.value ?? null,
    header: (await headers()).get("x-from-proxy"),
  });
}`,
      language: "ts",
      path: "app/api/echo/route.ts",
    },
  ];
}

function proxyActionWorkspace(): WorkspaceFile[] {
  return [
    {
      content: `import { NextResponse, type NextRequest } from "next/server";

export const config = { matcher: ["/actions/:path*"] };

export async function proxy(request: NextRequest) {
  const outcome = request.headers.get("x-action-outcome");
  if (outcome === "redirect") {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (outcome === "response") {
    return NextResponse.json({ blockedBy: "action-proxy" }, { status: 409 });
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-action-proxy", request.headers.has("next-action") ? "passed" : "missing");
  requestHeaders.set("x-action-body", (await request.text()).length > 0 ? "present" : "missing");
  if (outcome === "remove-action-header") requestHeaders.delete("next-action");
  const response = request.nextUrl.pathname === "/actions/source"
    ? NextResponse.rewrite(new URL("/actions/destination", request.url), {
        request: { headers: requestHeaders },
      })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-action-proxy-response", "continued");
  response.cookies.set("proxy-action-cookie", "continued", { path: "/" });
  return response;
}`,
      language: "ts",
      path: "proxy.ts",
    },
    {
      content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
      language: "tsx",
      path: "app/layout.tsx",
    },
    {
      content: `"use server";
import { cookies, headers } from "next/headers";

export async function inspectAction(value: string) {
  const requestHeaders = await headers();
  const requestCookies = await cookies();
  requestCookies.set("action-cookie", "written", { path: "/" });
  return [
    value,
    requestHeaders.get("x-action-proxy"),
    requestHeaders.get("x-action-body"),
    requestCookies.get("proxy-action-cookie")?.value,
    requestCookies.get("session")?.value,
  ].join("|");
}

export async function inspectUpload(file: File) {
  return [
    file.name,
    file.type,
    await file.text(),
    (await headers()).get("x-action-body"),
  ].join("|");
}`,
      language: "ts",
      path: "app/actions/action.ts",
    },
    {
      content: `"use client";
import { inspectAction } from "./action";
export default function ActionButton() {
  return <button onClick={() => inspectAction("browser")}>Run action</button>;
}`,
      language: "tsx",
      path: "app/actions/action-button.tsx",
    },
    ...["source", "destination"].map((segment) => ({
      content: `import { cookies, headers } from "next/headers";
import ActionButton from "../action-button";
export default async function Page() {
  return <main>${segment}-action-page:proxy:{(await headers()).get("x-action-proxy")}:proxy-cookie:{(await cookies()).get("proxy-action-cookie")?.value ?? "none"}:action-cookie:{(await cookies()).get("action-cookie")?.value ?? "none"}<ActionButton /></main>;
}`,
      language: "tsx" as const,
      path: `app/actions/${segment}/page.tsx`,
    })),
    {
      content: `export default function Login() { return <main>login</main>; }`,
      language: "tsx",
      path: "app/login/page.tsx",
    },
  ];
}

describe("request-compiled Next RSC runtime", () => {
  beforeEach(() => {
    clearNextRequestArtifactsForTests();
    clearNextTransformCacheForTests();
    clearNextCacheAdapterForTests();
  });

  afterAll(async () => {
    await Promise.all([
      closeNextRscWorkerPoolForTests(),
      closeNextSsrWorkerPoolForTests(),
    ]);
  });

  test("uses Next SWC outputs to render Flight and HTML without next build", async () => {
    const artifact = await compileNextRequestWorkspace(workspace("server-v1"), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "lesson-rsc",
    });

    expect(artifact.nextVersion).toBe("16.2.6");
    expect(artifact.kernelId).toMatch(/^[a-f0-9]{20}$/);
    expect(artifact.router.routes).toMatchObject([
      {
        layouts: ["app/layout.tsx"],
        page: "app/page.tsx",
        pattern: "/",
      },
    ]);
    expect(Object.keys(artifact.clientReferenceManifest)).toEqual([
      "/tuto/workspaces/lesson-rsc/app/counter.tsx",
    ]);
    expect(artifact.serverModules["app/counter.tsx"].code).toContain(
      "private-next-rsc-mod-ref-proxy",
    );
    expect(artifact.clientModules["app/counter.tsx"].code).toContain(
      "useState",
    );
    expect(artifact.clientBundle.code).toContain(
      "__TUTO_NEXT_CLIENT_MODULES__",
    );
    expect(getNextRequestArtifact(artifact.revision)).toBe(artifact);

    const flightResponse = await renderNextRequestArtifact(artifact, {
      flight: true,
    });
    const flight = await flightResponse.text();
    expect(flightResponse.status).toBe(200);
    expect(flightResponse.headers.get("content-type")).toContain(
      "text/x-component",
    );
    expect(flight).toContain("server-v1");
    expect(flight).toContain(artifact.clientModules["app/counter.tsx"].id);

    const htmlResponse = await renderNextRequestArtifact(artifact);
    const html = await htmlResponse.text();
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("x-tuto-next-generation")).toBe(
      artifact.generation,
    );
    expect(html).toContain("shared-layout");
    expect(html).toContain("server-v1");
    expect(html).toContain('data-client="counter"');
    expect(html).toContain("count:<!-- -->2");

    const hydratable = await (
      await renderHydratableNextRequestArtifact(artifact)
    ).text();
    expect(hydratable).toContain("__TUTO_NEXT_CLIENT_KERNEL__");
    expect(hydratable).toContain("__TUTO_NEXT_CLIENT_MODULES__");
    expect(hydratable).toContain("hydrateRoot");
    expect(hydratable).toContain(artifact.generation);
  });

  test("renders Next metadata and only the CSS reachable from the matched route", async () => {
    const artifact = await compileNextRequestWorkspace(
      frameworkAssetWorkspace(),
      {
        serverReferenceHashSalt: actionSalt,
        workspaceKey: "framework-assets",
      },
    );

    expect(Object.keys(artifact.styles)).toEqual([
      "app/global.css",
      "app/lesson-card.module.css",
      "app/other/unused.css",
      "app/page.css",
    ]);
    expect(artifact.styles["app/lesson-card.module.css"].exports.card).toMatch(
      /^tuto_[A-Za-z0-9_-]+_card$/,
    );

    const response = await renderNextRequestArtifact(artifact, {
      url: "/?lesson=Actions",
    });
    const html = await response.text();
    expect(html).toContain("<title>Lesson Actions</title>");
    expect(html).toContain(
      '<meta name="description" content="Request-compiled lessons"',
    );
    expect(html).toContain('<meta property="og:title" content="Actions"');
    expect(html).toContain('data-tuto-next-style="app/global.css"');
    expect(html).toContain('data-tuto-next-style="app/page.css"');
    expect(html).toContain('data-tuto-next-style="app/lesson-card.module.css"');
    expect(html).not.toContain("app/other/unused.css");
    expect(html).toContain(
      `class="${artifact.styles["app/lesson-card.module.css"].exports.card}"`,
    );
    expect(artifact.clientBundle.code).toContain(
      artifact.styles["app/lesson-card.module.css"].exports.card,
    );

    const nestedHtml = await (
      await renderNextRequestArtifact(artifact, { url: "/other" })
    ).text();
    expect(nestedHtml).toContain("<title>Other | Tuto</title>");
    expect(nestedHtml).toContain("app/other/unused.css");
    expect(nestedHtml).not.toContain("app/page.css");
  });

  test("serves immutable-generation public assets with HTTP revalidation", async () => {
    const artifact = await compileNextRequestWorkspace(
      frameworkAssetWorkspace(),
      {
        serverReferenceHashSalt: actionSalt,
        workspaceKey: "public-assets",
      },
    );

    const first = await executeNextRequestArtifact(artifact, {
      url: "/mark.svg",
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe(
      "image/svg+xml; charset=utf-8",
    );
    expect(first.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(first.headers.get("x-tuto-next-runtime-kind")).toBe("public-asset");
    expect(await first.text()).toContain("Tuto mark");

    const rewritten = await executeNextRequestArtifact(artifact, {
      url: "/mark-alias",
    });
    expect(rewritten.status).toBe(200);
    expect(rewritten.headers.get("x-asset-proxy")).toBe("rewritten");
    expect(rewritten.headers.get("x-tuto-next-proxy")).toBe(
      "matched=1; outcome=rewrite",
    );
    expect(rewritten.headers.get("x-tuto-next-runtime-kind")).toBe(
      "public-asset",
    );
    expect(await rewritten.text()).toContain("Tuto mark");

    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const unchanged = await executeNextRequestArtifact(artifact, {
      headers: { "if-none-match": etag! },
      url: "/mark.svg",
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");

    const head = await executeNextRequestArtifact(artifact, {
      method: "HEAD",
      url: "/robots.txt",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await head.text()).toBe("");
  });

  test("publishes CSS and public-file edits without rebuilding student modules", async () => {
    const files = frameworkAssetWorkspace();
    const options = {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "framework-asset-edits",
    };
    const before = await compileNextRequestWorkspace(files, options);
    const editedFiles = files.map((file) =>
      file.path === "app/global.css"
        ? { ...file, content: `${file.content}\nbody { color: navy; }` }
        : file.path === "public/robots.txt"
          ? { ...file, content: `${file.content}\nAllow: /lessons` }
          : file,
    );
    const after = await compileNextRequestWorkspace(editedFiles, options);
    const diff = diffNextRequestArtifacts(before, after);

    expect(after.generation).not.toBe(before.generation);
    expect(diff.changedServerModules).toEqual([]);
    expect(diff.changedClientModules).toEqual([]);
    expect(diff.clientBundleChanged).toBe(false);
    expect(diff.routeManifestChanged).toBe(false);
    expect(diff.stylesChanged).toEqual(["app/global.css"]);
    expect(diff.staticAssetsChanged).toEqual(["/robots.txt"]);
    expect(after.buildMetrics.serverTransformCacheHits).toBe(
      after.buildMetrics.serverTransforms,
    );
    expect(after.buildMetrics.browserTransformCacheHits).toBe(
      after.buildMetrics.browserTransforms,
    );
  });

  test("publishes a new generation while preserving unchanged client artifacts", async () => {
    const before = await compileNextRequestWorkspace(workspace("server-v1"), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "lesson-edit",
    });
    const after = await compileNextRequestWorkspace(workspace("server-v2"), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "lesson-edit",
    });
    const diff = diffNextRequestArtifacts(before, after);

    expect(after.generation).not.toBe(before.generation);
    expect(diff).toEqual({
      actionManifestChanged: false,
      clientBundleChanged: false,
      changedClientModules: [],
      changedServerModules: ["app/page.tsx"],
      clientManifestChanged: false,
      removedClientModules: [],
      removedServerModules: [],
      removedStaticAssets: [],
      removedStyles: [],
      routeManifestChanged: false,
      staticAssetsChanged: [],
      stylesChanged: [],
    });
    expect(after.buildMetrics.browserTransformCacheHits).toBe(1);
    expect(after.buildMetrics.serverTransformCacheHits).toBe(2);
    expect(await (await renderNextRequestArtifact(before)).text()).toContain(
      "server-v1",
    );
    expect(await (await renderNextRequestArtifact(after)).text()).toContain(
      "server-v2",
    );
  });

  test("reuses an immutable artifact for an unchanged workspace", async () => {
    const options = {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "unchanged-workspace",
    };
    const first = await compileNextRequestWorkspaceWithStatus(
      workspace("unchanged"),
      options,
    );
    const second = await compileNextRequestWorkspaceWithStatus(
      workspace("unchanged"),
      options,
    );

    expect(first.artifactCache).toBe("miss");
    expect(second.artifactCache).toBe("hot");
    expect(second.artifact).toBe(first.artifact);
  });

  test("matches static, dynamic, catch-all, and optional routes with nested layouts", async () => {
    const artifact = await compileNextRequestWorkspace(routeWorkspace(), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "router-lessons",
    });
    expect(artifact.router.routes.map((route) => route.pattern)).toEqual([
      "/blog/new",
      "/blog/[slug]",
      "/docs/[...parts]",
      "/optional/[[...rest]]",
    ]);

    const dynamic = await renderNextRequestArtifact(artifact, {
      url: "/blog/hello-next?tab=comments",
    });
    const dynamicHtml = await dynamic.text();
    expect(dynamic.status).toBe(200);
    expect(dynamic.headers.get("x-tuto-next-route-pattern")).toBe(
      "/blog/[slug]",
    );
    expect(dynamicHtml).toContain("root-layout");
    expect(dynamicHtml).toContain("blog-layout");
    expect(dynamicHtml).toContain("dynamic-post:<!-- -->hello-next");
    expect(dynamicHtml).toContain("tab:<!-- -->comments");

    expect(
      await (
        await renderNextRequestArtifact(artifact, { url: "/blog/new" })
      ).text(),
    ).toContain("static-new-post");
    expect(
      await (
        await renderNextRequestArtifact(artifact, { url: "/docs/a/b/c" })
      ).text(),
    ).toContain("docs:<!-- -->a|b|c");
    expect(
      await (
        await renderNextRequestArtifact(artifact, { url: "/optional" })
      ).text(),
    ).toContain("optional:<!-- -->empty");

    const missing = await renderNextRequestArtifact(artifact, {
      url: "/does-not-exist",
    });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("root-not-found");
  });

  test("decodes and executes a real Next Server Action then returns refreshed Flight", async () => {
    const artifact = await compileNextRequestWorkspace(actionWorkspace(), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "action-lessons",
    });
    const actionEntry = Object.entries(artifact.actionManifest).find(
      ([, reference]) => reference.exportName === "increment",
    );
    expect(actionEntry).toBeDefined();
    expect(artifact.clientModules["app/actions.ts"].code).toContain(
      "createServerReference",
    );
    expect(artifact.clientBundle.code).toContain("__TUTO_NEXT_CLIENT_KERNEL__");

    const encodedArgs = await rscClient.encodeReply([3]);
    const response = await invokeNextServerAction(artifact, {
      actionId: actionEntry![0],
      body: await serializeNextActionBody(encodedArgs),
      url: "/",
    });
    const flight = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/x-component");
    expect(flight).toContain('"actionResult":3');
    expect(flight).toContain("server-total:");
    expect(flight).toContain("3");

    const refreshedHtml = await (
      await renderNextRequestArtifact(artifact)
    ).text();
    expect(refreshedHtml).toContain("server-total:<!-- -->3");
  });

  test("preserves compiler-generated captured and explicitly bound Server Action arguments", async () => {
    const artifact = await compileNextRequestWorkspace(
      capturedActionWorkspace(),
      {
        serverReferenceHashSalt: actionSalt,
        workspaceKey: "captured-action-lessons",
      },
    );
    expect(artifact.actionEncryptionKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    const html = await (await renderNextRequestArtifact(artifact)).text();
    expect(html).toContain('method="POST"');
    expect(html).toContain('name="$ACTION_REF_');
    const flight = await renderNextRequestArtifact(artifact, { flight: true });
    let dispatched: { actionId: string; args: unknown[] } | undefined;
    const model = await rscBrowserClient.createFromReadableStream(
      flight.body!,
      {
        async callServer(actionId, args) {
          dispatched = { actionId, args };
          return null;
        },
      },
    );
    const action = findElementProp(model, "action");
    expect(action).toBeTypeOf("function");
    const formData = new FormData();
    formData.set("title", "lesson");
    await (action as (formData: FormData) => Promise<unknown>)(formData);
    expect(dispatched?.actionId).toBe(Object.keys(artifact.actionManifest)[0]);

    const response = await invokeNextServerAction(artifact, {
      actionId: dispatched!.actionId,
      body: await serializeNextActionBody(
        await rscClient.encodeReply(dispatched!.args),
      ),
      url: "/",
    });
    expect(await response.text()).toContain(
      '"actionResult":"rsc:saved:lesson"',
    );
  });

  test("replays progressive useActionState forms with captured args and form status support", async () => {
    const artifact = await compileNextRequestWorkspace(
      progressiveActionWorkspace(),
      {
        serverReferenceHashSalt: actionSalt,
        workspaceKey: "progressive-action-lessons",
      },
    );
    const endpoint = "https://tuto.local/api/next-action";
    const initial = await renderHydratableNextRequestArtifact(artifact, {
      actionEndpoint: endpoint,
      url: "/",
    });
    const initialHtml = await initial.text();
    expect(initialHtml).toContain(`action="${endpoint}"`);
    expect(initialHtml).toContain('name="$TUTO_NEXT_REVISION"');
    expect(initialHtml).toContain('name="$ACTION_KEY"');
    expect(initialHtml).toContain("action-state:<!-- -->idle");
    expect(artifact.clientBundle.code).toContain("useFormStatus");

    const formData = hiddenFormData(initialHtml);
    formData.delete("$TUTO_NEXT_REVISION");
    formData.delete("$TUTO_NEXT_URL");
    formData.set("title", "lesson");
    const response = await executeNextProgressiveActionArtifact(artifact, {
      actionEndpoint: endpoint,
      body: await serializeNextActionBody(formData),
      headers: { "content-type": "multipart/form-data" },
      url: "/",
    });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-tuto-next-runtime-kind")).toBe(
      "progressive-action",
    );
    expect(html).toContain("action-state:<!-- -->saved:rsc:idle:lesson");
    expect(html).toContain(`action="${endpoint}"`);

    const endpointForm = hiddenFormData(initialHtml);
    endpointForm.set("title", "endpoint");
    const endpointResponse = await requestRoute(
      new Request(endpoint, { body: endpointForm, method: "POST" }),
    );
    expect(endpointResponse.status).toBe(200);
    expect(endpointResponse.headers.get("content-type")).toContain("text/html");
    expect(await endpointResponse.text()).toContain(
      "action-state:<!-- -->saved:rsc:idle:endpoint",
    );
  });

  test("normalizes redirect, notFound, and ordinary failures from components and actions", async () => {
    const artifact = await compileNextRequestWorkspace(controlFlowWorkspace(), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "next-control-flow",
    });
    const missingPage = await renderNextRequestArtifact(artifact, {
      url: "/?mode=missing",
    });
    expect(missingPage.status).toBe(404);
    expect(await missingPage.text()).toContain("lesson-not-found");

    const redirectedPage = await renderNextRequestArtifact(artifact, {
      url: "/?mode=redirect",
    });
    expect(redirectedPage.status).toBe(307);
    expect(redirectedPage.headers.get("location")).toBe("/destination");

    const permanentPage = await renderNextRequestArtifact(artifact, {
      url: "/?mode=permanent",
    });
    expect(permanentPage.status).toBe(308);
    expect(permanentPage.headers.get("location")).toBe(
      "/permanent-destination",
    );

    const failedPage = await renderNextRequestArtifact(artifact, {
      url: "/?mode=error",
    });
    expect(failedPage.status).toBe(500);
    expect(await failedPage.text()).toContain(
      "lesson-error:<!-- -->page exploded",
    );

    const actionId = (name: string) =>
      Object.entries(artifact.actionManifest).find(
        ([, reference]) => reference.exportName === name,
      )![0];
    const emptyBody = async () =>
      serializeNextActionBody(await rscClient.encodeReply([]));
    const redirectedAction = await invokeNextServerAction(artifact, {
      actionId: actionId("redirectAction"),
      body: await emptyBody(),
    });
    expect(redirectedAction.status).toBe(303);
    expect(redirectedAction.headers.get("location")).toBe("/after-action");
    expect(redirectedAction.headers.get("x-action-redirect")).toContain(
      "/after-action",
    );

    const missingAction = await invokeNextServerAction(artifact, {
      actionId: actionId("missingAction"),
      body: await emptyBody(),
    });
    expect(missingAction.status).toBe(404);
    expect(await missingAction.text()).toBe("Not Found");

    await expect(
      invokeNextServerAction(artifact, {
        actionId: actionId("failingAction"),
        body: await emptyBody(),
      }),
    ).rejects.toThrow("lesson exploded");
  });

  test("preserves nested segment boundaries and precompiled navigation APIs", async () => {
    const artifact = await compileNextRequestWorkspace(boundaryWorkspace(), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "next-segment-boundaries",
    });
    const dashboardRoute = artifact.router.routes.find(
      (route) => route.pattern === "/dashboard",
    );
    expect(dashboardRoute?.boundaries).toEqual([
      {
        directory: "app",
        error: "app/error.tsx",
        notFound: "app/not-found.tsx",
      },
      {
        directory: "app/dashboard",
        error: "app/dashboard/error.tsx",
        loading: "app/dashboard/loading.tsx",
        notFound: "app/dashboard/not-found.tsx",
      },
    ]);

    const loadingShell = await executeNextRequestArtifact(artifact, {
      hydrate: true,
      loading: true,
      url: "/dashboard",
    });
    const loadingHtml = await loadingShell.text();
    expect(loadingShell.status).toBe(200);
    expect(loadingShell.headers.get("x-tuto-next-runtime-kind")).toBe(
      "page-loading",
    );
    expect(loadingHtml).toContain("dashboard-loading");
    expect(loadingHtml).not.toContain("dashboard-ok");

    const flight = await renderNextRequestArtifact(artifact, {
      flight: true,
      url: "/dashboard",
    });
    expect(await flight.text()).toContain("dashboard-loading");

    const pageFailure = await renderNextRequestArtifact(artifact, {
      url: "/dashboard?mode=error",
    });
    const pageFailureHtml = await pageFailure.text();
    expect(pageFailure.status).toBe(500);
    expect(pageFailureHtml).toContain(
      "dashboard-error:<!-- -->dashboard exploded",
    );
    expect(pageFailureHtml).toContain("root-boundary-layout");
    expect(pageFailureHtml).toContain("dashboard-layout");
    expect(pageFailureHtml).not.toContain("root-error");

    const missingPage = await renderNextRequestArtifact(artifact, {
      url: "/dashboard?mode=missing",
    });
    const missingPageHtml = await missingPage.text();
    expect(missingPage.status).toBe(404);
    expect(missingPageHtml).toContain("dashboard-not-found");
    expect(missingPageHtml).toContain("root-boundary-layout");
    expect(missingPageHtml).toContain("dashboard-layout");
    expect(missingPageHtml).not.toContain("root-boundary-not-found");

    const missingLayout = await renderNextRequestArtifact(artifact, {
      url: "/missing-layout",
    });
    const missingLayoutHtml = await missingLayout.text();
    expect(missingLayout.status).toBe(404);
    expect(missingLayoutHtml).toContain("root-boundary-not-found");
    expect(missingLayoutHtml).not.toContain("wrong-layout-not-found");

    const layoutFailure = await renderNextRequestArtifact(artifact, {
      url: "/broken",
    });
    const layoutFailureHtml = await layoutFailure.text();
    expect(layoutFailure.status).toBe(500);
    expect(layoutFailureHtml).toContain(
      "root-error:<!-- -->broken layout exploded",
    );
    expect(layoutFailureHtml).not.toContain("wrong-broken-error");

    const navigation = await renderHydratableNextRequestArtifact(artifact, {
      actionEndpoint: "http://next-action.local/action",
      url: "/navigation?tab=lesson",
    });
    const navigationHtml = await navigation.text();
    expect(navigationHtml).toContain(
      'data-navigation-state="true">/navigation<!-- -->:<!-- -->lesson',
    );
    expect(navigationHtml).toContain(
      "path: path || globalThis.__TUTO_NEXT_URL__",
    );
    expect(navigationHtml).not.toContain("window.location.assign");
  });

  test("uses Next cache APIs with tag, path, and stale-while-revalidate semantics", async () => {
    const artifact = await compileNextRequestWorkspace(cacheWorkspace(), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "cache-lessons",
    });
    const actionId = (exportName: string) => {
      const entry = Object.entries(artifact.actionManifest).find(
        ([, action]) => action.exportName === exportName,
      );
      expect(entry, `missing ${exportName} action`).toBeDefined();
      return entry![0];
    };
    const invoke = async (exportName: string) =>
      invokeNextServerAction(artifact, {
        actionId: actionId(exportName),
        body: await serializeNextActionBody(await rscClient.encodeReply([])),
        url: "/cache",
      });

    const cold = await renderNextRequestArtifact(artifact, { url: "/cache" });
    const coldHtml = await cold.text();
    expect(coldHtml).toContain("tag-read:<!-- -->1");
    expect(coldHtml).toContain("path-read:<!-- -->1");
    expect(coldHtml).toContain("memo-read:<!-- -->1<!-- -->:<!-- -->1");
    expect(cold.headers.get("x-tuto-next-cache")).toContain("miss=2");
    expect(cold.headers.get("x-tuto-next-cache")).toContain("write=2");

    const hot = await renderNextRequestArtifact(artifact, { url: "/cache" });
    const hotHtml = await hot.text();
    expect(hotHtml).toContain("tag-read:<!-- -->1");
    expect(hotHtml).toContain("path-read:<!-- -->1");
    expect(hotHtml).toContain("memo-read:<!-- -->2<!-- -->:<!-- -->2");
    expect(hot.headers.get("x-tuto-next-cache")).toContain("hit=2");

    const expiredTag = await invoke("expireTag");
    const expiredTagFlight = await expiredTag.text();
    expect(expiredTagFlight).toContain("tag-read:");
    expect(expiredTagFlight).toContain("2");
    expect(expiredTag.headers.get("x-tuto-next-cache")).toContain(
      "revalidate=1",
    );
    expect(expiredTag.headers.get("x-tuto-next-cache")).toContain("miss=1");
    expect(expiredTag.headers.get("x-tuto-next-cache")).toContain("hit=1");

    const staleTag = await invoke("staleTag");
    const staleFlight = await staleTag.text();
    expect(staleFlight).toContain("tag-read:");
    expect(staleTag.headers.get("x-tuto-next-cache")).toContain("stale=1");
    expect(staleTag.headers.get("x-tuto-next-cache")).toContain("write=1");

    const refreshed = await renderNextRequestArtifact(artifact, {
      url: "/cache",
    });
    expect(await refreshed.text()).toContain("tag-read:<!-- -->3");

    const expiredPath = await invoke("expirePath");
    const pathFlight = await expiredPath.text();
    expect(pathFlight).toContain("path-read:");
    expect(expiredPath.headers.get("x-tuto-next-cache")).toContain("miss=2");
    expect(expiredPath.headers.get("x-tuto-next-cache")).toContain(
      "revalidate=1",
    );
  });

  test("preserves data cache entries across generations while isolating workspaces", async () => {
    const originalFiles = cacheWorkspace();
    const first = await compileNextRequestWorkspace(originalFiles, {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "cache-generation-a",
    });
    await (await renderNextRequestArtifact(first, { url: "/cache" })).text();

    const editedFiles = originalFiles.map((file) =>
      file.path === "app/cache/page.tsx"
        ? {
            ...file,
            content: `${file.content}\nexport const lessonEdit = "v2";`,
          }
        : file,
    );
    const edited = await compileNextRequestWorkspace(editedFiles, {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "cache-generation-a",
    });
    const reused = await renderNextRequestArtifact(edited, { url: "/cache" });
    expect(edited.generation).not.toBe(first.generation);
    expect(await reused.text()).toContain("tag-read:<!-- -->1");
    expect(reused.headers.get("x-tuto-next-cache")).toContain("hit=2");

    const isolated = await compileNextRequestWorkspace(originalFiles, {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "cache-generation-b",
    });
    const isolatedResponse = await renderNextRequestArtifact(isolated, {
      url: "/cache",
    });
    expect(isolatedResponse.headers.get("x-tuto-next-cache")).toContain(
      "miss=2",
    );
  });

  test("shares durable cache values and invalidation through real RSC/action requests", async () => {
    const coordinator = new MemoryNextCacheInvalidationCoordinator();
    const values = new MemoryNextCacheValueStore();
    setNextCacheAdapter(new DurableNextCacheAdapter({ coordinator, values }));
    const artifact = await compileNextRequestWorkspace(cacheWorkspace(), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "durable-cache-rsc",
    });

    const cold = await renderNextRequestArtifact(artifact, { url: "/cache" });
    expect(await cold.text()).toContain("tag-read:<!-- -->1");
    expect(cold.headers.get("x-tuto-next-cache")).toContain("miss=2");

    setNextCacheAdapter(new DurableNextCacheAdapter({ coordinator, values }));
    const secondHost = await renderNextRequestArtifact(artifact, {
      url: "/cache",
    });
    expect(await secondHost.text()).toContain("tag-read:<!-- -->1");
    expect(secondHost.headers.get("x-tuto-next-cache")).toContain("hit=2");

    const expireTag = Object.entries(artifact.actionManifest).find(
      ([, reference]) => reference.exportName === "expireTag",
    );
    const invalidated = await invokeNextServerAction(artifact, {
      actionId: expireTag![0],
      body: await serializeNextActionBody(await rscClient.encodeReply([])),
      url: "/cache",
    });
    expect(await invalidated.text()).toContain("tag-read:");
    expect(invalidated.headers.get("x-tuto-next-cache")).toContain("miss=1");
    expect(invalidated.headers.get("x-tuto-next-cache")).toContain(
      "revalidate=1",
    );
  });

  test('runs compiler-generated "use cache" entries with cacheLife and cacheTag', async () => {
    const coordinator = new MemoryNextCacheInvalidationCoordinator();
    const values = new MemoryNextCacheValueStore();
    setNextCacheAdapter(new DurableNextCacheAdapter({ coordinator, values }));
    const artifact = await compileNextRequestWorkspace(
      cacheComponentsWorkspace(),
      {
        serverReferenceHashSalt: actionSalt,
        workspaceKey: "cache-components",
      },
    );
    const cacheReferences = Object.values(artifact.actionManifest).filter(
      (reference) => reference.kind === "cache",
    );
    expect(cacheReferences).toHaveLength(2);

    const cold = await renderNextRequestArtifact(artifact, {
      url: "/components",
    });
    const coldHtml = await cold.text();
    expect(coldHtml).toContain("component-read:<!-- -->rsc<!-- -->:<!-- -->1");
    expect(coldHtml).toContain("deduped-read:<!-- -->1");
    expect(coldHtml).toContain("cached-card:<!-- -->rsc<!-- -->:<!-- -->1");
    expect(coldHtml).toContain("data-cached-client");
    expect(cold.headers.get("x-tuto-next-cache")).toContain("miss=2");
    expect(cold.headers.get("x-tuto-next-cache")).toContain("write=2");

    const hot = await renderNextRequestArtifact(artifact, {
      url: "/components",
    });
    expect(await hot.text()).toContain(
      "component-read:<!-- -->rsc<!-- -->:<!-- -->1",
    );
    expect(hot.headers.get("x-tuto-next-cache")).toContain("hit=2");

    const staleAction = Object.entries(artifact.actionManifest).find(
      ([, reference]) => reference.exportName === "staleComponent",
    );
    const stale = await invokeNextServerAction(artifact, {
      actionId: staleAction![0],
      body: await serializeNextActionBody(await rscClient.encodeReply(["rsc"])),
      url: "/components",
    });
    expect(await stale.text()).toContain("1");
    expect(stale.headers.get("x-tuto-next-cache")).toContain("stale=2");
    expect(stale.headers.get("x-tuto-next-cache")).toContain("write=2");

    const refreshed = await renderNextRequestArtifact(artifact, {
      url: "/components",
    });
    expect(await refreshed.text()).toContain(
      "component-read:<!-- -->rsc<!-- -->:<!-- -->2",
    );

    const actionEntry = Object.entries(artifact.actionManifest).find(
      ([, reference]) => reference.exportName === "expireComponent",
    );
    expect(actionEntry?.[1].kind).toBe("action");
    const invalidated = await invokeNextServerAction(artifact, {
      actionId: actionEntry![0],
      body: await serializeNextActionBody(await rscClient.encodeReply(["rsc"])),
      url: "/components",
    });
    expect(await invalidated.text()).toContain("3");
    expect(invalidated.headers.get("x-tuto-next-cache")).toContain("miss=2");
    expect(invalidated.headers.get("x-tuto-next-cache")).toContain(
      "revalidate=1",
    );

    const editedFiles = cacheComponentsWorkspace().map((file) =>
      file.path === "app/components/page.tsx"
        ? {
            ...file,
            content: `${file.content}\nexport const lessonEdit = "v2";`,
          }
        : file,
    );
    const edited = await compileNextRequestWorkspace(editedFiles, {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "cache-components",
    });
    const afterEdit = await renderNextRequestArtifact(edited, {
      url: "/components",
    });
    expect(edited.generation).not.toBe(artifact.generation);
    expect(await afterEdit.text()).toContain(
      "component-read:<!-- -->rsc<!-- -->:<!-- -->1",
    );
    expect(afterEdit.headers.get("x-tuto-next-cache")).toContain("miss=2");
  });

  test("uses Next patched fetch caching and invalidates fetch tags", async () => {
    const coordinator = new MemoryNextCacheInvalidationCoordinator();
    const values = new MemoryNextCacheValueStore();
    setNextCacheAdapter(new DurableNextCacheAdapter({ coordinator, values }));
    let originReads = 0;
    const origin = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ reads: ++originReads }));
    });
    await new Promise<void>((resolve, reject) => {
      origin.once("error", reject);
      origin.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = origin.address();
      if (!address || typeof address === "string") {
        throw new Error("The fetch-cache test server did not expose a port.");
      }
      const artifact = await compileNextRequestWorkspace(
        fetchCacheWorkspace(`http://127.0.0.1:${address.port}/value`),
        {
          serverReferenceHashSalt: actionSalt,
          workspaceKey: "fetch-cache",
        },
      );

      const cold = await renderNextRequestArtifact(artifact, { url: "/fetch" });
      expect(await cold.text()).toContain("fetch-read:<!-- -->1");
      expect(originReads).toBe(1);
      expect(cold.headers.get("x-tuto-next-cache")).toContain("miss=1");
      expect(cold.headers.get("x-tuto-next-cache")).toContain("write=1");

      const hot = await renderNextRequestArtifact(artifact, { url: "/fetch" });
      expect(await hot.text()).toContain("fetch-read:<!-- -->1");
      expect(originReads).toBe(1);
      expect(hot.headers.get("x-tuto-next-cache")).toContain("hit=1");

      const actionEntry = Object.entries(artifact.actionManifest).find(
        ([, reference]) => reference.exportName === "expireFetch",
      );
      const invalidated = await invokeNextServerAction(artifact, {
        actionId: actionEntry![0],
        body: await serializeNextActionBody(await rscClient.encodeReply([])),
        url: "/fetch",
      });
      expect(await invalidated.text()).toContain("2");
      expect(originReads).toBe(2);
      expect(invalidated.headers.get("x-tuto-next-cache")).toContain("miss=1");
    } finally {
      await new Promise<void>((resolve, reject) =>
        origin.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("executes real App Router Route Handlers with Next request APIs and cache invalidation", async () => {
    const artifact = await compileNextRequestWorkspace(
      routeHandlerWorkspace(),
      {
        serverReferenceHashSalt: actionSalt,
        workspaceKey: "route-handler-lessons",
      },
    );
    expect(artifact.router.routes).toEqual([]);
    expect(
      artifact.router.handlers.map((handler) => ({
        handler: handler.handler,
        pattern: handler.pattern,
      })),
    ).toEqual([
      {
        handler: "app/api/lessons/[lessonId]/route.ts",
        pattern: "/api/lessons/[lessonId]",
      },
      { handler: "app/api/stream/route.ts", pattern: "/api/stream" },
    ]);

    const getLesson = () =>
      invokeNextRouteHandler(artifact, {
        headers: {
          cookie: "session=student-a",
          "x-lesson-mode": "guided",
        },
        method: "GET",
        url: "/api/lessons/rsc?mode=practice",
      });
    const cold = await getLesson();
    expect(cold.status).toBe(201);
    expect(cold.headers.get("x-route-kind")).toBe("lesson");
    expect(cold.headers.get("x-tuto-next-route-pattern")).toBe(
      "/api/lessons/[lessonId]",
    );
    expect(cold.headers.get("set-cookie")).toContain("response-cookie");
    expect(cold.headers.get("set-cookie")).toContain("tuto-visited=rsc");
    expect(await cold.json()).toEqual({
      cookie: "student-a",
      header: "guided",
      lesson: { lessonId: "rsc", reads: 1 },
      query: "practice",
    });
    expect(cold.headers.get("x-tuto-next-cache")).toContain("miss=1");

    const hot = await getLesson();
    expect((await hot.json()).lesson.reads).toBe(1);
    expect(hot.headers.get("x-tuto-next-cache")).toContain("hit=1");

    const mutation = await invokeNextRouteHandler(artifact, {
      body: JSON.stringify({ title: "Route Handlers" }),
      headers: { "content-type": "application/json" },
      method: "POST",
      url: "/api/lessons/rsc",
    });
    expect(mutation.status).toBe(202);
    expect(await mutation.json()).toEqual({
      lessonId: "rsc",
      method: "POST",
      title: "Route Handlers",
    });
    expect(mutation.headers.get("x-tuto-next-cache")).toContain("revalidate=1");

    const afterInvalidation = await getLesson();
    expect((await afterInvalidation.json()).lesson.reads).toBe(2);
    expect(afterInvalidation.headers.get("x-tuto-next-cache")).toContain(
      "miss=1",
    );
  });

  test("uses Next method defaults and transports streaming Route Handler responses", async () => {
    const artifact = await compileNextRequestWorkspace(
      routeHandlerWorkspace(),
      {
        serverReferenceHashSalt: actionSalt,
        workspaceKey: "route-handler-methods",
      },
    );
    const url = "/api/lessons/methods";

    const head = await invokeNextRouteHandler(artifact, {
      method: "HEAD",
      url,
    });
    expect(head.status).toBe(201);
    expect(await head.text()).toBe("");
    expect(head.headers.get("x-route-kind")).toBe("lesson");

    const options = await invokeNextRouteHandler(artifact, {
      method: "OPTIONS",
      url,
    });
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe("GET, HEAD, OPTIONS, POST");

    const unsupported = await invokeNextRouteHandler(artifact, {
      method: "DELETE",
      url,
    });
    expect(unsupported.status).toBe(405);

    const invalid = await invokeNextRouteHandler(artifact, {
      method: "TRACE",
      url,
    });
    expect(invalid.status).toBe(400);

    const stream = await invokeNextRouteHandler(artifact, {
      method: "GET",
      url: "/api/stream",
    });
    expect(stream.headers.get("content-type")).toContain("text/plain");
    expect(await stream.text()).toBe("first:second");
  });

  test("runs Next proxy matchers and carries request mutations through pages and rewrites", async () => {
    const artifact = await compileNextRequestWorkspace(proxyWorkspace(), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "proxy-pages",
    });
    expect(artifact.router.proxy).toEqual({
      kind: "proxy",
      modulePath: "proxy.ts",
    });

    const publicPage = await executeNextRequestArtifact(artifact, { url: "/" });
    expect(await publicPage.text()).toContain("public-page");
    expect(publicPage.headers.get("x-tuto-next-proxy")).toBe(
      "matched=0; outcome=next",
    );

    const protectedPage = await executeNextRequestArtifact(artifact, {
      headers: { cookie: "session=student-a" },
      url: "/protected",
    });
    const protectedHtml = await protectedPage.text();
    expect(protectedHtml).toContain("protected:");
    expect(protectedHtml).toContain("/protected");
    expect(protectedHtml).toContain("cookie:<!-- -->continued");
    expect(protectedPage.headers.get("x-proxy-response")).toBe("next");
    expect(protectedPage.headers.get("set-cookie")).toContain(
      "proxy-cookie=continued",
    );

    const skippedGuard = await executeNextRequestArtifact(artifact, {
      url: "/guarded/lesson",
    });
    expect(await skippedGuard.text()).toContain("guarded:<!-- -->skipped");
    expect(skippedGuard.headers.get("x-tuto-next-proxy")).toBe(
      "matched=0; outcome=next",
    );
    const matchedGuard = await executeNextRequestArtifact(artifact, {
      headers: { "x-run-proxy": "yes" },
      url: "/guarded/lesson",
    });
    expect(await matchedGuard.text()).toContain("/guarded/lesson");
    expect(matchedGuard.headers.get("x-tuto-next-proxy")).toBe(
      "matched=1; outcome=next",
    );
    const missingGuard = await executeNextRequestArtifact(artifact, {
      headers: { "x-run-proxy": "yes", "x-skip-proxy": "1" },
      url: "/guarded/lesson",
    });
    expect(missingGuard.headers.get("x-tuto-next-proxy")).toBe(
      "matched=0; outcome=next",
    );

    const rewritten = await executeNextRequestArtifact(artifact, {
      url: "/rewrite",
    });
    const rewriteHtml = await rewritten.text();
    expect(rewriteHtml).toContain("destination:");
    expect(rewriteHtml).toContain("proxy");
    expect(rewriteHtml).toContain("rewrite");
    expect(rewritten.headers.get("x-tuto-next-route-pattern")).toBe(
      "/destination",
    );
    expect(rewritten.headers.get("x-tuto-next-proxy")).toBe(
      "matched=1; outcome=rewrite",
    );
  });

  test("supports proxy redirects, direct responses, Route Handler bodies, and waitUntil", async () => {
    const artifact = await compileNextRequestWorkspace(proxyWorkspace(), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "proxy-responses",
    });

    const redirect = await executeNextRequestArtifact(artifact, {
      url: "/redirect",
    });
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("/login");
    expect(redirect.headers.get("x-tuto-next-runtime-kind")).toBe("proxy");

    const direct = await executeNextRequestArtifact(artifact, {
      headers: { cookie: "session=direct-student" },
      url: "/direct",
    });
    expect(direct.status).toBe(418);
    expect(await direct.json()).toEqual({
      direct: "/direct",
      session: "direct-student",
      waited: false,
    });

    const api = await executeNextRequestArtifact(artifact, {
      body: JSON.stringify({ lesson: "proxy-api" }),
      headers: { "content-type": "application/json" },
      method: "POST",
      url: "/api/echo",
    });
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({
      body: { lesson: "proxy-api" },
      cookie: "continued",
      header: "/api/echo",
    });
    expect(api.headers.get("x-tuto-next-runtime-kind")).toBe("route-handler");

    await (
      await executeNextRequestArtifact(artifact, { url: "/wait/start" })
    ).text();
    const waitStatus = await executeNextRequestArtifact(artifact, {
      url: "/wait/status",
    });
    expect(await waitStatus.json()).toEqual({
      direct: "/wait/status",
      session: null,
      waited: true,
    });
  });

  test("accepts deprecated middleware.ts but rejects multiple proxy entries", async () => {
    const middlewareArtifact = await compileNextRequestWorkspace(
      proxyWorkspace("middleware.ts"),
      {
        serverReferenceHashSalt: actionSalt,
        workspaceKey: "middleware-compatibility",
      },
    );
    expect(middlewareArtifact.router.proxy).toEqual({
      kind: "middleware",
      modulePath: "middleware.ts",
    });
    const response = await executeNextRequestArtifact(middlewareArtifact, {
      url: "/protected",
    });
    expect(await response.text()).toContain("/protected");

    const conflicting = proxyWorkspace();
    conflicting.push(proxyWorkspace("middleware.ts")[0]);
    await expect(
      compileNextRequestWorkspace(conflicting, {
        serverReferenceHashSalt: actionSalt,
        workspaceKey: "proxy-conflict",
      }),
    ).rejects.toThrow(/only one proxy\.ts or middleware\.ts entry/i);

    const invalidMatcherFiles = proxyWorkspace().map((file) =>
      file.path === "proxy.ts"
        ? {
            ...file,
            content: file.content.replace(
              '"/protected/:path*"',
              '"invalid-without-leading-slash"',
            ),
          }
        : file,
    );
    const invalidMatcher = await compileNextRequestWorkspace(
      invalidMatcherFiles,
      {
        serverReferenceHashSalt: actionSalt,
        workspaceKey: "proxy-invalid-matcher",
      },
    );
    await expect(
      executeNextRequestArtifact(invalidMatcher, { url: "/protected" }),
    ).rejects.toThrow(/invalid next proxy config/i);

    const afterInvalidConfig = await executeNextRequestArtifact(
      middlewareArtifact,
      { url: "/protected" },
    );
    expect(await afterInvalidConfig.text()).toContain("/protected");
  });

  test("runs generated Server Actions through proxy continuation and rewrites", async () => {
    const artifact = await compileNextRequestWorkspace(proxyActionWorkspace(), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "proxy-actions",
    });
    const actionEntry = Object.entries(artifact.actionManifest).find(
      ([, reference]) => reference.exportName === "inspectAction",
    );
    expect(actionEntry).toBeDefined();
    const body = await serializeNextActionBody(
      await rscClient.encodeReply(["unit"]),
    );

    const continued = await executeNextServerActionArtifact(artifact, {
      actionId: actionEntry![0],
      body,
      headers: { cookie: "session=student-action" },
      url: "/actions/destination",
    });
    const continuedFlight = await continued.text();
    expect(continued.status).toBe(200);
    expect(continued.headers.get("x-tuto-next-runtime-kind")).toBe(
      "server-action",
    );
    expect(continued.headers.get("x-tuto-next-proxy")).toBe(
      "matched=1; outcome=next",
    );
    expect(continued.headers.get("x-action-proxy-response")).toBe("continued");
    expect(continued.headers.get("set-cookie")).toContain(
      "proxy-action-cookie=continued",
    );
    expect(continued.headers.get("set-cookie")).toContain(
      "action-cookie=written",
    );
    expect(continuedFlight).toContain(
      '"actionResult":"unit|passed|present|continued|student-action"',
    );
    expect(continuedFlight).toContain("destination-action-page");
    expect(continuedFlight).toContain("proxy-cookie:");
    expect(continuedFlight).toContain("action-cookie:");
    expect(continuedFlight).toContain("written");

    const rewritten = await executeNextServerActionArtifact(artifact, {
      actionId: actionEntry![0],
      body,
      url: "/actions/source",
    });
    expect(rewritten.headers.get("x-tuto-next-proxy")).toBe(
      "matched=1; outcome=rewrite",
    );
    expect(rewritten.headers.get("x-tuto-next-route-pattern")).toBe(
      "/actions/destination",
    );
    expect(await rewritten.text()).toContain("destination-action-page");

    const uploadEntry = Object.entries(artifact.actionManifest).find(
      ([, reference]) => reference.exportName === "inspectUpload",
    );
    const upload = await executeNextServerActionArtifact(artifact, {
      actionId: uploadEntry![0],
      body: await serializeNextActionBody(
        await rscClient.encodeReply([
          new File(["flight-file"], "lesson.txt", { type: "text/plain" }),
        ]),
      ),
      url: "/actions/destination",
    });
    expect(await upload.text()).toContain(
      '"actionResult":"lesson.txt|text/plain|flight-file|present"',
    );
  });

  test("short-circuits Server Actions on proxy redirects and direct responses", async () => {
    const artifact = await compileNextRequestWorkspace(proxyActionWorkspace(), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "proxy-action-terminal",
    });
    const actionEntry = Object.entries(artifact.actionManifest).find(
      ([, reference]) => reference.exportName === "inspectAction",
    );
    const body = await serializeNextActionBody(
      await rscClient.encodeReply(["blocked"]),
    );

    const direct = await executeNextServerActionArtifact(artifact, {
      actionId: actionEntry![0],
      body,
      headers: { "x-action-outcome": "response" },
      url: "/actions/destination",
    });
    expect(direct.status).toBe(409);
    expect(direct.headers.get("x-tuto-next-runtime-kind")).toBe("proxy");
    expect(await direct.json()).toEqual({ blockedBy: "action-proxy" });

    const redirect = await executeNextServerActionArtifact(artifact, {
      actionId: actionEntry![0],
      body,
      headers: { "x-action-outcome": "redirect" },
      url: "/actions/destination",
    });
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("/login");

    const removedHeader = await executeNextServerActionArtifact(artifact, {
      actionId: actionEntry![0],
      body,
      headers: { "x-action-outcome": "remove-action-header" },
      url: "/actions/destination",
    });
    expect(removedHeader.status).toBe(400);
    expect(await removedHeader.text()).toMatch(/was not dispatched/i);
  });

  test("virtualizes Server Action cookies at the integrated host boundary", async () => {
    const artifact = await compileNextRequestWorkspace(proxyActionWorkspace(), {
      serverReferenceHashSalt: actionSalt,
      workspaceKey: "proxy-action-transport",
    });
    const actionEntry = Object.entries(artifact.actionManifest).find(
      ([, reference]) => reference.exportName === "inspectAction",
    );
    const response = await requestRoute(
      new Request("http://tuto.local/api/serverless/nextjs-runtime/request", {
        body: JSON.stringify({
          action: {
            actionId: actionEntry![0],
            body: await serializeNextActionBody(
              await rscClient.encodeReply(["transport"]),
            ),
            headers: { cookie: "session=transport-student" },
            revision: artifact.revision,
            url: "/actions/destination",
          },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-tuto-next-proxy")).toBe(
      "matched=1; outcome=next",
    );
    const virtualCookies = JSON.parse(
      Buffer.from(
        response.headers.get("x-tuto-next-virtual-set-cookie")!,
        "base64",
      ).toString("utf8"),
    ) as string[];
    expect(virtualCookies.join("; ")).toContain(
      "proxy-action-cookie=continued",
    );
    expect(virtualCookies.join("; ")).toContain("action-cookie=written");
    expect(await response.text()).toContain(
      '"actionResult":"transport|passed|present|continued|transport-student"',
    );
  });

  test("serves the Tuto workbench template through the integrated request route", async () => {
    const template = getServerlessNextjsRuntimeTemplate();
    expect(template).toBeDefined();
    const requestWorkbench = (
      requestPath: string,
      options: {
        body?: string;
        headers?: Record<string, string>;
        method?: string;
        streamPreview?: boolean;
      } = {},
    ) =>
      requestRoute(
        new Request("http://tuto.local/api/serverless/nextjs-runtime/request", {
          body: JSON.stringify({
            files: template!.files,
            request: {
              body: options.body,
              headers: options.headers,
              method: options.method ?? "GET",
              path: requestPath,
            },
            streamPreview: options.streamPreview,
            workspaceKey: "workbench-checkpoint",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
    const response = await requestWorkbench("/");
    const responseText = await response.text();
    const result = JSON.parse(responseText) as {
      response?: { body?: string; previewUrl?: string };
      success?: boolean;
    };

    expect(response.status, responseText).toBe(200);
    expect(result.success).toBe(true);
    expect(result.response?.body).toContain("Hello from real Next core APIs.");
    expect(result.response?.body).toContain('data-client="counter"');
    expect(result.response?.body).toContain("__TUTO_NEXT_HYDRATED__");
    expect(result.response?.previewUrl).toMatch(/\?preview=/);
    const streamedPreview = await previewRoute(
      new Request(
        new URL(result.response!.previewUrl!, "http://tuto.local"),
      ),
    );
    const streamedHtml = await streamedPreview.text();
    expect(streamedPreview.status).toBe(200);
    expect(streamedPreview.headers.get("content-type")).toContain("text/html");
    expect(streamedHtml).toContain("Hello from real Next core APIs.");
    expect(streamedHtml).toContain("__TUTO_NEXT_HYDRATED__");
    expect(streamedHtml).toContain(
      "tuto-serverless-nextjs-runtime-preview-log",
    );

    const streamingControl = (await (
      await requestWorkbench("/", { streamPreview: true })
    ).json()) as {
      response: { body: string; previewUrl: string };
    };
    expect(streamingControl.response.body).toBe(
      "Preview body is delivered by the streaming URL.",
    );
    const singleRenderPreview = await previewRoute(
      new Request(
        new URL(streamingControl.response.previewUrl, "http://tuto.local"),
      ),
    );
    expect(await singleRenderPreview.text()).toContain(
      "Hello from real Next core APIs.",
    );
    expect(
      await previewRoute(
        new Request(
          "http://tuto.local/api/serverless/nextjs-runtime/request?preview=invalid",
        ),
      ),
    ).toMatchObject({ status: 410 });

    const coldCache = (await (await requestWorkbench("/cache")).json()) as {
      logs: Array<{ message: string }>;
      response: { body: string };
    };
    expect(coldCache.response.body).toContain("Cache and invalidation");
    expect(coldCache.logs.some((log) => log.message.includes("miss=2"))).toBe(
      true,
    );
    const hotCache = (await (await requestWorkbench("/cache")).json()) as {
      logs: Array<{ message: string }>;
    };
    expect(hotCache.logs.some((log) => log.message.includes("hit=2"))).toBe(
      true,
    );

    const apiResult = (await (
      await requestWorkbench("/api/lessons/rsc?mode=practice", {
        headers: {
          cookie: "session=workbench-student",
          "x-request-id": "request-42",
        },
      })
    ).json()) as {
      logs: Array<{ message: string }>;
      response: { body: string; headers: Record<string, string> };
    };
    expect(JSON.parse(apiResult.response.body)).toEqual({
      lesson: { lessonId: "rsc", reads: 1 },
      mode: "practice",
      proxyPath: "/api/lessons/rsc",
      requestId: "request-42",
      session: "workbench-student",
    });
    expect(apiResult.response.headers["set-cookie"]).toContain(
      "last-lesson=rsc",
    );
    expect(
      apiResult.logs.some((log) => log.message.includes("2 Route Handler")),
    ).toBe(true);

    const streamingApiControl = (await (
      await requestWorkbench("/api/lessons/rsc?mode=practice", {
        headers: { "x-request-id": "stream-request" },
        streamPreview: true,
      })
    ).json()) as { response: { body: string; previewUrl: string } };
    expect(streamingApiControl.response.previewUrl).toMatch(/\?preview=/);
    const streamingApi = await previewRoute(
      new Request(
        new URL(streamingApiControl.response.previewUrl, "http://tuto.local"),
      ),
    );
    expect(streamingApi.status).toBe(200);
    expect(await streamingApi.json()).toMatchObject({
      mode: "practice",
      requestId: "stream-request",
    });

    const apiMutation = (await (
      await requestWorkbench("/api/lessons/rsc", {
        body: JSON.stringify({ title: "Web responses" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    ).json()) as { response: { body: string; status: number } };
    expect(apiMutation.response.status).toBe(202);
    expect(JSON.parse(apiMutation.response.body)).toEqual({
      lessonId: "rsc",
      saved: "Web responses",
    });

    const proxyRewrite = (await (
      await requestWorkbench("/proxy-rewrite")
    ).json()) as {
      logs: Array<{ message: string }>;
      response: { body: string };
    };
    expect(proxyRewrite.response.body).toContain("Lesson: <!-- -->rsc");
    expect(proxyRewrite.response.body).toContain("rewritten");
    expect(
      proxyRewrite.logs.some((log) =>
        log.message.includes("matched=1; outcome=rewrite"),
      ),
    ).toBe(true);

    const proxyResponse = (await (
      await requestWorkbench("/proxy-response")
    ).json()) as { response: { body: string; status: number } };
    expect(proxyResponse.response.status).toBe(200);
    expect(JSON.parse(proxyResponse.response.body)).toEqual({
      handledBy: "proxy.ts",
    });

    const proxyRedirect = (await (
      await requestWorkbench("/proxy-redirect")
    ).json()) as {
      response: { headers: Record<string, string>; status: number };
    };
    expect(proxyRedirect.response.status).toBe(307);
    expect(proxyRedirect.response.headers.location).toBe("/");
  });

  test("rejects a server-only dependency below a client boundary", async () => {
    const files = workspace("server-v1");
    files[2] = {
      ...files[2],
      content: `"use client";
import value from './secret';
export default function Counter() { return <p>{value}</p>; }`,
    };
    files.push({
      content: `import 'server-only'; export default 'secret';`,
      language: "ts",
      path: "app/secret.ts",
    });

    await expect(
      compileNextRequestWorkspace(files, {
        serverReferenceHashSalt: actionSalt,
        workspaceKey: "lesson-boundary",
      }),
    ).rejects.toThrow(/client component graph imports a server-only module/i);
  });
});
