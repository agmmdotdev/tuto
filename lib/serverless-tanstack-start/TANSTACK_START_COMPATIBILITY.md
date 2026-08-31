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
| `deferred-loader-data` | Streaming | **verified** | [Routing](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/routing.md) | Immediate/promised loader values, streamed SSR, Await/Suspense, hydration, and interaction. |
| `selective-ssr` | Rendering modes | **verified** | [Selective SSR](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/selective-ssr.md) | Full, data-only, and client-only initial renders plus client navigation. |
| `deferred-hydration` | Rendering modes | **verified** | [Deferred hydration](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/deferred-hydration.md) | SSR preservation; interaction, idle, media, visible, condition, and never strategies; delayed child chunks; prefetch without hydration; post-hydration interaction. |
| `seo-head-metadata` | Document output | **verified** | [SEO](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/seo.md) | Loader-derived title/meta/Open Graph/canonical/JSON-LD in SSR and navigation. |
| `static-prerendering` | Build output | **partial** | [Static prerendering](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/static-prerendering.md) | Declarative pages, bounded crawling/concurrency/retries, output paths, and the SPA shell emit revision-pinned HTML blobs through the official handler. Executable filters/hooks, automatic route-generator discovery, and third-party deployment packaging remain outside the safe compiler surface. |
| `incremental-static-regeneration` | Build output | **not-verified** | [ISR](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/isr.md) | No preview-host regeneration contract yet. |
| `static-server-functions` | Build output | **not-verified** | [Static server functions](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/static-server-functions.md) | No build-time result generation in request previews. |
| `environment-functions` | Compiler protection | **verified** | [Environment functions](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/environment-functions.md) | Isomorphic/server-only/client-only branch selection, tree-shaking, and wrong-runtime errors. |
| `environment-variables` | Compiler protection | **verified** | [Environment variables](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/environment-variables.md) | Production `.env` layering, server `process.env`, public `VITE_` client values, and secret non-leakage. |
| `import-protection` | Compiler protection | **partial** | [Import protection](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/import-protection.md) | Defaults plus declarative custom specifier/file/scope rules, build/development behavior, mock access, and log deduplication work. Executable RegExp and `onViolation` callbacks remain outside the safe config surface. |
| `custom-entry-points` | Compiler configuration | **verified** | [Client entry](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/client-entry-point.md) / [server entry](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/server-entry-point.md) | Optional `src/client` hydration and `src/server` fetch wrappers preserve the Tuto bootstrap. |
| `path-aliases` | Compiler configuration | **verified** | [Path aliases](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/path-aliases.md) | Root tsconfig/jsconfig aliases resolve across route, client, and server graphs. |
| `spa-mode` | Rendering modes | **partial** | [SPA mode](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/spa-mode.md) | Official shell/root SSR and pending fallback boot the child route in Firefox while server functions/routes stay live. The compiler now stores `/_shell.html` and uses it for unmatched document paths; third-party deployment rewrites remain unimplemented. |
| `vite-plugin-ecosystem` | Compiler configuration | **partial** | [CSS](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/css-styling.md) | CSS and platform Tailwind work; arbitrary Vite plugins are not promised. |
| `vite-dev-server-hmr` | Development server | **out-of-scope** | [Execution model](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/execution-model.md) | Tuto recompiles content revisions with esbuild; no per-student Vite watcher. |
| `non-node-hosting-adapters` | Deployment | **out-of-scope** | [Hosting](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/hosting.md) | Tuto targets its Node 22 request host, not third-party adapter parity. |
| `container-or-microvm-execution` | Execution model | **out-of-scope** | [Execution model](https://github.com/TanStack/router/blob/0caf6b9a2b7e14b0b146c74cc27cb05c19d700a5/docs/start/framework/react/guide/execution-model.md) | Bounded reusable Node workers are the design; no container or microVM per preview. |

## Import-protection configuration

Tuto reads `tanstack-start.config.json` instead of executing student
`vite.config.ts` code in the shared compiler. Its `importProtection` object
supports `enabled`, `behavior`, `mockAccess`, `log`, `include`, `exclude`,
`ignoreImporters`, and the client/server `specifiers`, `files`, and
`excludeFiles` glob arrays. A top-level `mode` of `build` or `development`
selects the corresponding behavior; production revision builds remain the
default.

This retains Start's policy behavior without creating a per-student Vite
process or allowing config callbacks to execute in the compiler host. Because
JSON cannot represent executable `RegExp` and `onViolation` values, the matrix
keeps the broader upstream row partial.

## SPA preview configuration

An optional `spa` object in `tanstack-start.config.json` enables Start's
official shell request path. `enabled` defaults to `true` when the object is
present, and `maskPath` defaults to `/`. Tuto renders the root route and the
configured pending fallback with Start's shell marker, then the browser boots
the matched child route. Server functions and server routes continue through
the same reusable Node worker and remain live.

When enabled, the compiler also renders the shell through that official marker
and stores it at `spa.prerender.outputPath` (default `/_shell.html`). Exact
static documents win first; unmatched document paths receive the stored shell.
Hosting-specific rewrite files are not generated, so the broader SPA-mode row
remains partial.

## Static output configuration

Top-level `pages` and `prerender` fields in `tanstack-start.config.json` select
build-time documents. The safe declarative surface supports per-page
`enabled`, `outputPath`, `autoSubfolderIndex`, `crawlLinks`, `retryCount`,
`retryDelay`, and string `headers`, plus global `concurrency`, `failOnError`,
and `maxRedirects`. Tuto caps concurrency, retries, document counts, and total
HTML bytes.

The compiler renders these pages with the same official Start request handler
inside the existing revision-pinned reusable Node worker pool. It then stores
each HTML document as a content-addressed durable artifact and serves exact
routes with private immutable caching. Server functions and server routes are
not frozen; they continue through the live request gateway.

`autoStaticPathsDiscovery` must be `false` because the virtual esbuild compiler
does not run the upstream filesystem route-generator discovery pass. Executable
`filter` and `onSuccess` callbacks are likewise outside the JSON config surface.
Declare pages directly or enable bounded link crawling instead.

## Next compatibility slice

The next core-runtime slice is static server-function result generation. ISR
and regeneration locking follow it. All of this stays inside the request-based
Node/esbuild architecture; it does not require a watcher, container, or
microVM.
