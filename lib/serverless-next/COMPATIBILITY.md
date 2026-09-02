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
| `"use client"` boundary                  | Next's server transform produces its client-reference proxy                                            |
| Client Component bundle                  | Only the student client closure is bundled against the shared kernel                                   |
| Browser hydration                        | A Playwright checkpoint verifies `hydrateRoot` and a stateful click when a browser binary is installed |
| Immutable generations                    | Source, compiler, kernel, workspace identity, and action salt determine the revision                   |
| Unchanged request reuse                  | The hot artifact cache returns the same immutable artifact                                             |
| Server-only edit                         | A new generation changes only the edited server module; the client manifest and bundle are reused      |
| Boundary enforcement                     | A client graph importing `server-only` is rejected                                                     |
| Bounded execution                        | Reusable RSC and SSR child workers have a 256 MB V8 heap cap and a 15 second request timeout           |

The generated browser kernel contains React, React DOM, and Next's compiled
Flight browser client. Its content hash is part of every artifact identity.

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

The shared minified browser kernel is 219,750 bytes before HTTP compression.
This result supports the shared-runtime design: cold compiler initialization is
the expensive event, not every request or ordinary Server Component edit.

## Deliberately not supported yet

- Nested/static/dynamic route trees, layouts, loading, error, and not-found boundaries
- Server Action request decoding, dispatch, re-render Flight, and progressive enhancement
- Route Handlers in `app/**/route.ts`
- `cache`, `unstable_cache`, `revalidatePath`, `revalidateTag`, and cache tags
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

The next vertical slice should implement the route tree first, then Server
Action dispatch plus a mutation-triggered Flight refresh. Cache and invalidation
lessons should follow only after request identity and action dispatch exist,
because invalidation semantics depend on both.
