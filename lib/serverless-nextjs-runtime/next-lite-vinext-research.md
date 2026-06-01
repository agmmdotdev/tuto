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
