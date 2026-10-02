import { afterAll, beforeAll, expect, test } from "vitest";
import { createRequire } from "node:module";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { renderNextRequestArtifact } from "../../lib/serverless-next/runtime";
import { closeNextRscWorkerPoolForTests } from "../../lib/serverless-next/rsc-worker-pool";
import { closeNextSsrWorkerPoolForTests } from "../../lib/serverless-next/ssr-worker-pool";
import type { WorkspaceFile } from "../../lib/ide/types";
import { executeNextRequestArtifact } from "../../lib/serverless-next/runtime";
import { cacheContextWorkspace } from "./fixtures/cache-context-workspace";

const require = createRequire(import.meta.url);
const {
  createCompatibleAsyncLocalStorage,
  contextualAsyncToGenerator,
} = require("../../lib/serverless-next/async-context-compat.cjs");
class SynchronousStorage {}
const oldMode = process.env.TUTO_NEXT_EXECUTION_MODE;
beforeAll(() => {
  process.env.TUTO_NEXT_EXECUTION_MODE = "secure-exec";
});
afterAll(async () => {
  await closeNextRscWorkerPoolForTests();
  await closeNextSsrWorkerPoolForTests();
  if (oldMode === undefined) delete process.env.TUTO_NEXT_EXECUTION_MODE;
  else process.env.TUTO_NEXT_EXECUTION_MODE = oldMode;
});

test("settling an earlier framework scope cannot erase an overlapping active scope", async () => {
  const Storage = createCompatibleAsyncLocalStorage(SynchronousStorage),
    storage = new Storage();
  storage.enterWith("root");
  let releaseA!: () => void, releaseB!: () => void;
  const a = storage.run(
    "a",
    () =>
      new Promise<void>((resolve) => {
        releaseA = resolve;
      }),
  );
  const b = storage.run(
    "b",
    () =>
      new Promise<void>((resolve) => {
        releaseB = resolve;
      }),
  );
  releaseA();
  await a;
  expect(storage.getStore()).toBe("b");
  releaseB();
  await b;
  expect(storage.getStore()).toBe("root");
});

test("a clean snapshot releases its entry frame while a nested cache fill owns its lifetime", async () => {
  const Storage = createCompatibleAsyncLocalStorage(SynchronousStorage),
    storage = new Storage();
  const clean = Storage.snapshot();
  storage.enterWith("request");
  let release!: () => void;
  const pending = clean(() =>
    storage.run(
      "cache",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    ),
  );
  expect(storage.getStore()).toBe("cache");
  release();
  await pending;
  expect(storage.getStore()).toBe("request");
  expect(() =>
    clean(() => {
      throw new Error("cache failure");
    }),
  ).toThrow("cache failure");
  expect(storage.getStore()).toBe("request");
});

test("compiled continuations restore their invocation scope, receiver and caught rejection", async () => {
  const Storage = createCompatibleAsyncLocalStorage(SynchronousStorage);
  const storage = new Storage();
  const previous = globalThis.AsyncLocalStorage;
  globalThis.AsyncLocalStorage = Storage;
  try {
    storage.enterWith("root");
    let releaseA!: () => void, releaseB!: () => void;
    const pendingA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const pendingB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const continuation = contextualAsyncToGenerator(function* (
      this: { prefix: string },
      pending: Promise<void>,
    ) {
      yield pending;
      const resumed = storage.getStore();
      try {
        yield Promise.reject(new Error("expected"));
      } catch (error) {
        expect((error as Error).message).toBe("expected");
      }
      return this.prefix + ":" + resumed + ":" + storage.getStore();
    });
    const a = storage.run("a", () =>
      continuation.call({ prefix: "A" }, pendingA),
    );
    const b = storage.run("b", () =>
      continuation.call({ prefix: "B" }, pendingB),
    );
    releaseA();
    expect(await a).toBe("A:a:a");
    expect(storage.getStore()).toBe("b");
    releaseB();
    expect(await b).toBe("B:b:b");
    expect(storage.getStore()).toBe("root");
  } finally {
    globalThis.AsyncLocalStorage = previous;
  }
});

function files(content: string): WorkspaceFile[] {
  return [
    {
      path: "app/layout.tsx",
      language: "tsx",
      content:
        "export default function Layout({children}){return <html><body>{children}</body></html>;}",
    },
    { path: "app/page.tsx", language: "tsx", content },
  ];
}
const salt = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

test("parallel cached descendants and delayed uncached request reads retain their own scopes", async () => {
  const artifact = await compileNextRequestWorkspace(
    files(`import {Suspense} from "react";import {cacheTag,cacheLife} from "next/cache";import {headers} from "next/headers";
async function Cached({id,delay}){"use cache";cacheLife("hours");await new Promise(resolve=>setTimeout(resolve,delay));cacheTag("card-"+id);return <p>cached:{id}</p>;}
async function Request(){await new Promise(resolve=>setTimeout(resolve,10));return <p>tenant:{(await headers()).get("x-tenant")}</p>;}
export default function Page(){return <><Suspense fallback="cache a"><Cached id="a" delay={30} /></Suspense><Suspense fallback="cache b"><Cached id="b" delay={50} /></Suspense><Suspense fallback="request"><Request /></Suspense></>;}`),
    { workspaceKey: "parallel-cache-scopes", serverReferenceHashSalt: salt },
  );
  const response = await renderNextRequestArtifact(artifact, {
    headers: { "x-tenant": "one" },
  });
  const html = await response.text();
  expect(html).toContain("cached:<!-- -->a");
  expect(html).toContain("cached:<!-- -->b");
  expect(html).toContain("tenant:<!-- -->one");
  const second = await renderNextRequestArtifact(artifact, {
    headers: { "x-tenant": "two" },
  });
  expect(await second.text()).toContain("tenant:<!-- -->two");
});

test("public cache scopes reject request cookies after an asynchronous delay", async () => {
  const artifact = await compileNextRequestWorkspace(
    files(`import {cookies} from "next/headers";import {cacheLife} from "next/cache";
async function Secret(){"use cache";cacheLife("hours");await new Promise(resolve=>setTimeout(resolve,10));return (await cookies()).get("session")?.value;}
export default async function Page(){return <p>{await Secret()}</p>;}`),
    { workspaceKey: "public-cache-cookies", serverReferenceHashSalt: salt },
  );
  await expect(
    renderNextRequestArtifact(artifact, {
      headers: { cookie: "session=private" },
    }),
  ).rejects.toThrow(/cookies|cache/i);
});

test.each([
  "then",
  "timer",
  "finally",
  "async-generator",
  "microtask",
  "nextTick",
])(
  "public cache scopes reject request cookies in a %s callback",
  async (kind) => {
    const reads: Record<string, string> = {
      then: 'return new Promise(resolve=>setTimeout(resolve,10)).then(()=>cookies()).then(jar=>jar.get("session")?.value);',
      timer:
        'return new Promise((resolve,reject)=>setTimeout(()=>{try{cookies().then(jar=>resolve(jar.get("session")?.value),reject);}catch(error){reject(error);}},10));',
      finally:
        "return new Promise(resolve=>setTimeout(resolve,10)).finally(()=>cookies());",
      "async-generator":
        'async function* values(){await new Promise(resolve=>setTimeout(resolve,10));yield (await cookies()).get("session")?.value;}for await(const value of values())return value;',
      microtask:
        "return new Promise((resolve,reject)=>queueMicrotask(()=>{try{cookies().then(resolve,reject);}catch(error){reject(error);}}));",
      nextTick:
        "return new Promise((resolve,reject)=>process.nextTick(()=>{try{cookies().then(resolve,reject);}catch(error){reject(error);}}));",
    };
    const read = reads[kind];
    const artifact = await compileNextRequestWorkspace(
      files(`import {cookies} from "next/headers";import {cacheLife} from "next/cache";
async function Secret(){"use cache";cacheLife("hours");${read}}
export default async function Page(){return <p>{await Secret()}</p>;}`),
      {
        workspaceKey: "public-cache-cookies-" + kind,
        serverReferenceHashSalt: salt,
      },
    );
    await expect(
      renderNextRequestArtifact(artifact, {
        headers: { cookie: "session=private" },
      }),
    ).rejects.toThrow(/cookies|cache/i);
  },
);

test.each(["child-process", "secure-exec"])(
  "%s nested cached components retain tags, request isolation and warm values",
  async (mode) => {
    process.env.TUTO_NEXT_EXECUTION_MODE = mode;
    try {
      const artifact = await compileNextRequestWorkspace(
        cacheContextWorkspace(),
        { workspaceKey: "nested-cache-" + mode, serverReferenceHashSalt: salt },
      );
      const request = {
        url: "/cards",
        headers: { "x-tenant": "one", cookie: "session=private-one" },
      };
      const render = async (headers = request.headers) => {
        const response = await renderNextRequestArtifact(artifact, {
          ...request,
          headers,
        });
        return { response, html: await response.text() };
      };
      const cold = await render();
      expect(cold.html).toContain("a:one:1");
      expect(cold.html).toContain("b:one:1");
      expect(cold.html).toContain("private-one");
      expect(cold.response.headers.get("x-tuto-next-cache")).toContain(
        "write=4",
      );
      const warm = await render();
      expect(warm.html).toContain("a:one:1");
      expect(warm.response.headers.get("x-tuto-next-cache")).toContain("hit=2");
      const mutation = await executeNextRequestArtifact(artifact, {
        url: "/api/revalidate",
        method: "POST",
        body: '{"id":"a"}',
        headers: { "content-type": "application/json" },
      });
      expect(mutation.status).toBe(200);
      await mutation.text();
      const fresh = await render({
        "x-tenant": "one",
        cookie: "session=private-two",
      });
      expect(fresh.html).toContain("a:one:2");
      expect(fresh.html).toContain("b:one:1");
      expect(fresh.html).toContain("private-two");
      expect(fresh.html).not.toContain("private-one");
      const anotherTenant = await render({
        "x-tenant": "two",
        cookie: "session=private-three",
      });
      expect(anotherTenant.html).toContain("a:two:1");
      expect(anotherTenant.html).toContain("b:two:1");
      expect(anotherTenant.html).toContain("private-three");
      for (const kind of ["await", "then", "timer"]) {
        await expect(
          executeNextRequestArtifact(artifact, {
            url: "/api/unsafe?kind=" + kind,
            headers: { cookie: "session=secret" },
          }),
        ).rejects.toThrow(/cookies\(\).*cache/i);
        const recovered = await render({
          "x-tenant": "one",
          cookie: "session=after-failure",
        });
        expect(recovered.html).toContain("after-failure");
        expect(recovered.html).toContain("a:one:2");
      }
    } finally {
      await closeNextRscWorkerPoolForTests();
      await closeNextSsrWorkerPoolForTests();
      process.env.TUTO_NEXT_EXECUTION_MODE = "secure-exec";
    }
  },
);
