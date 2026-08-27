import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { WorkspaceFile } from "../../lib/ide/types";

const files: WorkspaceFile[] = [
  {
    content: '<script type="module" src="./src/main.ts"></script>',
    language: "html",
    path: "index.html",
  },
  {
    content: "export {};",
    language: "ts",
    path: "src/main.ts",
  },
  {
    content: `import { useState } from 'react';
import { createMiddleware, createServerFn } from '@tanstack/react-start';
import { Link, createFileRoute } from '@tanstack/react-router';

const addContext = createMiddleware({ type: 'function' }).server(({ next }) =>
  next({ context: { source: 'browser-middleware' } }),
);

const greet = createServerFn({ method: 'POST' })
  .middleware([addContext])
  .inputValidator((data) => ({ name: String(data.name) }))
  .handler(async ({ context, data }) => ({
    message: 'Hello ' + data.name,
    source: context.source,
  }));

export const Route = createFileRoute('/')({ component: HomeRoute });

function HomeRoute() {
  const [count, setCount] = useState(0);
  const [serverResult, setServerResult] = useState('idle');
  const [requestResult, setRequestResult] = useState('idle');
  const [redirectResult, setRedirectResult] = useState('idle');

  return (
    <main>
      <h1>Browser runtime fixture</h1>
      <button data-testid="hydrate" onClick={() => setCount((value) => value + 1)}>
        Hydration count: {count}
      </button>
      <button
        data-testid="server-fn"
        onClick={async () => setServerResult(JSON.stringify(await greet({ data: { name: 'Ada' } })))}
      >
        Call server function
      </button>
      <output data-testid="server-result">{serverResult}</output>
      <button
        data-testid="request-fetch"
        onClick={async () => {
          const routeRequest = new Request('/api/echo', {
            body: 'browser-body',
            headers: { 'content-type': 'text/plain', 'x-browser-test': 'active' },
            method: 'PATCH',
          });
          const response = await globalThis.fetch(routeRequest);
          setRequestResult(JSON.stringify(await response.json()));
        }}
      >
        Send Request object
      </button>
      <output data-testid="request-result">{requestResult}</output>
      <button
        data-testid="redirect-fetch"
        onClick={async () => {
          const response = await globalThis.fetch(new Request('/api/echo?redirect=1'));
          setRedirectResult(JSON.stringify(await response.json()));
        }}
      >
        Follow route redirect
      </button>
      <output data-testid="redirect-result">{redirectResult}</output>
      <Link data-testid="about-link" to="/about">Open lazy route</Link>
    </main>
  );
}`,
    language: "tsx",
    path: "src/routes/index.tsx",
  },
  {
    content: `import './about.css';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/about')({
  component: () => <h2 className="about-route" data-testid="about-route">Lazy route loaded in the browser</h2>,
});`,
    language: "tsx",
    path: "src/routes/about.tsx",
  },
  {
    content: `.about-route { color: rgb(12, 34, 56); }`,
    language: "css",
    path: "src/routes/about.css",
  },
  {
    content: `import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/echo')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('redirect') === '1') {
          return Response.redirect(new URL('/api/echo?landed=1', url), 307);
        }
        return Response.json({ landed: url.searchParams.get('landed') === '1' });
      },
      PATCH: async ({ request }) => Response.json({
        body: await request.text(),
        header: request.headers.get('x-browser-test'),
        method: request.method,
      }),
    },
  },
});`,
    language: "ts",
    path: "src/routes/api.echo.ts",
  },
  {
    content: `import {
  Link,
  Outlet,
  Scripts,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { Route as aboutRouteImport } from './routes/about';
import { Route as apiEchoRouteImport } from './routes/api.echo';
import { Route as indexRouteImport } from './routes/index';

const rootRoute = createRootRoute({
  component: () => (
    <html lang="en">
      <head><title>TanStack Start browser E2E</title></head>
      <body><Outlet /><Scripts /></body>
    </html>
  ),
});

const indexRoute = indexRouteImport.update({
  getParentRoute: () => rootRoute,
  id: '/',
  path: '/',
});
const aboutRoute = aboutRouteImport.update({
  getParentRoute: () => rootRoute,
  id: '/about',
  path: '/about',
});
const apiEchoRoute = apiEchoRouteImport.update({
  getParentRoute: () => rootRoute,
  id: '/api/echo',
  path: '/api/echo',
});

const routeTree = rootRoute.addChildren([indexRoute, aboutRoute, apiEchoRoute]);

export function getRouter() {
  return createRouter({
    defaultPreload: false,
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree,
  });
}`,
    language: "tsx",
    path: "src/router.tsx",
  },
];

type CompileResult = {
  diagnostics?: Array<{ message: string }>;
  html: string | null;
  success: boolean;
};

async function compilePreview(request: APIRequestContext) {
  const response = await request.post("/api/serverless/compile", {
    data: { files, mode: "tanstackstart" },
    timeout: 120_000,
  });
  const result = (await response.json()) as CompileResult;

  expect(response.status(), JSON.stringify(result.diagnostics)).toBe(200);
  expect(result.success, JSON.stringify(result.diagnostics)).toBe(true);
  expect(result.html).not.toBeNull();

  const redirect = result.html?.match(/location\.replace\(("(?:\\.|[^"])*")\)/)?.[1];
  expect(redirect).toBeTruthy();
  return JSON.parse(redirect as string) as string;
}

function collectBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  return errors;
}

test("hydrates and exercises the native Start browser runtime", async ({ page, request, baseURL }) => {
  const browserErrors = collectBrowserErrors(page);
  const renderPath = await compilePreview(request);
  const routeChunks = new Set<string>();
  const routeStyles = new Set<string>();

  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/core-asset") && url.includes("kind=chunk")) routeChunks.add(url);
    if (url.includes("/core-asset") && url.includes("kind=style") && url.includes("name=")) routeStyles.add(url);
  });

  const renderResponse = await page.goto(new URL(renderPath, baseURL).href);
  expect(renderResponse?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Browser runtime fixture" })).toBeVisible();

  await page.getByTestId("hydrate").click();
  await expect(page.getByTestId("hydrate")).toHaveText("Hydration count: 1");

  const directGatewayResult = await page.evaluate(async () => {
    const gateway = new URL(location.href);
    gateway.pathname = "/api/serverless/tanstack-start/core-route";
    gateway.searchParams.set("path", "/api/echo");
    const response = await globalThis.fetch(gateway, {
      body: "direct-body",
      headers: { "content-type": "text/plain" },
      method: "PATCH",
    });
    return response.json();
  });
  expect(directGatewayResult).toMatchObject({ body: "direct-body" });

  await page.getByTestId("server-fn").click();
  await expect(page.getByTestId("server-result")).toContainText("Hello Ada");
  await expect(page.getByTestId("server-result")).toContainText("browser-middleware");

  await page.getByTestId("request-fetch").click();
  await expect(page.getByTestId("request-result")).toContainText("browser-body");
  await expect(page.getByTestId("request-result")).toContainText("active");
  await expect(page.getByTestId("request-result")).toContainText("PATCH");

  await page.getByTestId("redirect-fetch").click();
  await expect(page.getByTestId("redirect-result")).toContainText('"landed":true');

  const chunksBeforeNavigation = new Set(routeChunks);
  expect(routeStyles.size).toBe(0);
  await page.getByTestId("about-link").click();
  await expect(page.getByTestId("about-route")).toHaveText("Lazy route loaded in the browser");
  await expect(page.getByTestId("about-route")).toHaveCSS("color", "rgb(12, 34, 56)");
  expect([...routeChunks].some((url) => !chunksBeforeNavigation.has(url))).toBe(true);
  expect(routeStyles.size).toBeGreaterThan(0);
  expect(browserErrors).toEqual([]);
});
