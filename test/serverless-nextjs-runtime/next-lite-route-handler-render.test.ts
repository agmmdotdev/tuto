import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildNextLiteApp,
  loadNextLiteRenderer,
} from "@/lib/serverless-nextjs-runtime/next-lite";

const fixtureRoots: string[] = [];

async function createFixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tuto-next-lite-route-handler-"));
  fixtureRoots.push(root);

  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, filePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
  }

  return root;
}

async function buildRenderer(root: string) {
  const artifact = await buildNextLiteApp({
    workspaceRoot: root,
    outDir: path.join(root, ".next-lite"),
  });
  return {
    artifact,
    renderer: await loadNextLiteRenderer(artifact),
  };
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("next-lite route handler render", () => {
  it("executes a static GET route handler", async () => {
    const root = await createFixture({
      "app/api/health/route.ts": `export function GET() {
  return Response.json({ ok: true });
}
`,
    });

    const { artifact, renderer } = await buildRenderer(root);
    const response = await renderer.renderNextLiteRequest(
      new Request("http://next-lite.test/api/health"),
    );

    expect(artifact.routes).toContainEqual(
      expect.objectContaining({ kind: "route-handler", pathname: "/api/health" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("passes decoded dynamic params into route handlers", async () => {
    const root = await createFixture({
      "app/api/posts/[postId]/route.ts": `export function GET(_request: Request, context: { params: { postId: string } }) {
  return Response.json({ postId: context.params.postId });
}
`,
    });

    const { renderer } = await buildRenderer(root);
    const response = await renderer.renderNextLiteRequest(
      new Request("http://next-lite.test/api/posts/hello%20world"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ postId: "hello world" });
  });

  it("passes the original Request object to route handlers", async () => {
    const root = await createFixture({
      "app/api/echo/route.ts": `export async function POST(request: Request) {
  const body = await request.text();
  const url = new URL(request.url);
  return new Response(url.searchParams.get("prefix") + ":" + body);
}
`,
    });

    const { renderer } = await buildRenderer(root);
    const response = await renderer.renderNextLiteRequest(
      new Request("http://next-lite.test/api/echo?prefix=body", {
        method: "POST",
        body: "hello",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body:hello");
  });

  it("auto-responds to HEAD with the GET handler headers and no body", async () => {
    const root = await createFixture({
      "app/api/head/route.ts": `export function GET() {
  return new Response("body should be stripped", {
    headers: { "x-source": "get" },
  });
}
`,
    });

    const { renderer } = await buildRenderer(root);
    const response = await renderer.renderNextLiteRequest(
      new Request("http://next-lite.test/api/head", { method: "HEAD" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-source")).toBe("get");
    expect(await response.text()).toBe("");
  });

  it("auto-responds to OPTIONS with an Allow header when no OPTIONS export exists", async () => {
    const root = await createFixture({
      "app/api/options/route.ts": `export function GET() {
  return new Response("ok");
}
`,
    });

    const { renderer } = await buildRenderer(root);
    const response = await renderer.renderNextLiteRequest(
      new Request("http://next-lite.test/api/options", { method: "OPTIONS" }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect(await response.text()).toBe("");
  });

  it("returns 405 and Allow for recognized methods that are not exported", async () => {
    const root = await createFixture({
      "app/api/methods/route.ts": `export function GET() {
  return new Response("ok");
}

export function POST() {
  return new Response("created", { status: 201 });
}
`,
    });

    const { renderer } = await buildRenderer(root);
    const response = await renderer.renderNextLiteRequest(
      new Request("http://next-lite.test/api/methods", { method: "PUT" }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS, POST");
    expect(await response.text()).toBe("Method not allowed");
  });

  it("returns 400 for unsupported HTTP methods", async () => {
    const root = await createFixture({
      "app/api/methods/route.ts": `export function GET() {
  return new Response("ok");
}
`,
    });

    const { renderer } = await buildRenderer(root);
    const response = await renderer.renderNextLiteRequest(
      new Request("http://next-lite.test/api/methods", { method: "FOO" }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Bad request");
  });

  it("supports NextResponse.json() from next/server", async () => {
    const root = await createFixture({
      "app/api/next-response/route.ts": `import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json(
    { ok: true },
    { status: 201, headers: { "x-source": "next-response" } },
  );
}
`,
    });

    const { renderer } = await buildRenderer(root);
    const response = await renderer.renderNextLiteRequest(
      new Request("http://next-lite.test/api/next-response"),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-source")).toBe("next-response");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("supports NextResponse.redirect() from next/server", async () => {
    const root = await createFixture({
      "app/api/redirect/route.ts": `import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.redirect("https://example.com/login", 308);
}
`,
    });

    const { renderer } = await buildRenderer(root);
    const response = await renderer.renderNextLiteRequest(
      new Request("http://next-lite.test/api/redirect"),
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://example.com/login");
    expect(await response.text()).toBe("");
  });

  it("does not expose NextRequest from the lightweight next/server shim", async () => {
    const root = await createFixture({
      "app/api/request/route.ts": `import { NextRequest, NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ requestType: typeof NextRequest });
}
`,
    });

    await expect(
      buildNextLiteApp({
        workspaceRoot: root,
        outDir: path.join(root, ".next-lite"),
      }),
    ).rejects.toThrow(/NextRequest|No matching export/);
  });
});
