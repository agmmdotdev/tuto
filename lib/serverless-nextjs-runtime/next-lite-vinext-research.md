# Next-Lite / Vinext Research Notes

Date: 2026-06-01

This note captures the current findings so future work does not restart from generic Next.js/Vite assumptions.

## Goal

We want a lightweight serverless playground path for Next-like apps. The desired runtime shape is:

- fast background compilation from editor files
- small preview/request path
- no Vite/Next compiler loaded inside the request handler
- enough Next-like behavior to make `app/page.tsx`, `layout.tsx`, route handlers, `use client`, and eventually `use server` useful

Full Next.js parity is not the immediate goal.

## Source Checkouts

Local source references:

- `opensrc/repos/github.com/vercel/next.js`
- `opensrc/repos/github.com/cloudflare/vinext`

Use these as source references before making claims about internals.

## Next.js Internals Finding

Next App Router internals are not a good lightweight import target.

The real Next build/runtime behavior is coupled to:

- webpack/Turbopack build graph
- RSC and client component manifests
- server action manifests
- app route modules
- Next build orchestration
- route discovery and generated metadata

Important behavior references in Next:

- `"use client"` is handled by replacing server-layer imports with client reference proxies and emitting client reference manifests.
- `"use server"` uses a custom transform for server actions, stable action IDs, server reference manifests, and runtime action dispatch.
- exact Next behavior is viable only if we run Next/Turbopack/webpack build machinery outside the request path.

Conclusion: Next internals are good behavior references, but bad lightweight compiler dependencies.

## Vinext Finding

Vinext is closer to the desired architecture than raw Next internals, but it is still too heavy for our lightweight compiler target.

Vinext is not a thin wrapper around Next internals. It is a Vite-based reimplementation of the public Next API surface. It uses:

- Vite plugin lifecycle
- `@vitejs/plugin-rsc`
- generated virtual entries for RSC, SSR, and browser
- `next/*` shims
- its own route graph, request pipeline, route handler dispatch, server action execution, middleware, cache, metadata, and rendering runtime

Useful Vinext reuse candidates:

- public `vinext/shims/*`
- public `vinext/server/request-pipeline`
- public `vinext/server/app-router-entry`
- public `vinext/server/prod-server`
- algorithms from internal route graph / route matching / request dispatch files, if vendored carefully

Not cleanly reusable without dragging Vite:

- Vinext compiler pipeline
- virtual entry generation through Vite plugin hooks
- `@vitejs/plugin-rsc` integration
- direct internal modules not exported from the package

Conclusion: Vinext is a strong reference implementation and possible source for selected vendored algorithms/shims, not the default compiler path.

## Measurement Results

Benchmark script:

```bash
yarn measure:offline-compilers --repeat 3
```

Script path:

```txt
scripts/measure-offline-compilers.mjs
```

Measured on this Windows machine with tiny fixtures:

| Case | Median Compile | Median Peak RSS | Output |
| --- | ---: | ---: | ---: |
| `esbuild-react` | 139.4ms | 41.4 MiB | 189.8 KiB |
| `rolldown-react` | 189.0ms | 76.9 MiB | 186.7 KiB |
| `vite-react` | 456.4ms | 123.3 MiB | 186.4 KiB |
| `vinext-app-router` | 2347.6ms | 395.5 MiB | 1262.0 KiB |

Important details:

- Vite 8 uses Rolldown underneath, but Vite still adds config resolution, plugin container setup, HTML/CSS handling, transforms, module graph work, environment orchestration, and output normalization.
- Plain Rolldown is much faster than Vite for the same simple React app.
- Vinext is much heavier because it runs multiple RSC/App Router phases:
  - analyze client references
  - analyze server references
  - build RSC environment
  - build client environment
  - build SSR environment
- `@vitejs/plugin-rsc@0.5.27` failed in this setup inside the RSC assets manifest hook. The benchmark pins `@vitejs/plugin-rsc@0.5.26`.
- React/React DOM were aligned to `19.2.6` for Vinext/RSC compatibility.

Conclusion: Vinext/Vite can be used as a background compiler experiment, but it is not acceptable as the lightweight compiler foundation if the target is low memory and sub-second compile.

## Current Decision

Do not use Vite/Vinext as the default lightweight compiler path.

Use Vinext and Next as references:

- behavior reference
- test fixture source
- possible shims/algorithm source

Build our own constrained Next-like compiler/runtime around direct esbuild/Rolldown where we need low latency and low memory.

## Vinext Reusability Audit

Rechecked with a maintenance/reuse lens.

The installed `vinext@0.0.54` package exposes only a limited public API:

- `vinext`
- `vinext/cache`
- `vinext/shims/*`
- `vinext/server/prod-server`
- `vinext/server/pages-i18n`
- `vinext/cloudflare`
- `vinext/server/image-optimization`
- `vinext/server/request-pipeline`
- `vinext/server/app-router-entry`
- `vinext/config/config-matchers`
- `vinext/server/worker-utils`
- `vinext/utils/query`

Confirmed importability:

- `vinext/shims/server` works.
- `vinext/server/request-pipeline` works.
- `vinext/config/config-matchers` works.
- `vinext/server/app-route-handler-runtime` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- `vinext/dist/server/app-route-handler-runtime.js` also fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

This means depending on Vinext internals through `node_modules` is not safe unless Cloudflare exposes them as supported package exports.

### Modular Pieces

Some Vinext source files are modular enough to reuse by vendoring/forking:

- `src/routing/route-pattern.ts`
  - small, low dependency
  - handles `[id]`, `[...rest]`, `[[...rest]]`, matching, filling, static path normalization
- `src/routing/route-trie.ts`, `src/routing/route-matching.ts`, `src/routing/utils.ts`
  - relatively small routing matcher layer
- `src/routing/file-matcher.ts`
  - small convention helper for page extensions
- `src/server/next-error-digest.ts`
  - small parser for `NEXT_REDIRECT`, `NEXT_NOT_FOUND`, and `NEXT_HTTP_ERROR_FALLBACK`
- `src/server/app-route-handler-policy.ts`
  - useful pure-ish policy helpers for methods, auto-HEAD, auto-OPTIONS, revalidate decisions, and special errors
- `src/server/app-route-handler-runtime.ts`
  - partially reusable, but imports `vinext/shims/server` and middleware helpers

These are better candidates for vendoring than reimplementing from memory.

### Not Modular Enough

These are not good direct reuse targets for a lightweight compiler:

- `src/index.ts`
  - huge Vite plugin, owns config, aliases, virtual entries, env builds
- `src/entries/app-rsc-entry.ts`
  - generated virtual RSC entry, tightly tied to Vite and `@vitejs/plugin-rsc`
- `src/server/app-rsc-handler.ts`
  - request pipeline orchestrator, depends on middleware, cache, i18n, metadata, prerender, RSC normalization, app rendering, route handlers
- `src/server/app-page-dispatch.ts`
  - app page render dispatch, cache, request context, RSC stream/SSR integration
- `src/server/app-page-render.ts`
  - coupled to AppElements, RSC stream metadata, cache, fallback/error control flow
- `src/server/app-page-route-wiring.tsx`
  - handles layouts, templates, slots, boundaries, parallel routes; useful as reference but large
- `src/server/app-route-handler-dispatch.ts`
  - useful behavior but imports cache, instrumentation, request context, headers shims, ISR, middleware, and dispatch execution

For these, copying one file tends to pull a graph of many Vinext runtime modules. That becomes a fork in practice.

### Better Reuse Policy

Avoid two extremes:

- Do not reimplement behavior from scratch when Vinext has a small, isolated module.
- Do not import/copy large orchestration files that recreate Vinext without its build system.

Preferred policy:

1. Use public Vinext exports for shims and request/config helpers.
2. Vendor small isolated source modules with tests and a source header.
3. For large orchestration modules, either:
   - keep our simpler implementation, or
   - explicitly fork/extract a maintained internal package from Vinext.
4. Add tests that preserve Next/Vinext behavior for every vendored helper.

## Next-Lite Reuse Rules

These rules should guide future `next-lite` work.

### Rule 1: Prefer Supported Package Exports

If Vinext exposes a public package export, use that before copying code.

Allowed examples:

- `vinext/shims/server`
- `vinext/shims/*`
- `vinext/server/request-pipeline`
- `vinext/config/config-matchers`
- `vinext/server/worker-utils`

Do not deep-import blocked internals from `node_modules/vinext/dist/...`. If `import.meta.resolve()` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, treat that module as unsupported.

### Rule 2: Vendor Only Small Isolated Modules

Vendoring is acceptable only when the source module is small, mostly pure, and does not pull in the Vinext/Vite/RSC orchestration graph.

Current approved vendored modules:

- `src/routing/route-pattern.ts`
- `src/routing/route-trie.ts`
- `src/routing/route-matching.ts`
- `src/routing/utils.ts`

Current vendored location:

```txt
lib/serverless-nextjs-runtime/next-lite/vendor/vinext-routing/
```

Every vendored file must include:

- source project name
- license note
- original source path

### Rule 3: No Large Orchestration Vendoring By Accident

Do not vendor these classes of files without an explicit fork/extract decision:

- Vite plugin files
- virtual entry generators
- RSC handler orchestration
- App Page dispatch/render lifecycle
- full route handler dispatch with cache/instrumentation/middleware

Examples that should not be copied casually:

- `src/index.ts`
- `src/entries/app-rsc-entry.ts`
- `src/server/app-rsc-handler.ts`
- `src/server/app-page-dispatch.ts`
- `src/server/app-page-render.ts`
- `src/server/app-page-route-wiring.tsx`
- `src/server/app-route-handler-dispatch.ts`

If we need one of these, choose one of:

- keep a smaller local implementation for our supported subset
- ask whether to fork Vinext
- open an upstream/export strategy
- extract a maintained internal package boundary

### Rule 4: Tests Must Lock The Reused Behavior

Every vendored helper or public Vinext shim usage needs tests at our boundary.

Examples:

- route patterns: nested routes, `[id]`, `[...rest]`, `[[...rest]]`, encoded params
- route priority: static before dynamic, dynamic before catch-all
- route handlers: GET/HEAD/OPTIONS method policy
- control flow: redirect/notFound digest behavior

Do not vendor a helper without adding or updating tests that prove why it exists.

### Rule 5: Keep The Compiler Lightweight

Vinext/Vite may be used for research and measurement, but not as the default compiler path for `next-lite`.

The default compiler path should remain direct esbuild/Rolldown unless we explicitly accept the cost of a background Vinext build.

Do not put Vite, Vinext CLI, or Next build machinery into the preview request path.

### Rule 6: Keep Supported Scope Explicit

When a Next feature is added, document whether it is:

- supported
- partially supported
- intentionally unsupported
- delegated to Vinext shim behavior
- vendored from Vinext source

Avoid silent "almost Next" behavior. The maintenance cost comes from ambiguity.

Practical near-term reuse targets:

1. Replace our hand-written dynamic route pattern work with vendored `route-pattern.ts` plus tests.
2. Add route trie/matching from Vinext when nested/dynamic routes begin.
3. Use `vinext/shims/server` for `NextRequest` / `NextResponse` in route handlers.
4. Vendor `app-route-handler-policy.ts` for HTTP method policy.
5. Only consider `app-route-handler-runtime.ts` after route handlers need dynamic/static tracking.

## Proposed Path

1. Create a small `next-lite` compiler/runtime area in this repo.
2. Use Rolldown or esbuild directly for bundling.
3. Start with a constrained App Router subset:
   - `app/layout.tsx`
   - `app/page.tsx`
   - nested routes
   - dynamic segments
   - route handlers
4. Reuse or vendor selected Vinext pieces only when they reduce real risk:
   - route pattern parsing/matching
   - `next/*` shims
   - redirect/notFound digest behavior
   - route handler request/response helpers
5. Implement transforms incrementally:
   - first: `use client` module split and client manifest
   - later: `use server` action extraction, stable IDs, RPC stubs, resolver map
6. Add conformance-style tests from small Next/Vinext-inspired fixtures.

## Non-Goals For Now

- no full Next.js parity
- no runtime request-time Vite/Vinext compile
- no wholesale fork of Vinext unless selective vendoring becomes unmaintainable
- no importing unexported Vinext package internals directly from `node_modules`

## Key Risk

The hardest part is not JSX compilation. The hard part is Next/RSC graph semantics:

- server/client graph split
- client references
- CSS and asset references
- action IDs and server reference resolver
- redirects/not-found/control flow
- streaming and payload formats

Keep the supported subset explicit, and grow it with tests.
