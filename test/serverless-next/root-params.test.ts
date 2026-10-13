import { afterAll, expect, test } from "vitest";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import { buildNextRouteManifest } from "../../lib/serverless-next/route-manifest";
import { closeNextRscWorkerPoolForTests } from "../../lib/serverless-next/rsc-worker-pool";
import { closeNextSsrWorkerPoolForTests } from "../../lib/serverless-next/ssr-worker-pool";
import { rootParamsWorkspace } from "./fixtures/root-params-workspace";

const salt = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
function jsonOutput(html: string, attribute: string) {
  const text = new RegExp(`<output[^>]*${attribute}[^>]*>(.*?)</output>`).exec(html)![1];
  return JSON.parse(text.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));
}
afterAll(async () => { await closeNextRscWorkerPoolForTests(); await closeNextSsrWorkerPoolForTests(); });

test("root names stop at the first layout and exclude private/slot roots", () => {
  const paths = ["app/(one)/[locale]/[tenant]/layout.tsx", "app/(one)/[locale]/[tenant]/items/[id]/layout.tsx", "app/(one)/[locale]/[tenant]/items/[id]/page.tsx",
    "app/(two)/other/[region]/layout.tsx", "app/(two)/other/[region]/page.tsx", "app/_private/[hidden]/layout.tsx", "app/(one)/[locale]/[tenant]/@side/[slotOnly]/layout.tsx"];
  const manifest = buildNextRouteManifest(paths);
  expect(manifest.rootParamNames).toEqual(["locale", "region", "tenant"]);
  expect(manifest.routes.find(route => route.page.includes("items"))?.rootParamNames).toEqual(["locale", "tenant"]);
  expect(buildNextRouteManifest([...paths, "app/layout.tsx"]).rootParamNames).toEqual([]);
  expect(() => buildNextRouteManifest(["app/[id]/layout.tsx", "app/[id]/child/[id]/page.tsx"])).toThrow(/repeat the dynamic parameter/);
});

test("real root getters, root-layout props and nested cache partitions exclude leaf params", async () => {
  const artifact = await compileNextRequestWorkspace(rootParamsWorkspace(), { workspaceKey: "root-params-values", serverReferenceHashSalt: salt });
  expect(artifact.router.rootParamNames).toEqual(["parts", "region", "tenant"]);
  async function render(url: string) { return (await executeNextRequestArtifact(artifact, { url })).text(); }
  const first = await render("/alpha/items/one");
  expect(jsonOutput(first, "data-root-layout-params")).toEqual({ tenant: "alpha" });
  expect(jsonOutput(first, "data-leaf-params")).toEqual({ tenant: "alpha", id: "one" });
  expect(jsonOutput(first, "data-root-values")).toEqual({ tenant: "alpha" });
  expect(first).toContain('&quot;tenant&quot;:&quot;alpha&quot;');
  expect(first).toContain('data-slot-root');
  expect(first).toContain('&quot;count&quot;:1');
  const loading = await executeNextRequestArtifact(artifact, { url: "/alpha/items/one", loading: true });
  expect(loading.headers.get("x-tuto-next-runtime-kind")).toBe("page-loading");
  expect(/<p[^>]*data-root-loading[^>]*>alpha<\/p>/.test(await loading.text())).toBe(true);
  const sibling = await render("/alpha/items/two");
  expect(sibling).toContain('&quot;count&quot;:1');
  const other = await render("/beta/items/one");
  expect(other).toContain('&quot;tenant&quot;:&quot;beta&quot;');
  expect(other).toContain('&quot;count&quot;:1');
  const region = await render("/other/west");
  expect(jsonOutput(region, "data-root-values")).toEqual({ region: "west" });
  expect(region).toContain('&quot;region&quot;:&quot;west&quot;');
  expect(region).toContain('&quot;count&quot;:1');
  const catchall = await render("/bag/red/blue");
  expect(jsonOutput(catchall, "data-root-values")).toEqual({ parts: ["red", "blue"] });
  expect(catchall).toContain('&quot;parts&quot;:[&quot;red&quot;,&quot;blue&quot;]');
  expect(catchall).toContain('&quot;count&quot;:1');
  const mutation = await executeNextRequestArtifact(artifact, { url: "/api/invalidate", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "tenant", value: "alpha" }) });
  expect(mutation.status).toBe(200);
  expect(await render("/alpha/items/one")).toContain('&quot;count&quot;:2');
  expect(await render("/beta/items/one")).toContain('&quot;count&quot;:1');
  const handler = await executeNextRequestArtifact(artifact, { url: "/api/roots" });
  expect(handler.status).toBe(400);
  expect((await handler.json()).message).toContain("inside a Route Handler");
  const cachedHandler = await executeNextRequestArtifact(artifact, { url: "/api/roots?cache" });
  expect(cachedHandler.status).toBe(200);
  expect(await cachedHandler.json()).toEqual({ value: { count: 1 } });
  const warmCachedHandler = await executeNextRequestArtifact(artifact, { url: "/api/roots?cache" });
  expect(await warmCachedHandler.json()).toEqual({ value: { count: 1 } });
  expect(await render("/beta/items/two")).toContain('&quot;count&quot;:1');
  const isolated = await compileNextRequestWorkspace(rootParamsWorkspace(), { workspaceKey: "root-params-isolated", serverReferenceHashSalt: salt });
  const isolatedHtml = await (await executeNextRequestArtifact(isolated, { url: "/alpha/items/one", headers: { "x-tenant": "beta" } })).text();
  expect(jsonOutput(isolatedHtml, "data-root-cache")).toEqual({ tenant: "alpha", count: 1 });
});

test("root-params bindings fail at compile time for leaf names and client value imports", async () => {
  const files = rootParamsWorkspace();
  const page = files.find(file => file.path.endsWith("items/[id]/page.tsx") && !file.path.includes("@"))!;
  page.content = 'import {id} from "next/root-params";export default async function Page(){return <p>{await id()}</p>;}';
  await expect(compileNextRequestWorkspace(files, { workspaceKey: "root-params-invalid-binding", serverReferenceHashSalt: salt })).rejects.toThrow(/No matching export.*id/);
  page.content = '"use client";import {tenant} from "next/root-params";export default function Page(){return <p>{String(tenant)}</p>;}';
  await expect(compileNextRequestWorkspace(files, { workspaceKey: "root-params-invalid-client", serverReferenceHashSalt: salt })).rejects.toThrow(/server-only next\/root-params/);
  page.content = '"use client";import type {tenant} from "next/root-params";type Tenant=Awaited<ReturnType<typeof tenant>>;export default function Page(){const text:Tenant="type-only";return <p>{text}</p>;}';
  await expect(compileNextRequestWorkspace(files, { workspaceKey: "root-params-type-only", serverReferenceHashSalt: salt })).resolves.toBeDefined();
});

test("intercepted root getters use the retained primary root instead of the target URL", async () => {
  const artifact = await compileNextRequestWorkspace(rootParamsWorkspace(), { workspaceKey: "root-params-intercept", serverReferenceHashSalt: salt });
  const response = await executeNextRequestArtifact(artifact, { url: "/beta/photo/seven", headers: { "next-url": "/alpha/items/one" } });
  const html = await response.text();
  expect(jsonOutput(html, "data-root-layout-params")).toEqual({ tenant: "alpha" });
  expect(jsonOutput(html, "data-root-values")).toEqual({ tenant: "alpha" });
  expect(/data-modal-root[^>]*>alpha<\/output>/.test(html)).toBe(true);
  expect(jsonOutput(html, "data-modal-params")).toEqual({ tenant: "beta", photoId: "seven" });
  const canonical = await executeNextRequestArtifact(artifact, { url: "/beta/photo/seven" });
  expect(jsonOutput(await canonical.text(), "data-canonical-root")).toEqual({ tenant: "beta" });
});

test("root getters inside unstable_cache reject without poisoning the next page render", async () => {
  const files = rootParamsWorkspace();
  files.find(file => file.path.endsWith("items/[id]/page.tsx") && !file.path.includes("@"))!.content = 'import {tenant} from "next/root-params";import {unstable_cache} from "next/cache";const unsafe=unstable_cache(async()=>tenant(),["root-unsafe"]);export default async function Page(){try{return <p>{await unsafe()}</p>;}catch(error){return <output data-blocked>{error.message}</output>;}}';
  const artifact = await compileNextRequestWorkspace(files, { workspaceKey: "root-params-unstable", serverReferenceHashSalt: salt });
  expect(await (await executeNextRequestArtifact(artifact, { url: "/alpha/items/one" })).text()).toContain('inside `unstable_cache`');
  expect(await (await executeNextRequestArtifact(artifact, { url: "/other/west" })).text()).toContain('&quot;region&quot;:&quot;west&quot;');
});

test("prototype-named root parameters stay own data properties", async () => {
  const artifact = await compileNextRequestWorkspace([
    { path: "app/[__proto__]/layout.tsx", language: "tsx", content: 'export default function Layout({children}){return <html><body>{children}</body></html>;}' },
    { path: "app/[__proto__]/page.tsx", language: "tsx", content: 'import {__proto__ as root} from "next/root-params";export default async function Page(){return <output>{await root()}</output>;}' },
  ], { workspaceKey: "root-params-prototype", serverReferenceHashSalt: salt });
  expect(await (await executeNextRequestArtifact(artifact, { url: "/owned-value" })).text()).toContain("owned-value");
});
