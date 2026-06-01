import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildNextLiteApp,
  discoverNextLiteRoutes,
  loadNextLiteRenderer,
} from "@/lib/serverless-nextjs-runtime/next-lite";

const fixtureRoots: string[] = [];

async function createFixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tuto-next-lite-"));
  fixtureRoots.push(root);

  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, filePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
  }

  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("next-lite static App Router render", () => {
  it("discovers the root app page and layout", async () => {
    const root = await createFixture({
      "app/layout.tsx": `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      "app/page.tsx": `export default function Page() {
  return <main>Hello from next-lite</main>;
}
`,
    });

    const routes = await discoverNextLiteRoutes(root);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      kind: "page",
      pathname: "/",
      pattern: "",
      patternParts: [],
    });
    expect(routes[0]?.pageFile).toBe(path.join(root, "app", "page.tsx"));
    expect(routes[0]?.layoutFile).toBe(path.join(root, "app", "layout.tsx"));
    expect(routes[0]?.layoutFiles).toEqual([path.join(root, "app", "layout.tsx")]);
  });

  it("builds a server artifact that renders app/layout.tsx around app/page.tsx", async () => {
    const root = await createFixture({
      "app/layout.tsx": `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body><section data-shell="root">{children}</section></body></html>;
}
`,
      "app/page.tsx": `export default function Page() {
  return <main><h1>Hello from next-lite</h1></main>;
}
`,
    });

    const artifact = await buildNextLiteApp({
      workspaceRoot: root,
      outDir: path.join(root, ".next-lite"),
    });
    const renderer = await loadNextLiteRenderer(artifact);
    const response = await renderer.renderNextLiteRequest(new Request("http://next-lite.test/"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("<html>");
    expect(html).toContain('data-shell="root"');
    expect(html).toContain("Hello from next-lite");
  });

  it("returns 404 for unsupported paths in the initial root-only slice", async () => {
    const root = await createFixture({
      "app/page.tsx": `export default function Page() {
  return <main>Root only</main>;
}
`,
    });

    const artifact = await buildNextLiteApp({
      workspaceRoot: root,
      outDir: path.join(root, ".next-lite"),
    });
    const renderer = await loadNextLiteRenderer(artifact);
    const response = await renderer.renderNextLiteRequest(
      new Request("http://next-lite.test/missing"),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("uses vendored Vinext route matching for nested dynamic app pages", async () => {
    const root = await createFixture({
      "app/layout.tsx": `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      "app/page.tsx": `export default function Page() {
  return <main>Home</main>;
}
`,
      "app/posts/[postId]/page.tsx": `export default function Page({ params }: { params: { postId: string } }) {
  return <main>Post {params.postId}</main>;
}
`,
    });

    const artifact = await buildNextLiteApp({
      workspaceRoot: root,
      outDir: path.join(root, ".next-lite"),
    });
    const renderer = await loadNextLiteRenderer(artifact);
    const response = await renderer.renderNextLiteRequest(
      new Request("http://next-lite.test/posts/hello%20world"),
    );
    const html = await response.text();

    expect(artifact.routes.map((route) => route.pattern)).toContain("/posts/:postId");
    expect(response.status).toBe(200);
    expect(html).toContain("Post <!-- -->hello world");
  });

  it("renders nested layouts from root to leaf around matching app pages", async () => {
    const root = await createFixture({
      "app/layout.tsx": `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body><section data-layout="root">{children}</section></body></html>;
}
`,
      "app/posts/layout.tsx": `export default function Layout({ children }: { children: React.ReactNode }) {
  return <article data-layout="posts">{children}</article>;
}
`,
      "app/posts/[postId]/layout.tsx": `export default function Layout({ children }: { children: React.ReactNode }) {
  return <div data-layout="post-detail">{children}</div>;
}
`,
      "app/posts/[postId]/page.tsx": `export default function Page({ params }: { params: { postId: string } }) {
  return <main>Post {params.postId}</main>;
}
`,
    });

    const routes = await discoverNextLiteRoutes(root);
    const postRoute = routes.find((route) => route.pathname === "/posts/[postId]");

    expect(postRoute?.layoutFiles).toEqual([
      path.join(root, "app", "layout.tsx"),
      path.join(root, "app", "posts", "layout.tsx"),
      path.join(root, "app", "posts", "[postId]", "layout.tsx"),
    ]);

    const artifact = await buildNextLiteApp({
      workspaceRoot: root,
      outDir: path.join(root, ".next-lite"),
    });
    const renderer = await loadNextLiteRenderer(artifact);
    const response = await renderer.renderNextLiteRequest(
      new Request("http://next-lite.test/posts/nested-layouts"),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-layout="root"');
    expect(html).toContain('data-layout="posts"');
    expect(html).toContain('data-layout="post-detail"');
    expect(html.indexOf('data-layout="root"')).toBeLessThan(
      html.indexOf('data-layout="posts"'),
    );
    expect(html.indexOf('data-layout="posts"')).toBeLessThan(
      html.indexOf('data-layout="post-detail"'),
    );
    expect(html.indexOf('data-layout="post-detail"')).toBeLessThan(
      html.indexOf("Post <!-- -->nested-layouts"),
    );
  });
});
