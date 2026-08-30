import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { WorkspaceFile } from "../../lib/ide/types";

const files: WorkspaceFile[] = [
  {
    content: '<script type="module" src="./src/main.ts"></script>',
    language: "html",
    path: "index.html",
  },
  {
    content: `VITE_APP_NAME=Tuto public environment
SERVER_SECRET=server-environment-secret`,
    language: "md",
    path: ".env",
  },
  {
    content: "export {};",
    language: "ts",
    path: "src/main.ts",
  },
  {
    content: JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "~/*": ["./src/*"] },
      },
    }),
    language: "json",
    path: "tsconfig.json",
  },
  {
    content: `export function SeoAliasLabel() {
  return <span data-testid="path-alias-component">Resolved through tsconfig paths</span>;
}`,
    language: "tsx",
    path: "src/components/seo-label.tsx",
  },
  {
    content: `export function makeGreeting(name) {
  return 'Hello ' + name;
}`,
    language: "ts",
    path: "src/server/greeting.ts",
  },
  {
    content: `import {
  createClientOnlyFn,
  createIsomorphicFn,
  createServerOnlyFn,
} from '@tanstack/react-start';

export const getEnvironmentRuntime = createIsomorphicFn()
  .server(() => 'server-runtime')
  .client(() => 'client-runtime');
export const getServerOnlyValue = createServerOnlyFn(
  () => 'server-only:' + process.env.SERVER_SECRET,
);
export const getClientOnlyValue = createClientOnlyFn(
  () => 'client-only:' + window.location.pathname,
);`,
    language: "ts",
    path: "src/environment.ts",
  },
  {
    content: `import { StartClient } from '@tanstack/react-start/client';
import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';

globalThis.__tutoCustomClientEntryLoaded = true;
hydrateRoot(document, <StrictMode><StartClient /></StrictMode>);`,
    language: "tsx",
    path: "src/client.tsx",
  },
  {
    content: `import handler, { createServerEntry } from '@tanstack/react-start/server-entry';

export default createServerEntry({
  async fetch(request, requestOptions) {
    const response = await handler.fetch(request, requestOptions);
    const headers = new Headers(response.headers);
    headers.set('x-custom-server-entry', 'active');
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  },
});`,
    language: "ts",
    path: "src/server.ts",
  },
  {
    content: `import { Suspense, useState } from 'react';
import { Hydrate, createMiddleware, createServerFn } from '@tanstack/react-start';
import { interaction } from '@tanstack/react-start/hydration';
import {
  CompositeComponent,
  createCompositeComponent,
  createFromFetch,
  renderServerComponent,
} from '@tanstack/react-start/rsc';
import { Link, createFileRoute } from '@tanstack/react-router';
import { InitialRsc } from '../initial-rsc';
import { multiplyOnRscServer } from '../rsc-actions';
import {
  getClientOnlyValue,
  getEnvironmentRuntime,
  getServerOnlyValue,
} from '../environment';
import { makeGreeting } from '~/server/greeting';

const addContext = createMiddleware({ type: 'function' }).server(({ next }) =>
  next({ context: { source: 'browser-middleware' } }),
);

const greet = createServerFn({ method: 'POST' })
  .middleware([addContext])
  .inputValidator((data) => ({ name: String(data.name) }))
  .handler(async ({ context, data }) => ({
    message: makeGreeting(data.name),
    source: context.source,
  }));

const streamMessages = createServerFn({ method: 'GET' }).handler(() =>
  new ReadableStream({
    start(controller) {
      controller.enqueue({ content: 'readable-' });
      controller.enqueue({ content: 'stream' });
      controller.close();
    },
  }),
);

const generateMessages = createServerFn({ method: 'GET' }).handler(
  async function* () {
    yield { content: 'async-' };
    yield { content: 'generator' };
  },
);

const inspectFormData = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => {
    const upload = data.get('upload');
    return {
      fileName: upload.name,
      fileText: await upload.text(),
      title: data.get('title'),
    };
  },
);

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
  loader: async () => {
    let clientOnlyError = 'missing-error';
    try {
      getClientOnlyValue();
    } catch (error) {
      clientOnlyError = error.message;
    }
    return {
      ...(await getInitialRsc()),
      environment: {
        clientOnlyError,
        runtime: getEnvironmentRuntime(),
        serverOnly: getServerOnlyValue(),
      },
    };
  },
  component: HomeRoute,
});

function DeferredHydrationCounter() {
  const [count, setCount] = useState(0);
  return (
    <button
      data-testid="deferred-hydration-counter"
      onClick={() => setCount((value) => value + 1)}
    >
      Deferred hydration count: {count}
    </button>
  );
}

function HomeRoute() {
  const { CompositeSrc, InitialRsc, environment } = Route.useLoaderData();
  const [compositeCount, setCompositeCount] = useState(0);
  const [count, setCount] = useState(0);
  const [serverResult, setServerResult] = useState('idle');
  const [streamResult, setStreamResult] = useState('idle');
  const [formResult, setFormResult] = useState('idle');
  const [requestResult, setRequestResult] = useState('idle');
  const [redirectResult, setRedirectResult] = useState('idle');
  const [rscTree, setRscTree] = useState(null);
  const [rscActionResult, setRscActionResult] = useState('idle');
  const [environmentResult, setEnvironmentResult] = useState('idle');

  return (
    <main>
      <h1>Browser runtime fixture</h1>
      <button data-testid="hydrate" onClick={() => setCount((value) => value + 1)}>
        Hydration count: {count}
      </button>
      <Hydrate when={interaction({ events: 'click' })}>
        <DeferredHydrationCounter />
      </Hydrate>
      <p data-testid="environment-server-result">
        {environment.runtime}|{environment.serverOnly}|{environment.clientOnlyError}
      </p>
      <p data-testid="environment-public-result">
        {import.meta.env.VITE_APP_NAME}|{String(import.meta.env.SERVER_SECRET)}
      </p>
      <button
        data-testid="environment-client"
        onClick={() => {
          let serverOnlyError = 'missing-error';
          try {
            getServerOnlyValue();
          } catch (error) {
            serverOnlyError = error.message;
          }
          setEnvironmentResult(
            [getEnvironmentRuntime(), getClientOnlyValue(), serverOnlyError].join('|'),
          );
        }}
      >
        Exercise client environment functions
      </button>
      <output data-testid="environment-client-result">{environmentResult}</output>
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
        data-testid="streaming-server-functions"
        onClick={async () => {
          const readable = await streamMessages();
          const reader = readable.getReader();
          let readableText = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            readableText += value.content;
          }
          let generatorText = '';
          for await (const value of await generateMessages()) {
            generatorText += value.content;
          }
          setStreamResult(readableText + '|' + generatorText);
        }}
      >
        Stream server-function data
      </button>
      <output data-testid="streaming-server-functions-result">{streamResult}</output>
      <button
        data-testid="formdata-server-function"
        onClick={async () => {
          const data = new FormData();
          data.set('title', 'compatibility-form');
          data.set('upload', new File(['fixture-body'], 'fixture.txt', { type: 'text/plain' }));
          setFormResult(JSON.stringify(await inspectFormData({ data })));
        }}
      >
        Send FormData
      </button>
      <output data-testid="formdata-server-function-result">{formResult}</output>
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
      <Link data-testid="deferred-link" to="/deferred">Open deferred loader fixture</Link>
      <Link data-testid="ssr-full-link" to="/ssr-full">Open full SSR fixture</Link>
      <Link data-testid="ssr-data-only-link" to="/ssr-data-only">Open data-only SSR fixture</Link>
      <Link data-testid="ssr-client-only-link" to="/ssr-client-only">Open client-only SSR fixture</Link>
      <Link data-testid="error-link" to="/error">Open route error fixture</Link>
      <Link data-testid="not-found-link" to="/missing">Open not-found fixture</Link>
      <Link data-testid="about-link" to="/about">Open lazy route</Link>
      <Link data-testid="advanced-hydration-link" to="/hydration">Open hydration strategy fixtures</Link>
    </main>
  );
}`,
    language: "tsx",
    path: "src/routes/index.tsx",
  },
  {
    content: `import { useState } from 'react';
import { Hydrate } from '@tanstack/react-start';
import {
  condition,
  idle,
  interaction,
  media,
  never,
  visible,
} from '@tanstack/react-start/hydration';
import { Link, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/hydration')({
  component: HydrationStrategiesRoute,
});

function StrategyCounter({ label, testId }) {
  const [count, setCount] = useState(0);
  return (
    <button data-testid={testId} onClick={() => setCount((value) => value + 1)}>
      {label} hydration count: {count}
    </button>
  );
}

function HydrationStrategiesRoute() {
  return (
    <main>
      <h1>Advanced hydration strategy fixtures</h1>
      <Hydrate when={idle({ timeout: 5_000 })}>
        <StrategyCounter label="Idle" testId="idle-hydration-counter" />
      </Hydrate>
      <Hydrate when={media('(min-width: 1400px)')}>
        <StrategyCounter label="Media" testId="media-hydration-counter" />
      </Hydrate>
      <div style={{ position: 'absolute', top: 10_000 }}>
        <Hydrate when={visible({ rootMargin: '0px', threshold: 0 })}>
          <StrategyCounter label="Visible" testId="visible-hydration-counter" />
        </Hydrate>
      </div>
      <Hydrate when={condition(true)}>
        <StrategyCounter label="Condition" testId="condition-hydration-counter" />
      </Hydrate>
      <Hydrate when={never()}>
        <StrategyCounter label="Never" testId="never-hydration-counter" />
      </Hydrate>
      <Hydrate
        when={interaction({ events: 'click' })}
        prefetch={interaction({ events: 'mouseenter' })}
      >
        <StrategyCounter label="Prefetch" testId="prefetch-hydration-counter" />
      </Hydrate>
      <Link data-testid="advanced-hydration-home" to="/">Return home</Link>
    </main>
  );
}`,
    language: "tsx",
    path: "src/routes/hydration.tsx",
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
import { SeoAliasLabel } from '~/components/seo-label';

export const Route = createFileRoute('/about')({
  loader: () => ({ title: 'About compatibility fixture' }),
  head: ({ loaderData }) => ({
    links: [{ rel: 'canonical', href: 'https://tuto.test/about' }],
    meta: [
      { title: loaderData.title },
      { name: 'description', content: 'TanStack Start head metadata fixture' },
      { property: 'og:title', content: loaderData.title },
    ],
    scripts: [{
      type: 'application/ld+json',
      children: JSON.stringify({ '@context': 'https://schema.org', name: loaderData.title }),
    }],
  }),
  component: () => (
    <section>
      <h2 className="about-route" data-testid="about-route">Lazy route loaded in the browser</h2>
      <SeoAliasLabel />
    </section>
  ),
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
    content: `import { Suspense, useState } from 'react';
import { Await, Link, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/deferred')({
  loader: () => ({
    immediate: 'immediate-loader-value',
    deferred: new Promise((resolve) =>
      setTimeout(() => resolve('deferred-loader-value'), 75),
    ),
  }),
  component: DeferredRoute,
});

function DeferredRoute() {
  const { deferred, immediate } = Route.useLoaderData();
  const [count, setCount] = useState(0);
  return (
    <section>
      <p data-testid="deferred-immediate">{immediate}</p>
      <Suspense fallback={<p data-testid="deferred-pending">Loading deferred data</p>}>
        <Await promise={deferred}>
          {(value) => <p data-testid="deferred-value">{value}</p>}
        </Await>
      </Suspense>
      <button data-testid="deferred-counter" onClick={() => setCount((value) => value + 1)}>
        Deferred count: {count}
      </button>
      <Link data-testid="deferred-home" to="/">Return home</Link>
    </section>
  );
}`,
    language: "tsx",
    path: "src/routes/deferred.tsx",
  },
  {
    content: `import { Link, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ssr-full')({
  ssr: true,
  loader: () => ({ source: typeof window === 'undefined' ? 'server-full-loader' : 'client-full-loader' }),
  component: FullSsrRoute,
});

function FullSsrRoute() {
  const data = Route.useLoaderData();
  return (
    <section data-testid="ssr-full-component">
      full-component:{data.source}
      <Link data-testid="ssr-full-home" to="/">Return home</Link>
    </section>
  );
}`,
    language: "tsx",
    path: "src/routes/ssr-full.tsx",
  },
  {
    content: `import { Link, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ssr-data-only')({
  ssr: 'data-only',
  loader: () => ({ source: typeof window === 'undefined' ? 'server-data-only-loader' : 'client-data-only-loader' }),
  pendingComponent: () => <p data-testid="ssr-data-only-pending">data-only-pending</p>,
  component: DataOnlyRoute,
});

function DataOnlyRoute() {
  if (typeof window === 'undefined') {
    throw new Error('data-only component rendered on the server');
  }
  const data = Route.useLoaderData();
  return (
    <section data-testid="ssr-data-only-component">
      data-only-component:{data.source}
      <Link data-testid="ssr-data-only-home" to="/">Return home</Link>
    </section>
  );
}`,
    language: "tsx",
    path: "src/routes/ssr-data-only.tsx",
  },
  {
    content: `import { Link, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ssr-client-only')({
  ssr: false,
  loader: () => {
    if (typeof window === 'undefined') {
      throw new Error('client-only loader executed on the server');
    }
    return { source: 'client-only-loader' };
  },
  pendingComponent: () => <p data-testid="ssr-client-only-pending">client-only-pending</p>,
  component: ClientOnlyRoute,
});

function ClientOnlyRoute() {
  const data = Route.useLoaderData();
  return (
    <section data-testid="ssr-client-only-component">
      client-only-component:{data.source}
      <Link data-testid="ssr-client-only-home" to="/">Return home</Link>
    </section>
  );
}`,
    language: "tsx",
    path: "src/routes/ssr-client-only.tsx",
  },
  {
    content: `import { Link, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/error')({
  loader: () => {
    throw new Error('official-fixture-route-error');
  },
  errorComponent: ({ error }) => (
    <section data-testid="route-error-boundary">
      <p>{error.message}</p>
      <Link data-testid="error-home" to="/">Return home</Link>
    </section>
  ),
});`,
    language: "tsx",
    path: "src/routes/error.tsx",
  },
  {
    content: `import { Link, createFileRoute, notFound } from '@tanstack/react-router';

export const Route = createFileRoute('/missing')({
  loader: () => {
    throw notFound();
  },
  notFoundComponent: () => (
    <section data-testid="route-not-found">
      <p>Official fixture not found</p>
      <Link data-testid="not-found-home" to="/">Return home</Link>
    </section>
  ),
});`,
    language: "tsx",
    path: "src/routes/missing.tsx",
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
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { Route as aboutRouteImport } from './routes/about';
import { Route as apiEchoRouteImport } from './routes/api.echo';
import { Route as deferredRouteImport } from './routes/deferred';
import { Route as errorRouteImport } from './routes/error';
import { Route as hydrationRouteImport } from './routes/hydration';
import { Route as indexRouteImport } from './routes/index';
import { Route as missingRouteImport } from './routes/missing';
import { Route as ssrClientOnlyRouteImport } from './routes/ssr-client-only';
import { Route as ssrDataOnlyRouteImport } from './routes/ssr-data-only';
import { Route as ssrFullRouteImport } from './routes/ssr-full';

const rootRoute = createRootRoute({
  head: () => ({ meta: [{ title: 'TanStack Start browser E2E' }] }),
  component: () => (
    <html lang="en">
      <head><HeadContent /></head>
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
const errorRoute = errorRouteImport.update({
  getParentRoute: () => rootRoute,
  id: '/error',
  path: '/error',
});
const hydrationRoute = hydrationRouteImport.update({
  getParentRoute: () => rootRoute,
  id: '/hydration',
  path: '/hydration',
});
const deferredRoute = deferredRouteImport.update({
  getParentRoute: () => rootRoute,
  id: '/deferred',
  path: '/deferred',
});
const missingRoute = missingRouteImport.update({
  getParentRoute: () => rootRoute,
  id: '/missing',
  path: '/missing',
});
const ssrFullRoute = ssrFullRouteImport.update({
  getParentRoute: () => rootRoute,
  id: '/ssr-full',
  path: '/ssr-full',
});
const ssrDataOnlyRoute = ssrDataOnlyRouteImport.update({
  getParentRoute: () => rootRoute,
  id: '/ssr-data-only',
  path: '/ssr-data-only',
});
const ssrClientOnlyRoute = ssrClientOnlyRouteImport.update({
  getParentRoute: () => rootRoute,
  id: '/ssr-client-only',
  path: '/ssr-client-only',
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  aboutRoute,
  apiEchoRoute,
  deferredRoute,
  errorRoute,
  hydrationRoute,
  missingRoute,
  ssrFullRoute,
  ssrDataOnlyRoute,
  ssrClientOnlyRoute,
]);

export function getRouter() {
  return createRouter({
    defaultPreload: false,
    history: createMemoryHistory({
      initialEntries: [
        typeof window === 'undefined'
          ? '/'
          : new URL(window.location.href).searchParams.get('path') || '/',
      ],
    }),
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

function renderRoutePath(renderPath: string, pathname: string) {
  const url = new URL(renderPath, "http://tuto.local");
  url.searchParams.set("path", pathname);
  return `${url.pathname}${url.search}`;
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
  const customServerEntryRpcHeaders: Array<string | null> = [];

  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/core-rpc")) {
      customServerEntryRpcHeaders.push(
        response.headers()["x-custom-server-entry"] ?? null,
      );
    }
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

  const deferredSsrResponse = await request.get(
    renderRoutePath(renderPath, "/deferred"),
  );
  const deferredSsrHtml = await deferredSsrResponse.text();
  expect(deferredSsrResponse.status()).toBe(200);
  expect(deferredSsrHtml).toContain("immediate-loader-value");
  expect(deferredSsrHtml).toContain("Loading deferred data");
  expect(deferredSsrHtml).toContain("deferred-loader-value");

  const fullSsrResponse = await request.get(
    renderRoutePath(renderPath, "/ssr-full"),
  );
  const fullSsrHtml = await fullSsrResponse.text();
  expect(fullSsrResponse.status()).toBe(200);
  expect(fullSsrResponse.headers()["x-custom-server-entry"]).toBe("active");
  expect(fullSsrHtml).toContain("full-component:<!-- -->server-full-loader");

  const dataOnlySsrResponse = await request.get(
    renderRoutePath(renderPath, "/ssr-data-only"),
  );
  const dataOnlySsrHtml = await dataOnlySsrResponse.text();
  expect(dataOnlySsrResponse.status()).toBe(200);
  expect(dataOnlySsrHtml).toContain("server-data-only-loader");
  expect(dataOnlySsrHtml).toContain("data-only-pending");
  expect(dataOnlySsrHtml).not.toContain("data-only-component:");

  const clientOnlySsrResponse = await request.get(
    renderRoutePath(renderPath, "/ssr-client-only"),
  );
  const clientOnlySsrHtml = await clientOnlySsrResponse.text();
  expect(clientOnlySsrResponse.status()).toBe(200);
  expect(clientOnlySsrHtml).toContain("client-only-pending");
  expect(clientOnlySsrHtml).not.toContain("client-only-component:");
  expect(clientOnlySsrHtml).not.toContain(
    "client-only loader executed on the server",
  );

  const aboutSsrResponse = await request.get(
    renderRoutePath(renderPath, "/about"),
  );
  const aboutSsrHtml = await aboutSsrResponse.text();
  expect(aboutSsrResponse.status()).toBe(200);
  expect(aboutSsrHtml).toContain("<title>About compatibility fixture</title>");
  expect(aboutSsrHtml).toContain(
    'name="description" content="TanStack Start head metadata fixture"',
  );
  expect(aboutSsrHtml).toContain(
    'rel="canonical" href="https://tuto.test/about"',
  );
  expect(aboutSsrHtml).toContain('type="application/ld+json"');

  const hydrationSsrResponse = await request.get(
    renderRoutePath(renderPath, "/hydration"),
  );
  const hydrationSsrHtml = await hydrationSsrResponse.text();
  expect(hydrationSsrResponse.status()).toBe(200);
  expect(hydrationSsrHtml).toContain("Idle<!-- --> hydration count: <!-- -->0");
  expect(hydrationSsrHtml).toContain('data-ts-hydrate-when="idle"');
  expect(hydrationSsrHtml).toContain("Media<!-- --> hydration count: <!-- -->0");
  expect(hydrationSsrHtml).toContain('data-ts-hydrate-when="media"');
  expect(hydrationSsrHtml).toContain("Visible<!-- --> hydration count: <!-- -->0");
  expect(hydrationSsrHtml).toContain("Condition<!-- --> hydration count: <!-- -->0");
  expect(hydrationSsrHtml).toContain('data-ts-hydrate-when="condition"');
  expect(hydrationSsrHtml).toContain("Never<!-- --> hydration count: <!-- -->0");
  expect(hydrationSsrHtml).toContain('data-ts-hydrate-when="never"');
  expect(hydrationSsrHtml).toContain("Prefetch<!-- --> hydration count: <!-- -->0");

  const renderResponse = await page.goto(new URL(renderPath, baseURL).href);
  expect(renderResponse?.status()).toBe(200);
  const initialHtml = await renderResponse!.text();
  expect(renderResponse?.headers()["x-custom-server-entry"]).toBe("active");
  expect(initialHtml).toContain("Initial Flight rendered in SSR");
  expect(initialHtml).toContain("Deferred hydration count: <!-- -->0");
  expect(initialHtml).toContain('data-ts-hydrate-when="interaction"');
  expect(initialHtml).toContain("server-runtime");
  expect(initialHtml).toContain("server-only:server-environment-secret");
  expect(initialHtml).not.toContain("inline-bound-action:");
  expect(initialHtml).toContain('<article data-testid="composite-card">');
  expect(initialHtml).toContain('<button data-testid="composite-title-slot">');
  expect(initialHtml).toContain("Children supplied by the client route");
  expect(initialHtml).toContain('rel="modulepreload"');
  expect(initialHtml).toContain("data-rsc-css-href");
  expect(initialHtml).toContain("kind=style");
  await expect(page.getByRole("heading", { name: "Browser runtime fixture" })).toBeVisible();
  await expect(page.getByTestId("environment-server-result")).toContainText(
    "server-runtime|server-only:server-environment-secret|createClientOnlyFn() functions can only be called on the client!",
  );
  await expect(page.getByTestId("environment-public-result")).toHaveText(
    "Tuto public environment|undefined",
  );
  await page.getByTestId("environment-client").click();
  await expect(page.getByTestId("environment-client-result")).toHaveText(
    "client-runtime|client-only:/api/serverless/tanstack-start/core-render|createServerOnlyFn() functions can only be called on the server!",
  );
  expect(
    await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __tutoCustomClientEntryLoaded?: boolean;
          }
        ).__tutoCustomClientEntryLoaded,
    ),
  ).toBe(true);
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

  const chunksBeforeDeferredHydration = new Set(routeChunks);
  await expect(page.getByTestId("deferred-hydration-counter")).toHaveText(
    "Deferred hydration count: 0",
  );
  await expect(
    page
      .getByTestId("deferred-hydration-counter")
      .locator("xpath=ancestor::*[@data-ts-hydrate-id][1]"),
  ).toHaveAttribute("data-ts-hydrate-when", "interaction");
  await page.getByTestId("deferred-hydration-counter").click();
  await expect(
    page
      .getByTestId("deferred-hydration-counter")
      .locator("xpath=ancestor::*[@data-ts-hydrate-id][1]"),
  ).not.toHaveAttribute("data-ts-hydrate-when", "interaction");
  expect(
    [...routeChunks].some((url) => !chunksBeforeDeferredHydration.has(url)),
  ).toBe(true);
  await page.getByTestId("deferred-hydration-counter").click();
  await expect(page.getByTestId("deferred-hydration-counter")).toHaveText(
    "Deferred hydration count: 1",
  );

  await page.addInitScript(() => {
    const schedule = globalThis as unknown as {
      __tutoFlushIdleHydration?: () => void;
      cancelIdleCallback?: (handle: number) => void;
      requestIdleCallback?: (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
    };
    const originalRequest = schedule.requestIdleCallback?.bind(globalThis);
    const originalCancel = schedule.cancelIdleCallback?.bind(globalThis);
    let nextHandle = -1;
    const callbacks = new Map<number, IdleRequestCallback>();
    schedule.requestIdleCallback = (callback, options) => {
      if (options?.timeout === 5_000) {
        const handle = nextHandle--;
        callbacks.set(handle, callback);
        return handle;
      }
      return originalRequest
        ? originalRequest(callback, options)
        : window.setTimeout(
            () => callback({ didTimeout: false, timeRemaining: () => 50 }),
            0,
          );
    };
    schedule.cancelIdleCallback = (handle) => {
      if (callbacks.delete(handle)) return;
      if (originalCancel) originalCancel(handle);
      else window.clearTimeout(handle);
    };
    schedule.__tutoFlushIdleHydration = () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      if (originalRequest) schedule.requestIdleCallback = originalRequest;
      else delete schedule.requestIdleCallback;
      if (originalCancel) schedule.cancelIdleCallback = originalCancel;
      else delete schedule.cancelIdleCallback;
      delete schedule.__tutoFlushIdleHydration;
      for (const callback of pending) {
        callback({ didTimeout: false, timeRemaining: () => 50 });
      }
    };
  });
  const hydrationRenderResponse = await page.goto(
    new URL(renderRoutePath(renderPath, "/hydration"), baseURL).href,
  );
  expect(hydrationRenderResponse?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Advanced hydration strategy fixtures" }),
  ).toBeVisible();
  const hydrationMarker = (testId: string) =>
    page
      .getByTestId(testId)
      .locator("xpath=ancestor::*[@data-ts-hydrate-id][1]");

  await expect(hydrationMarker("condition-hydration-counter")).not.toHaveAttribute(
    "data-ts-hydrate-when",
    "condition",
  );
  await page.getByTestId("condition-hydration-counter").click();
  await expect(page.getByTestId("condition-hydration-counter")).toHaveText(
    "Condition hydration count: 1",
  );

  await expect(hydrationMarker("idle-hydration-counter")).toHaveAttribute(
    "data-ts-hydrate-when",
    "idle",
  );
  const chunksBeforeIdleHydration = routeChunks.size;
  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & {
        __tutoFlushIdleHydration: () => void;
      }
    ).__tutoFlushIdleHydration();
  });
  await expect(hydrationMarker("idle-hydration-counter")).not.toHaveAttribute(
    "data-ts-hydrate-when",
    "idle",
  );
  await expect.poll(() => routeChunks.size).toBeGreaterThan(chunksBeforeIdleHydration);
  await page.getByTestId("idle-hydration-counter").click();
  await expect(page.getByTestId("idle-hydration-counter")).toHaveText(
    "Idle hydration count: 1",
  );

  await expect(hydrationMarker("media-hydration-counter")).toHaveAttribute(
    "data-ts-hydrate-when",
    "media",
  );
  const chunksBeforeMediaHydration = routeChunks.size;
  await page.setViewportSize({ height: 720, width: 1500 });
  await expect(hydrationMarker("media-hydration-counter")).not.toHaveAttribute(
    "data-ts-hydrate-when",
    "media",
  );
  await expect.poll(() => routeChunks.size).toBeGreaterThan(chunksBeforeMediaHydration);
  await page.getByTestId("media-hydration-counter").click();
  await expect(page.getByTestId("media-hydration-counter")).toHaveText(
    "Media hydration count: 1",
  );

  const chunksBeforeVisibleHydration = routeChunks.size;
  await page.getByTestId("visible-hydration-counter").scrollIntoViewIfNeeded();
  await expect.poll(() => routeChunks.size).toBeGreaterThan(chunksBeforeVisibleHydration);
  await page.getByTestId("visible-hydration-counter").click();
  await expect(page.getByTestId("visible-hydration-counter")).toHaveText(
    "Visible hydration count: 1",
  );

  await expect(hydrationMarker("never-hydration-counter")).toHaveAttribute(
    "data-ts-hydrate-when",
    "never",
  );
  const chunksBeforeNeverInteraction = routeChunks.size;
  await page.getByTestId("never-hydration-counter").click();
  await page.waitForTimeout(250);
  await expect(page.getByTestId("never-hydration-counter")).toHaveText(
    "Never hydration count: 0",
  );
  expect(routeChunks.size).toBe(chunksBeforeNeverInteraction);

  await expect(hydrationMarker("prefetch-hydration-counter")).toHaveAttribute(
    "data-ts-hydrate-when",
    "interaction",
  );
  const chunksBeforePrefetch = routeChunks.size;
  await page.getByTestId("prefetch-hydration-counter").hover();
  await expect.poll(() => routeChunks.size).toBeGreaterThan(chunksBeforePrefetch);
  await expect(hydrationMarker("prefetch-hydration-counter")).toHaveAttribute(
    "data-ts-hydrate-when",
    "interaction",
  );
  await page.getByTestId("prefetch-hydration-counter").click();
  await expect(hydrationMarker("prefetch-hydration-counter")).not.toHaveAttribute(
    "data-ts-hydrate-when",
    "interaction",
  );
  await page.getByTestId("prefetch-hydration-counter").click();
  await expect(page.getByTestId("prefetch-hydration-counter")).toHaveText(
    "Prefetch hydration count: 1",
  );
  const homeRenderResponse = await page.goto(new URL(renderPath, baseURL).href);
  expect(homeRenderResponse?.status()).toBe(200);
  await expect(page.getByTestId("hydrate")).toBeVisible();

  const directGatewayResult = await page.evaluate(async () => {
    const gateway = new URL(location.href);
    gateway.pathname = "/api/serverless/tanstack-start/core-route";
    gateway.searchParams.set("path", "/api/echo");
    const response = await globalThis.fetch(gateway, {
      body: "direct-body",
      headers: { "content-type": "text/plain" },
      method: "PATCH",
    });
    return {
      body: await response.json(),
      customServerEntry: response.headers.get('x-custom-server-entry'),
    };
  });
  expect(directGatewayResult).toMatchObject({
    body: { body: "direct-body" },
    customServerEntry: "active",
  });

  await page.getByTestId("server-fn").click();
  await expect(page.getByTestId("server-result")).toContainText("Hello Ada");
  await expect(page.getByTestId("server-result")).toContainText("browser-middleware");

  await page.getByTestId("streaming-server-functions").click();
  await expect(
    page.getByTestId("streaming-server-functions-result"),
  ).toHaveText("readable-stream|async-generator");

  await page.getByTestId("formdata-server-function").click();
  await expect(page.getByTestId("formdata-server-function-result")).toHaveText(
    JSON.stringify({
      fileName: "fixture.txt",
      fileText: "fixture-body",
      title: "compatibility-form",
    }),
  );
  expect(customServerEntryRpcHeaders.length).toBeGreaterThanOrEqual(4);
  expect(customServerEntryRpcHeaders.every((value) => value === "active")).toBe(
    true,
  );

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

  await page.getByTestId("deferred-link").click();
  await expect(page.getByTestId("deferred-immediate")).toHaveText(
    "immediate-loader-value",
  );
  await expect(page.getByTestId("deferred-value")).toHaveText(
    "deferred-loader-value",
  );
  await page.getByTestId("deferred-counter").click();
  await expect(page.getByTestId("deferred-counter")).toHaveText(
    "Deferred count: 1",
  );
  await page.getByTestId("deferred-home").click();
  await expect(page.getByTestId("hydrate")).toBeVisible();

  await page.getByTestId("ssr-full-link").click();
  await expect(page.getByTestId("ssr-full-component")).toContainText(
    "full-component:client-full-loader",
  );
  await page.getByTestId("ssr-full-home").click();

  await page.getByTestId("ssr-data-only-link").click();
  await expect(page.getByTestId("ssr-data-only-component")).toContainText(
    "data-only-component:client-data-only-loader",
  );
  await page.getByTestId("ssr-data-only-home").click();

  await page.getByTestId("ssr-client-only-link").click();
  await expect(page.getByTestId("ssr-client-only-component")).toContainText(
    "client-only-component:client-only-loader",
  );
  await page.getByTestId("ssr-client-only-home").click();
  await expect(page.getByTestId("hydrate")).toBeVisible();

  const errorsBeforeExpectedRouteError = browserErrors.length;
  await page.getByTestId("error-link").click();
  await expect(page.getByTestId("route-error-boundary")).toContainText(
    "official-fixture-route-error",
  );
  expect(browserErrors.slice(errorsBeforeExpectedRouteError)).toEqual([
    "Error",
  ]);
  browserErrors.splice(errorsBeforeExpectedRouteError);
  await page.getByTestId("error-home").click();
  await expect(page.getByTestId("hydrate")).toBeVisible();

  await page.getByTestId("not-found-link").click();
  await expect(page.getByTestId("route-not-found")).toHaveText(
    "Official fixture not foundReturn home",
  );
  await page.getByTestId("not-found-home").click();
  await expect(page.getByTestId("hydrate")).toBeVisible();

  const chunksBeforeNavigation = new Set(routeChunks);
  const stylesBeforeNavigation = new Set(routeStyles);
  await page.getByTestId("about-link").click();
  await expect(page.getByTestId("about-route")).toHaveText("Lazy route loaded in the browser");
  await expect(page.getByTestId("about-route")).toHaveCSS("color", "rgb(12, 34, 56)");
  await expect(page.getByTestId("path-alias-component")).toHaveText(
    "Resolved through tsconfig paths",
  );
  await expect(page).toHaveTitle("About compatibility fixture");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "TanStack Start head metadata fixture",
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://tuto.test/about",
  );
  expect(
    await page.locator('script[type="application/ld+json"]').textContent(),
  ).toContain(
    "About compatibility fixture",
  );
  expect([...routeChunks].some((url) => !chunksBeforeNavigation.has(url))).toBe(true);
  expect(
    [...routeStyles].some((url) => !stylesBeforeNavigation.has(url)),
  ).toBe(true);
  expect(browserErrors).toEqual([]);
});
