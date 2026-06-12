import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverNextLiteRoutes,
  type NextLiteRoute,
} from "@/lib/serverless-nextjs-runtime/next-lite";

const fixtureRoots: string[] = [];

async function createFixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tuto-next-lite-discovery-"));
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

describe("discoverNextLiteRoutes / happy paths", () => {
  it("discovers a single root app page with no layout", async () => {
    const root = await createFixture({
      "app/page.tsx": `export default function Page() { return null; }`,
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
    expect(routes[0]?.layoutFile).toBeNull();
    expect(routes[0]?.layoutFiles).toEqual([]);
  });

  it("discovers a root page alongside a root layout", async () => {
    const root = await createFixture({
      "app/layout.tsx": `export default function Layout() { return null; }`,
      "app/page.tsx": `export default function Page() { return null; }`,
    });

    const routes = await discoverNextLiteRoutes(root);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.layoutFiles).toEqual([path.join(root, "app", "layout.tsx")]);
    expect(routes[0]?.layoutFile).toBe(path.join(root, "app", "layout.tsx"));
  });

  it("walks up the directory tree to collect a full nested layout chain", async () => {
    const root = await createFixture({
      "app/layout.tsx": `export default function RootLayout() { return null; }`,
      "app/posts/layout.tsx": `export default function PostsLayout() { return null; }`,
      "app/posts/[postId]/layout.tsx": `export default function PostLayout() { return null; }`,
      "app/posts/[postId]/page.tsx": `export default function Post() { return null; }`,
    });

    const routes = await discoverNextLiteRoutes(root);
    const postRoute = routes.find((route) => route.pathname === "/posts/[postId]");

    expect(postRoute?.layoutFiles).toEqual([
      path.join(root, "app", "layout.tsx"),
      path.join(root, "app", "posts", "layout.tsx"),
      path.join(root, "app", "posts", "[postId]", "layout.tsx"),
    ]);
  });

  it("treats a missing layout level as a hole in the chain without aborting discovery", async () => {
    const root = await createFixture({
      "app/layout.tsx": `export default function RootLayout() { return null; }`,
      // Intentionally no app/posts/layout.tsx here.
      "app/posts/[postId]/layout.tsx": `export default function PostLayout() { return null; }`,
      "app/posts/[postId]/page.tsx": `export default function Post() { return null; }`,
    });

    const routes = await discoverNextLiteRoutes(root);
    const postRoute = routes.find((route) => route.pathname === "/posts/[postId]");

    expect(postRoute?.layoutFiles).toEqual([
      path.join(root, "app", "layout.tsx"),
      path.join(root, "app", "posts", "[postId]", "layout.tsx"),
    ]);
  });

  it("supports page and layout file extensions .tsx, .ts, .jsx, .js", async () => {
    const root = await createFixture({
      "app/layout.jsx": `export default function RootLayout() { return null; }`,
      "app/page.js": `export default function Page() { return null; }`,
      "app/posts/layout.ts": `export default function PostsLayout() { return null; }`,
      "app/posts/page.tsx": `export default function PostsPage() { return null; }`,
    });

    const routes = await discoverNextLiteRoutes(root);

    expect(routes.map((r) => r.pathname).sort()).toEqual(["/", "/posts"]);
    const rootRoute = routes.find((r) => r.pathname === "/") as NextLiteRoute;
    const postsRoute = routes.find((r) => r.pathname === "/posts") as NextLiteRoute;
    // Page file uses the per-route extension; layout chain walks the per-segment extension.
    expect(rootRoute.pageFile).toBe(path.join(root, "app", "page.js"));
    expect(rootRoute.layoutFiles).toEqual([path.join(root, "app", "layout.jsx")]);
    expect(postsRoute.pageFile).toBe(path.join(root, "app", "posts", "page.tsx"));
    expect(postsRoute.layoutFiles).toEqual([
      path.join(root, "app", "layout.jsx"),
      path.join(root, "app", "posts", "layout.ts"),
    ]);
  });
});

describe("discoverNextLiteRoutes / invisible segments", () => {
  it("filters route groups (foo) out of the pathname but keeps their pages discoverable", async () => {
    const root = await createFixture({
      "app/(marketing)/page.tsx": `export default function Marketing() { return null; }`,
      "app/(marketing)/about/page.tsx": `export default function About() { return null; }`,
    });

    const routes = await discoverNextLiteRoutes(root);

    expect(routes.map((r) => r.pathname).sort()).toEqual(["/", "/about"]);
  });

  it("still walks inside route groups to find pages and layouts", async () => {
    const root = await createFixture({
      "app/(marketing)/layout.tsx": `export default function MarketingLayout() { return null; }`,
      "app/(marketing)/about/page.tsx": `export default function About() { return null; }`,
    });

    const routes = await discoverNextLiteRoutes(root);
    const about = routes.find((r) => r.pathname === "/about") as NextLiteRoute;

    expect(about.layoutFiles).toEqual([
      path.join(root, "app", "(marketing)", "layout.tsx"),
    ]);
  });

  it("filters @slot segments out of the pathname", async () => {
    const root = await createFixture({
      "app/@modal/login/page.tsx": `export default function Login() { return null; }`,
      "app/page.tsx": `export default function Home() { return null; }`,
    });

    const routes = await discoverNextLiteRoutes(root);

    expect(routes.map((r) => r.pathname).sort()).toEqual(["/", "/login"]);
  });

  it("filters the literal _private segment out of the pathname", async () => {
    // The current implementation filters only the literal `_private` segment,
    // not every underscore-prefixed segment. This test pins that contract; if
    // we ever broaden it to match Next.js parity, update this test with it.
    const root = await createFixture({
      "app/_private/page.tsx": `export default function Private() { return null; }`,
      "app/posts/page.tsx": `export default function Posts() { return null; }`,
    });

    const routes = await discoverNextLiteRoutes(root);

    expect(routes.map((r) => r.pathname).sort()).toEqual(["/", "/posts"]);
  });

  it("filters multiple invisible segment kinds in the same path", async () => {
    const root = await createFixture({
      "app/(group)/@slot/_private/page.tsx": `export default function P() { return null; }`,
    });

    const routes = await discoverNextLiteRoutes(root);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.pathname).toBe("/");
  });
});

describe("discoverNextLiteRoutes / dynamic and catch-all patterns", () => {
  it("produces the Vinext pattern for a dynamic segment", async () => {
    const root = await createFixture({
      "app/posts/[postId]/page.tsx": `export default function Post() { return null; }`,
    });

    const routes = await discoverNextLiteRoutes(root);
    const r = routes[0] as NextLiteRoute;

    expect(r.pathname).toBe("/posts/[postId]");
    expect(r.pattern).toBe("/posts/:postId");
    expect(r.patternParts).toEqual(["posts", ":postId"]);
  });

  it("produces the Vinext pattern for a catch-all segment", async () => {
    const root = await createFixture({
      "app/docs/[...slug]/page.tsx": `export default function Docs() { return null; }`,
    });

    const routes = await discoverNextLiteRoutes(root);
    const r = routes[0] as NextLiteRoute;

    expect(r.pattern).toBe("/docs/:slug+");
    expect(r.patternParts).toEqual(["docs", ":slug+"]);
  });

  it("produces the Vinext pattern for an optional catch-all segment", async () => {
    const root = await createFixture({
      "app/[[...slug]]/page.tsx": `export default function Optional() { return null; }`,
    });

    const routes = await discoverNextLiteRoutes(root);
    const r = routes[0] as NextLiteRoute;

    expect(r.pattern).toBe("/:slug*");
    expect(r.patternParts).toEqual([":slug*"]);
  });
});

describe("discoverNextLiteRoutes / route handlers", () => {
  it("discovers app route handler files with .ts, .tsx, .js, and .jsx extensions", async () => {
    const root = await createFixture({
      "app/api/route.ts": `export function GET() { return new Response("ts"); }`,
      "app/js/route.js": `export function GET() { return new Response("js"); }`,
      "app/jsx/route.jsx": `export function GET() { return new Response("jsx"); }`,
      "app/tsx/route.tsx": `export function GET() { return new Response("tsx"); }`,
    });

    const routes = await discoverNextLiteRoutes(root);

    expect(routes.map((r) => [r.kind, r.pathname]).sort()).toEqual([
      ["route-handler", "/api"],
      ["route-handler", "/js"],
      ["route-handler", "/jsx"],
      ["route-handler", "/tsx"],
    ]);
    expect(routes.find((r) => r.pathname === "/api")).toMatchObject({
      kind: "route-handler",
      routeFile: path.join(root, "app", "api", "route.ts"),
    });
  });

  it("produces the Vinext pattern for a dynamic route handler segment", async () => {
    const root = await createFixture({
      "app/api/posts/[postId]/route.ts": `export function GET() { return new Response("ok"); }`,
    });

    const routes = await discoverNextLiteRoutes(root);
    const r = routes[0] as NextLiteRoute;

    expect(r).toMatchObject({
      kind: "route-handler",
      pathname: "/api/posts/[postId]",
      pattern: "/api/posts/:postId",
      patternParts: ["api", "posts", ":postId"],
    });
  });

  it("allows a workspace with route handlers and no pages", async () => {
    const root = await createFixture({
      "app/api/health/route.ts": `export function GET() { return new Response("ok"); }`,
    });

    const routes = await discoverNextLiteRoutes(root);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      kind: "route-handler",
      pathname: "/api/health",
    });
  });
});

describe("discoverNextLiteRoutes / ordering", () => {
  it("returns routes sorted by vendored compareRoutes (static before dynamic before catch-all)", async () => {
    const root = await createFixture({
      "app/posts/page.tsx": `export default function Posts() { return null; }`,
      "app/posts/[postId]/page.tsx": `export default function Post() { return null; }`,
      "app/docs/[...slug]/page.tsx": `export default function Docs() { return null; }`,
      "app/page.tsx": `export default function Home() { return null; }`,
    });

    const routes = await discoverNextLiteRoutes(root);

    expect(routes.map((r) => r.pathname)).toEqual([
      "/",
      "/posts",
      "/posts/[postId]",
      "/docs/[...slug]",
    ]);
  });
});

describe("discoverNextLiteRoutes / errors", () => {
  it("throws when the workspace has no app directory", async () => {
    const root = await createFixture({});

    await expect(discoverNextLiteRoutes(root)).rejects.toThrow(
      "next-lite requires at least one app/**/page or app/**/route file.",
    );
  });

  it("throws when the app directory exists but has no page or route handler files", async () => {
    const root = await createFixture({
      "app/layout.tsx": `export default function Layout() { return null; }`,
    });

    await expect(discoverNextLiteRoutes(root)).rejects.toThrow(
      "next-lite requires at least one app/**/page or app/**/route file.",
    );
  });

  it("throws when a page and route handler resolve to the same pathname", async () => {
    const root = await createFixture({
      "app/route.ts": `export function GET() { return new Response(); }`,
      "app/page.tsx": `export default function Home() { return null; }`,
    });

    await expect(discoverNextLiteRoutes(root)).rejects.toThrow(
      "next-lite does not support app/page and app/route at the same pathname: /",
    );
  });

  it("ignores unrelated non-route files", async () => {
    const root = await createFixture({
      "app/not-found.tsx": `export default function NotFound() { return null; }`,
      "app/page.tsx": `export default function Home() { return null; }`,
    });

    const routes = await discoverNextLiteRoutes(root);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.pathname).toBe("/");
  });
});
