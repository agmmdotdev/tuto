# Tuto request-compiled Next runtime

This is the real-Next direction for Tuto. It does not use Next Lite, `next
build`, `next dev`, Wasmer, or a per-student server. Student source is compiled
against a shared, precompiled runtime and executed for a request.

The compiler adapter is intentionally pinned to Next.js 16.2.6 because the RSC
SWC loader options and bundled React Flight modules are internal Next APIs, not
a stable public compiler SDK. A Next upgrade must rebuild the browser kernel
and rerun the compatibility suite.

## Verified in the current checkpoint

| Capability                               | Evidence                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Root `app/layout.tsx` and `app/page.tsx` | Next SWC server transforms render genuine Flight and SSR HTML                                          |
| Async Server Components                  | Promise-backed page content is present in Flight and HTML                                              |
| Nested App Router pages                  | Static, dynamic, catch-all, and optional catch-all matchers select pages without `next build`          |
| Layout composition                       | Root and nested layouts wrap the matched page; route groups are omitted from URL patterns              |
| `params` and `searchParams`              | Next 16-style promised props are resolved for pages and route params are decoded                       |
| `"use client"` boundary                  | Next's server transform produces its client-reference proxy                                            |
| Client Component bundle                  | Only the student client closure is bundled against the shared kernel                                   |
| Browser hydration                        | A Playwright checkpoint verifies `hydrateRoot` and a stateful click when a browser binary is installed |
| Immutable generations                    | Source, compiler, kernel, workspace identity, and action salt determine the revision                   |
| Unchanged request reuse                  | The hot artifact cache returns the same immutable artifact                                             |
| Server-only edit                         | A new generation changes only the edited server module; the client manifest and bundle are reused      |
| Boundary enforcement                     | A client graph importing `server-only` is rejected                                                     |
| Module-level Server Actions              | Next SWC emits genuine action IDs and browser proxies; Flight `encodeReply`/`decodeReply` carries args |
| Action refresh                           | The action result and re-rendered route return in one Flight payload and the browser applies both      |
| React `cache`                            | Repeated calls share one value during a render and recompute for the next RSC request                  |
| `unstable_cache`                         | Next's own wrapper executes inside its work/request AsyncLocalStorage contexts over a Tuto adapter     |
| Cache Components                         | Next SWC rewrites `"use cache"` functions and async Server Components through its real cache wrapper |
| `cacheLife` and `cacheTag`                | Built-in/custom lifetimes and explicit tags are collected inside Next's cache work-unit context        |
| Cached Client boundaries                 | A cached Server Component can contain a Client Component and round-trip through Flight cache streams   |
| Patched `fetch`                           | Explicit `next.revalidate`/`next.tags` requests use Next's patched fetch and the host data-cache bridge |
| Tag invalidation                         | `updateTag` expires immediately; `revalidateTag(..., "max")` serves stale once and refreshes           |
| Path invalidation                        | `revalidatePath` expires entries through Next-generated implicit path tags                             |
| Cache generation reuse                   | Entries survive source generations for one workspace while identical keys in other workspaces isolate  |
| Bounded execution                        | Reusable RSC and SSR child workers have a 256 MB V8 heap cap and a 15 second request timeout           |

The generated browser kernel contains React, React DOM, and Next's compiled
Flight browser client. Its content hash is part of every artifact identity.

The cache boundary is host-owned. Student modules call the real `next/cache`
functions in the RSC worker, while cache reads, writes, and tag mutations cross
IPC into a `NextCacheAdapter` in the trusted host. The default adapter is a
bounded, workspace-scoped memory store. It survives immutable generation edits
and RSC worker restarts within a warm host, but not a Fluid Compute instance
replacement.

Cache Component values are genuine Flight streams. The worker serializes those
streams for IPC and the host stores them through the same adapter used by
`unstable_cache` and patched `fetch`. Cache Component keys include the immutable
artifact generation, following Next's build-ID safeguard against reusing a
result after the cached implementation changes. Explicit data/fetch cache keys
remain reusable across generations for the same workspace.

This interface is the correct extension point for R2, but a production R2
implementation is not included yet. Cache values can live in R2; tag versions
and concurrent invalidation need a coordinated metadata strategy (for example
a Durable Object, Redis, or conditional object writes). Treating R2 as only a
plain key/value drop-in would make concurrent tag invalidation unreliable.

## Local checkpoint measurement

A single local run on 2026-09-02 measured the full compile plus hydratable HTML
request below. These are development-machine directional numbers, not Vercel
benchmarks. CPU and RSS deltas cover the Vitest host process; child-worker memory
is separate and each worker has a 256 MB V8 heap ceiling.

| Request           |      Wall | Host CPU | Host RSS delta | Reuse                                                 |
| ----------------- | --------: | -------: | -------------: | ----------------------------------------------------- |
| Cold workspace    | 1669.3 ms | 952.8 ms |      +58.9 MiB | No transform or artifact hits                         |
| Unchanged request |   34.2 ms |  12.1 ms |       +1.1 MiB | Hot immutable artifact                                |
| Server page edit  |  113.5 ms |  51.5 ms |       +1.1 MiB | 2/3 server transforms and the client transform reused |

The shared minified browser kernel is 220,069 bytes before HTTP compression.
This result supports the shared-runtime design: cold compiler initialization is
the expensive event, not every request or ordinary Server Component edit.

## Deliberately not supported yet

- Full Next segment semantics: parallel/intercepted routes and complete loading, error, and thrown `notFound()` behavior
- Captured inline Server Action arguments, progressive-enhancement form posts, `useActionState`, redirects, and action transitions
- Route Handlers in `app/**/route.ts`
- Middleware/proxy execution and request rewriting
- CSS, static assets, metadata, images, fonts, and arbitrary `next/*` imports
- Durable object storage, signed artifact capabilities, and cross-instance reuse
- A production isolation boundary for hostile student code

The workers reduce startup cost and contain crashes, but a Node child process is
not a security sandbox: student code can still reach ambient JavaScript globals.
The workbench must remain local/explicitly gated until it runs behind Tuto's
production isolation and capability boundary.

Once Server Actions are enabled, deployments must configure one stable
`TUTO_NEXT_SERVER_REFERENCE_HASH_SALT` value so action IDs remain stable across
instances. The local checkpoint generates a process-scoped salt when it is not
configured.

## Checkpoint commands

```bash
yarn build:serverless-next-kernel
yarn test:serverless-next
yarn test:serverless-next-browser
```

The next vertical slice should add Route Handlers with Web `Request`/`Response`
normalization. A durable cache adapter should follow once Tuto chooses the
cross-instance metadata coordinator; that storage decision should not be hidden
inside the student runtime.
