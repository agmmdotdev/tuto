# TanStack Start compatibility

This is the executable compatibility contract for Tuto's TanStack Start
preview runtime. It distinguishes the core paths that are proven today from
official Start features that still need work.

The comparison is pinned to TanStack Router commit
[`0caf6b9`](https://github.com/TanStack/router/tree/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react)
and these installed runtime versions:

- `@tanstack/react-start` 1.168.49
- `@tanstack/react-router` 1.170.32
- `@tanstack/start-plugin-core` 1.171.39
- `@tanstack/start-server-core` 1.169.31
- `@vitejs/plugin-rsc` 0.5.26
- Node 22 request host

The source of truth is
[`tanstack-start-compatibility.json`](./tanstack-start-compatibility.json).
The test suite rejects duplicate rows, stale package versions, missing evidence,
or Markdown drift.

## Status definitions

- **verified**: an automated compiler, request-host, or real-browser test proves
  the supported behavior.
- **partial**: a meaningful subset is proven, but the upstream feature is
  broader than the current evidence.
- **not-verified**: no compatibility promise yet; this is roadmap input.
- **out-of-scope**: deliberately excluded from Tuto's request-based runtime
  design.

## Matrix

| ID | Area | Status | Official source | Current evidence / next gap |
| --- | --- | --- | --- | --- |
| `router-ssr-loaders` | Routing and SSR | **verified** | [Routing](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/routing.md) | Router SSR, loaders, streamed HTML, route chunks, and manifests. |
| `browser-hydration-lazy-routes-css` | Routing and SSR | **verified** | [Routing](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/routing.md) | Firefox hydration, lazy navigation, chunks, and route CSS. |
| `server-functions` | Server functions | **verified** | [Server functions](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/server-functions.md) | Official stubs and handlers over revision-pinned RPC. |
| `server-function-validation-methods` | Server functions | **verified** | [Server functions](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/server-functions.md) | Validators and method metadata. |
| `server-function-control-flow` | Server functions | **verified** | [Server functions](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/server-functions.md) | Errors, redirects, and notFound RPC values. |
| `server-function-middleware` | Middleware | **verified** | [Middleware](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/middleware.md) | Function middleware, context, and Response short-circuiting. |
| `request-middleware-cookies-sessions` | Middleware | **verified** | [Middleware](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/middleware.md) | Request middleware, cookies, sessions, and CSRF. |
| `server-function-response-values` | Server functions | **verified** | [Server functions](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/server-functions.md) | Response status, headers, and body. |
| `server-function-formdata-files` | Server functions | **verified** | [Server functions](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/server-functions.md) | Browser FormData plus File name and content. |
| `streaming-server-functions` | Server functions | **verified** | [Streaming server functions](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/streaming-data-from-server-functions.md) | ReadableStream and async-generator results in Firefox. |
| `server-routes` | Server routes | **verified** | [Server routes](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/server-routes.md) | Request metadata, bodies, responses, and redirects. |
| `rsc-server-components` | React Server Components | **verified** | [Server components](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/server-components.md) | Initial SSR and on-demand Flight. |
| `rsc-composite-components` | React Server Components | **verified** | [Server components](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/server-components.md) | Composite selections, slots, SSR, and hydration. |
| `rsc-client-boundaries` | React Server Components | **verified** | [Server components](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/server-components.md) | Interactive client references loaded from Flight. |
| `rsc-server-actions` | React Server Components | **verified** | [Server components](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/server-components.md) | Module and inline bound actions. |
| `rsc-action-encryption` | React Server Components | **verified** | [Server components](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/server-components.md) | AES-GCM bound arguments and tamper rejection. |
| `rsc-css-resources` | React Server Components | **verified** | [Server components](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/server-components.md) | Client-boundary and pure server-module CSS. |
| `error-boundary-ui` | Routing and SSR | **verified** | [Error boundaries](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/error-boundaries.md) | Firefox route `errorComponent`, `notFoundComponent`, and recovery navigation. |
| `deferred-loader-data` | Streaming | **not-verified** | [Routing](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/routing.md) | Add deferred loader and Suspense hydration fixtures inspired by the official `start-basic` example. |
| `selective-ssr` | Rendering modes | **not-verified** | [Selective SSR](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/selective-ssr.md) | Test per-route full, data-only, and client-only modes. |
| `deferred-hydration` | Rendering modes | **not-verified** | [Deferred hydration](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/deferred-hydration.md) | Add hydration-strategy fixtures. |
| `seo-head-metadata` | Document output | **not-verified** | [SEO](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/seo.md) | Test SSR and navigated head/meta/link/script merging. |
| `static-prerendering` | Build output | **not-verified** | [Static prerendering](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/static-prerendering.md) | Current host is request-time, not static-output generation. |
| `incremental-static-regeneration` | Build output | **not-verified** | [ISR](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/isr.md) | No preview-host regeneration contract yet. |
| `static-server-functions` | Build output | **not-verified** | [Static server functions](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/static-server-functions.md) | No build-time result generation in request previews. |
| `environment-import-protection` | Compiler protection | **partial** | [Import protection](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/import-protection.md) | Server implementation leakage is checked; full policy matrix remains. |
| `custom-entry-points` | Compiler configuration | **not-verified** | [Client entry](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/client-entry-point.md) | Add custom client and server entry fixtures. |
| `path-aliases` | Compiler configuration | **not-verified** | [Path aliases](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/path-aliases.md) | Add workspace tsconfig alias coverage. |
| `spa-mode` | Rendering modes | **not-verified** | [SPA mode](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/spa-mode.md) | SSR is the current target; SPA shell behavior is untested. |
| `vite-plugin-ecosystem` | Compiler configuration | **partial** | [CSS](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/css-styling.md) | CSS and platform Tailwind work; arbitrary Vite plugins are not promised. |
| `vite-dev-server-hmr` | Development server | **out-of-scope** | [Execution model](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/execution-model.md) | Tuto recompiles content revisions with esbuild; no per-student Vite watcher. |
| `non-node-hosting-adapters` | Deployment | **out-of-scope** | [Hosting](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/hosting.md) | Tuto targets its Node 22 request host, not third-party adapter parity. |
| `container-or-microvm-execution` | Execution model | **out-of-scope** | [Execution model](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/execution-model.md) | Bounded reusable Node workers are the design; no container or microVM per preview. |

## Next compatibility slice

The highest-value next slice is deferred loader data, selective SSR, and
SEO/head metadata, followed by path aliases and custom entry points. These
exercise the existing router/SSR and compiler pipelines and do not require
changing the request-based Node/esbuild architecture.
