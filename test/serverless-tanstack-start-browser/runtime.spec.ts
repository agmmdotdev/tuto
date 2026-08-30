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
    content: `import { Suspense, useState } from 'react';
import { createMiddleware, createServerFn } from '@tanstack/react-start';
import {
  CompositeComponent,
  createCompositeComponent,
  createFromFetch,
  renderServerComponent,
} from '@tanstack/react-start/rsc';
import { Link, createFileRoute } from '@tanstack/react-router';
import { InitialRsc } from '../initial-rsc';
import { multiplyOnRscServer } from '../rsc-actions';

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

const getInitialRsc = createServerFn({ method: 'GET' }).handler(async () => ({
  CompositeSrc: await createCompositeComponent((props) => ({
    Card: (
      <article data-testid="composite-card">
        <h2>Composite shell rendered in SSR</h2>
        <div>{props.title('Title passed through Flight')}</div>
        <div>{props.children}</div>
      </article>
    ),
    Footer: (
      <footer data-testid="composite-footer">
        Nested composite selection rendered
      </footer>
    ),
  })),
  InitialRsc: await renderServerComponent(<InitialRsc />),
}));

export const Route = createFileRoute('/')({
  loader: () => getInitialRsc(),
  component: HomeRoute,
});

function HomeRoute() {
  const { CompositeSrc, InitialRsc } = Route.useLoaderData();
  const [compositeCount, setCompositeCount] = useState(0);
  const [count, setCount] = useState(0);
  const [serverResult, setServerResult] = useState('idle');
  const [requestResult, setRequestResult] = useState('idle');
  const [redirectResult, setRedirectResult] = useState('idle');
  const [rscTree, setRscTree] = useState(null);
  const [rscActionResult, setRscActionResult] = useState('idle');

  return (
    <main>
      <h1>Browser runtime fixture</h1>
      <button data-testid="hydrate" onClick={() => setCount((value) => value + 1)}>
        Hydration count: {count}
      </button>
      <section data-testid="initial-rsc-result">{InitialRsc}</section>
      <CompositeComponent
        src={CompositeSrc.Card}
        title={(title) => (
          <button
            data-testid="composite-title-slot"
            onClick={() => setCompositeCount((value) => value + 1)}
          >
            {title}: {compositeCount}
          </button>
        )}
      >
        <p data-testid="composite-children-slot">Children supplied by the client route</p>
      </CompositeComponent>
      <CompositeComponent src={CompositeSrc.Footer} />
      <button
        data-testid="rsc-server-action"
        onClick={async () => {
          setRscActionResult(JSON.stringify(await multiplyOnRscServer(6, 7)));
        }}
      >
        Run RSC server action
      </button>
      <output data-testid="rsc-server-action-result">{rscActionResult}</output>
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
      <button
        data-testid="rsc-load"
        onClick={async () => {
          const tree = await createFromFetch(fetch('/__tuto_rsc'));
          setRscTree(tree);
        }}
      >
        Load server component
      </button>
      <Suspense fallback={<p data-testid="rsc-loading">Loading RSC</p>}>
        <section data-testid="rsc-result">{rscTree}</section>
      </Suspense>
      <Link data-testid="about-link" to="/about">Open lazy route</Link>
    </main>
  );
}`,
    language: "tsx",
    path: "src/routes/index.tsx",
  },
  {
    content: `'use server';
import { getRequestUrl } from '@tanstack/react-start/server';

export async function multiplyOnRscServer(left, right) {
  return {
    pathname: getRequestUrl().pathname,
    result: left * right,
    source: 'module-rsc-server-action',
  };
}`,
    language: "ts",
    path: "src/rsc-actions.ts",
  },
  {
    content: `import './initial-rsc.css';
import { InitialRscCounter } from './initial-rsc-counter';

export function InitialRsc() {
  const prefix = 'inline-bound-action:';
  async function describeFromServer(value) {
    'use server';
    return prefix + value;
  }
  return (
    <article className="initial-rsc-only-resource" data-testid="initial-rsc-root">
      <h2>Initial Flight rendered in SSR</h2>
      <InitialRscCounter
        action={describeFromServer}
        initial={5}
        message="initial-server-only-rsc"
      />
    </article>
  );
}`,
    language: "tsx",
    path: "src/initial-rsc.tsx",
  },
  {
    content: `.initial-rsc-only-resource { border-bottom: 4px solid rgb(41, 73, 105); }`,
    language: "css",
    path: "src/initial-rsc.css",
  },
  {
    content: `'use client';
import './initial-rsc-counter.css';
import { useState } from 'react';

export function InitialRscCounter({ action, initial, message }) {
  const [count, setCount] = useState(initial);
  const [actionResult, setActionResult] = useState('idle');
  return (
    <div className="initial-rsc-counter-boundary">
      <p data-testid="initial-rsc-message">{message}</p>
      <button
        data-testid="initial-rsc-counter"
        onClick={() => setCount((value) => value + 1)}
      >
        Initial RSC count: {count}
      </button>
      <button
        data-testid="inline-rsc-server-action"
        onClick={async () => setActionResult(await action('client-value'))}
      >
        Run inline RSC action
      </button>
      <output data-testid="inline-rsc-server-action-result">{actionResult}</output>
    </div>
  );
}`,
    language: "tsx",
    path: "src/initial-rsc-counter.tsx",
  },
  {
    content: `.initial-rsc-counter-boundary { border-top: 3px solid rgb(98, 76, 54); }`,
    language: "css",
    path: "src/initial-rsc-counter.css",
  },
  {
    content: `'use client';
import { useState } from 'react';

export function RscCounter({ initial, message }) {
  const [count, setCount] = useState(initial);
  return (
    <div>
      <p data-testid="rsc-message">{message}</p>
      <button data-testid="rsc-counter" onClick={() => setCount((value) => value + 1)}>
        RSC count: {count}
      </button>
    </div>
  );
}`,
    language: "tsx",
    path: "src/rsc-counter.tsx",
  },
  {
    content: `import { RscCounter } from './rsc-counter';

export default async function RscRoot({ requestUrl }) {
  await Promise.resolve();
  const pathname = new URL(requestUrl).pathname;
  return (
    <article data-testid="rsc-root">
      <h2>Flight rendered on the server</h2>
      <RscCounter initial={2} message={'server-only-rsc:' + pathname} />
    </article>
  );
}`,
    language: "tsx",
    path: "src/rsc.tsx",
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
  const flightResponses: Array<{ contentType: string | null; status: number }> = [];
  const actionResponses: Array<{
    contentType: string | null;
    status: number;
    workerId: string | null;
  }> = [];

  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/core-asset") && url.includes("kind=chunk")) routeChunks.add(url);
    if (url.includes("/core-asset") && url.includes("kind=style") && url.includes("name=")) routeStyles.add(url);
    if (url.includes("/core-route") && url.includes("__tuto_rsc")) {
      const responseSummary = {
        contentType: response.headers()["content-type"] ?? null,
        status: response.status(),
      };
      if (url.includes("__tuto_rsc_action")) {
        actionResponses.push({
          ...responseSummary,
          workerId: response.headers()["x-tuto-worker-id"] ?? null,
        });
      } else {
        flightResponses.push(responseSummary);
      }
    }
  });

  const renderResponse = await page.goto(new URL(renderPath, baseURL).href);
  expect(renderResponse?.status()).toBe(200);
  const initialHtml = await renderResponse!.text();
  expect(initialHtml).toContain("Initial Flight rendered in SSR");
  expect(initialHtml).not.toContain("inline-bound-action:");
  expect(initialHtml).toContain('<article data-testid="composite-card">');
  expect(initialHtml).toContain('<button data-testid="composite-title-slot">');
  expect(initialHtml).toContain("Children supplied by the client route");
  expect(initialHtml).toContain('rel="modulepreload"');
  expect(initialHtml).toContain("data-rsc-css-href");
  expect(initialHtml).toContain("kind=style");
  await expect(page.getByRole("heading", { name: "Browser runtime fixture" })).toBeVisible();
  await expect(page.getByTestId("initial-rsc-root")).toBeVisible();
  await expect(page.getByTestId("initial-rsc-message")).toHaveText(
    "initial-server-only-rsc",
  );
  await expect(page.getByTestId("initial-rsc-counter")).toHaveText(
    "Initial RSC count: 5",
  );
  await expect(page.getByTestId("initial-rsc-root")).toHaveCSS(
    "border-bottom-color",
    "rgb(41, 73, 105)",
  );
  await expect(page.getByTestId("initial-rsc-root").locator("div").first()).toHaveCSS(
    "border-top-color",
    "rgb(98, 76, 54)",
  );
  expect(routeStyles.size).toBeGreaterThan(0);
  await page.getByTestId("initial-rsc-counter").click();
  await expect(page.getByTestId("initial-rsc-counter")).toHaveText(
    "Initial RSC count: 6",
  );
  await expect(page.getByTestId("composite-card")).toBeVisible();
  await expect(page.getByTestId("composite-title-slot")).toHaveText(
    "Title passed through Flight: 0",
  );
  await expect(page.getByTestId("composite-children-slot")).toHaveText(
    "Children supplied by the client route",
  );
  await expect(page.getByTestId("composite-footer")).toHaveText(
    "Nested composite selection rendered",
  );
  await page.getByTestId("composite-title-slot").click();
  await expect(page.getByTestId("composite-title-slot")).toHaveText(
    "Title passed through Flight: 1",
  );

  await page.getByTestId("rsc-server-action").click();
  await expect(page.getByTestId("rsc-server-action-result")).toContainText(
    '"result":42',
  );
  await expect(page.getByTestId("rsc-server-action-result")).toContainText(
    "module-rsc-server-action",
  );
  await expect(page.getByTestId("rsc-server-action-result")).toContainText(
    '"pathname":"/__tuto_rsc_action"',
  );
  await page.getByTestId("inline-rsc-server-action").click();
  await expect(
    page.getByTestId("inline-rsc-server-action-result"),
  ).toHaveText("inline-bound-action:client-value");
  expect(actionResponses).toEqual([
    expect.objectContaining({
      contentType: expect.stringContaining("text/x-component"),
      status: 200,
    }),
    expect.objectContaining({
      contentType: expect.stringContaining("text/x-component"),
      status: 200,
    }),
  ]);
  expect(actionResponses[0]?.workerId).toBeTruthy();
  expect(actionResponses[1]?.workerId).toBeTruthy();
  expect(actionResponses[1]?.workerId).not.toBe(actionResponses[0]?.workerId);

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

  const chunksBeforeRsc = new Set(routeChunks);
  await page.getByTestId("rsc-load").click();
  await expect(page.getByTestId("rsc-root")).toBeVisible();
  await expect(page.getByTestId("rsc-message")).toHaveText(
    "server-only-rsc:/__tuto_rsc",
  );
  await expect(page.getByTestId("rsc-counter")).toHaveText("RSC count: 2");
  await page.getByTestId("rsc-counter").click();
  await expect(page.getByTestId("rsc-counter")).toHaveText("RSC count: 3");
  expect(flightResponses).toEqual([
    expect.objectContaining({ contentType: expect.stringContaining("text/x-component"), status: 200 }),
  ]);
  expect([...routeChunks].some((url) => !chunksBeforeRsc.has(url))).toBe(true);

  const chunksBeforeNavigation = new Set(routeChunks);
  const stylesBeforeNavigation = new Set(routeStyles);
  await page.getByTestId("about-link").click();
  await expect(page.getByTestId("about-route")).toHaveText("Lazy route loaded in the browser");
  await expect(page.getByTestId("about-route")).toHaveCSS("color", "rgb(12, 34, 56)");
  expect([...routeChunks].some((url) => !chunksBeforeNavigation.has(url))).toBe(true);
  expect(
    [...routeStyles].some((url) => !stylesBeforeNavigation.has(url)),
  ).toBe(true);
  expect(browserErrors).toEqual([]);
});
