import { afterAll, expect, test } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import { closeNextRscWorkerPoolForTests } from "../../lib/serverless-next/rsc-worker-pool";
import { closeNextSsrWorkerPoolForTests } from "../../lib/serverless-next/ssr-worker-pool";
import { POST } from "../../app/api/serverless/nextjs-runtime/request/route";
import type { NextNavigationRequest, NextRouterState } from "../../lib/serverless-next/navigation";
import { persistentNavigationWorkspace } from "./fixtures/persistent-navigation-workspace";

const requireRuntime = createRequire(path.join(process.cwd(), "package.json"));
(globalThis as typeof globalThis & {__webpack_require__?: () => unknown}).__webpack_require__ ??= () => undefined;
const client = requireRuntime("next/dist/compiled/react-server-dom-webpack/client.browser") as {
  createFromReadableStream(body: ReadableStream<Uint8Array>, options: object): Promise<{state: NextRouterState}>;
};
afterAll(async () => { await closeNextRscWorkerPoolForTests(); await closeNextSsrWorkerPoolForTests(); });

async function compile() {
  return compileNextRequestWorkspace(persistentNavigationWorkspace(), {
    serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    workspaceKey: "navigation-unit",
  });
}

test("returns independently selected nested slot state and restores it without rematching the visible URL", async () => {
  const artifact = await compile();
  async function navigate(url: string, navigation: NextNavigationRequest) {
    const response = await executeNextRequestArtifact(artifact, {url, navigation});
    expect(response.headers.get("content-type")).toContain("text/x-component");
    return client.createFromReadableStream(response.body!, {});
  }
  const home = await navigate("/dashboard", {kind:"push"});
  const settings = await navigate("/dashboard/settings?tab=team", {kind:"push", state:home.state});
  const views = await navigate("/dashboard/views", {kind:"push", state:settings.state});
  expect(views.state.slots["app/dashboard/@team"].page).toBe("app/dashboard/@team/settings/page.tsx");
  expect(views.state.slots["app/dashboard/@team/@detail"].url).toBe("/dashboard/settings?tab=team");
  expect(views.state.slots["app/dashboard/@analytics"].page).toBe("app/dashboard/@analytics/views/page.tsx");
  expect((await navigate("/dashboard/settings?tab=team", {kind:"restore", state:settings.state})).state.slots["app/dashboard/@analytics"].page).toBe("app/dashboard/@analytics/page.tsx");
  const modal = await navigate("/photo/7", {kind:"push", state:views.state});
  expect(modal.state.primary.page).toBe("app/dashboard/views/page.tsx");
  expect(modal.state.slots["app/@modal"].intercepted).toBe(true);
  expect((await navigate("/photo/7", {kind:"refresh", state:modal.state})).state).toEqual(modal.state);
});

test("rejects stale, unknown, external and mismatched branch state through the actual request endpoint", async () => {
  const artifact = await compile();
  const response = await executeNextRequestArtifact(artifact, {url:"/dashboard", navigation:{kind:"push"}});
  const {state} = await client.createFromReadableStream(response.body!, {});
  for (const invalid of [
    {...state, revision:"stale"},
    {...state, primary:{...state.primary, page:"../../private.ts"}},
    {...state, primary:{...state.primary, url:"https://outside.example/"}},
    {...state, slots:{"app/@unknown": state.primary}},
    {...state, primary:{...state.primary, url:"/photo/7"}},
  ]) {
    const rejected = await POST(new Request("http://tuto.local/request", {
      body:JSON.stringify({navigation:{kind:"refresh", revision:artifact.revision, url:"/dashboard", state:invalid}}),
      method:"POST", headers:{"content-type":"text/plain;charset=UTF-8"},
    }));
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(rejected.headers.get("access-control-allow-origin")).toBe("*");
    expect(rejected.headers.get("content-type")).not.toContain("text/x-component");
  }
});

test("drops retained nested branches when a dynamic layout owner changes", async () => {
  const files = persistentNavigationWorkspace().map((file) => ({
    ...file, path:file.path.replace("app/dashboard/", "app/dashboard/[project]/"),
    // Moves imports with the fixture so this is a real compiled owner tree.
    content:file.path.startsWith("app/dashboard/") ? file.content.replaceAll('from "../', 'from "../../') : file.content,
  }));
  const artifact = await compileNextRequestWorkspace(files, {workspaceKey:"navigation-dynamic-owner", serverReferenceHashSalt:"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="});
  async function nav(url: string, state?: NextRouterState) {
    const response = await executeNextRequestArtifact(artifact, {url, navigation:{kind:"push", state}});
    return client.createFromReadableStream(response.body!, {});
  }
  const first = await nav("/dashboard/alpha");
  const settings = await nav("/dashboard/alpha/settings", first.state);
  const second = await nav("/dashboard/beta/views", settings.state);
  expect(second.state.slots["app/dashboard/[project]/@team"].page).toBe("app/dashboard/[project]/@team/default.tsx");
  expect(second.state.slots["app/dashboard/[project]/@team/@detail"]).toBeUndefined();
  expect(second.state.primary.url).toBe("/dashboard/beta/views");
});

test("returns a navigation shell before primary and nested slot Flight chunks resolve", async () => {
  const {streamedNavigationWorkspace} = await import("./fixtures/streamed-navigation-workspace");
  const artifact = await compileNextRequestWorkspace(streamedNavigationWorkspace(), {
    workspaceKey:"streamed-navigation-unit", serverReferenceHashSalt:"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  });
  const home = await executeNextRequestArtifact(artifact, {url:"/dashboard",navigation:{kind:"push"}});
  const {state} = await client.createFromReadableStream(home.body!, {});
  const response = await executeNextRequestArtifact(artifact, {
    url:"/dashboard/slow", navigation:{kind:"push",state,id:"stream-unit"}, stream:true,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/x-component");
  const reader = response.body!.getReader();
  let shell = "";
  let chunks = 0;
  while (!shell.includes("loading primary")) {
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    shell += new TextDecoder().decode(chunk.value);
    chunks++;
  }
  expect(shell).toContain("stream-unit");
  expect(shell).not.toContain('"stream details"');
  let complete = shell;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    complete += new TextDecoder().decode(chunk.value);
    chunks++;
  }
  expect(complete).toContain('"stream details"');
  expect(complete).toContain('"detail-slow"');
  expect(chunks).toBeGreaterThan(1);
});

test("cancels a partially consumed navigation stream and releases its worker for refresh", async () => {
  const {streamedNavigationWorkspace} = await import("./fixtures/streamed-navigation-workspace");
  const artifact = await compileNextRequestWorkspace(streamedNavigationWorkspace(), {
    workspaceKey:"streamed-navigation-cancel-unit", serverReferenceHashSalt:"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  });
  const response = await executeNextRequestArtifact(artifact, {
    url:"/dashboard/slow", navigation:{kind:"push",id:"cancel-unit"}, stream:true,
  });
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel("superseded navigation");
  const refreshed = await executeNextRequestArtifact(artifact, {
    url:"/dashboard", navigation:{kind:"refresh",id:"refresh-unit"}, stream:true,
  });
  const {state} = await client.createFromReadableStream(refreshed.body!, {});
  expect(state.navigationId).toBe("refresh-unit");
  expect(state.primary.page).toBe("app/dashboard/page.tsx");
});
