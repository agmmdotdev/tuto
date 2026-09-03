# Tuto request-compiled Next runtime

This is the real-Next direction for Tuto. It does not use Next Lite, `next
build`, `next dev`, Wasmer, or a per-student server. Student source is compiled
against a shared, precompiled runtime and executed for a request.

The compiler adapter is intentionally pinned to Next.js 16.2.6 because the RSC
SWC loader options and bundled React Flight modules are internal Next APIs, not
a stable public compiler SDK. A Next upgrade must rebuild the browser kernel
and rerun the compatibility suite.

## Verified in the current checkpoint

| Capability                               | Evidence                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Root `app/layout.tsx` and `app/page.tsx` | Next SWC server transforms render genuine Flight and SSR HTML                                                                 |
| Async Server Components                  | Promise-backed page content is present in Flight and HTML                                                                     |
| Nested App Router pages                  | Static, dynamic, catch-all, and optional catch-all matchers select pages without `next build`                                 |
| Layout composition                       | Root and nested layouts wrap the matched page; route groups are omitted from URL patterns                                     |
| Segment boundary manifest                | Every matched segment retains its own `error.tsx`, `loading.tsx`, and `not-found.tsx` instead of only the nearest file        |
| Error boundaries                         | Server render failures select the nearest eligible segment error UI; client failures use a shared React boundary with reset   |
| Loading boundaries                       | Nested `loading.tsx` files become real Suspense fallbacks in Flight and a hot loading-shell request renders during navigation |
| `params` and `searchParams`              | Next 16-style promised props are resolved for pages and route params are decoded                                              |
| `app/**/route.ts`                        | Route-only workspaces and static/dynamic/catch-all handlers are discovered in the immutable manifest                          |
| Web request APIs                         | Handlers receive Next's real `NextRequest`; native `Request`/`Response` and `NextResponse` execute                            |
| Route methods                            | Next's own method resolver supplies `HEAD`, `OPTIONS`, 405, and invalid-method behavior                                       |
| Handler context                          | Promised dynamic `params`, URL/search params, request headers, cookies, and request bodies are verified                       |
| Route response semantics                 | Status, status text, headers, multiple cookies, JSON, and Web `ReadableStream` bodies cross IPC                               |
| Handler cache/invalidation               | `unstable_cache` and `revalidateTag(tag, { expire: 0 })` share the host-owned adapter                                         |
| Next 16 `proxy.ts`                       | Root and `src/` proxy entries are compiled into the immutable artifact; legacy `middleware.ts` works                          |
| Proxy adapter                            | Next's Web adapter constructs the real request/event and request/work AsyncLocalStorage contexts                              |
| Proxy matchers                           | Next's matcher parser and route matcher apply path patterns plus `has` and `missing` predicates                               |
| Proxy continuation                       | `NextResponse.next()` request headers, response headers, and cookies reach downstream pages/handlers                          |
| Proxy rewrites                           | Internal rewrites re-enter Tuto routing with the rewritten pathname, query, headers, and cookies                              |
| Proxy terminal responses                 | `redirect`, JSON/direct responses, status, headers, cookies, bodies, and `waitUntil` are verified                             |
| `"use client"` boundary                  | Next's server transform produces its client-reference proxy                                                                   |
| Client Component bundle                  | Only the student client closure is bundled against the shared kernel                                                          |
| Browser hydration                        | A Playwright checkpoint verifies `hydrateRoot` and a stateful click when a browser binary is installed                        |
| Immutable generations                    | Source, compiler, kernel, workspace identity, and action salt determine the revision                                          |
| Unchanged request reuse                  | The hot artifact cache returns the same immutable artifact                                                                    |
| Server-only edit                         | A new generation changes only the edited server module; the client manifest and bundle are reused                             |
| Boundary enforcement                     | A client graph importing `server-only` is rejected                                                                            |
| Module-level Server Actions              | Next SWC emits genuine action IDs and browser proxies; Flight `encodeReply`/`decodeReply` carries args                        |
| Captured and bound Server Actions        | Inline closure values are Flight-serialized, artifact-key encrypted, and combined with explicit `.bind()` args                |
| Progressive Server Action forms          | React `$ACTION_ID_*`/`$ACTION_REF_*` fields decode without JavaScript and return refreshed SSR HTML                           |
| Action form hooks                        | `useActionState` form-state replay and `useFormStatus` pending UI work in the shared client kernel                            |
| Action refresh                           | The action result and re-rendered route return in one Flight payload and the browser applies both                             |
| Action proxy lifecycle                   | Generated action POSTs carry `next-action`, args, headers, and cookies through proxy matching/dispatch                        |
| Action rewrites and termination          | Continued/internal-rewritten actions execute; proxy redirects and direct responses short-circuit                              |
| Action request mutations                 | Proxy request headers/cookies reach `headers()`/`cookies()` in both the action and refreshed RSC render                       |
| Action response cookies                  | Proxy/action cookies cross IPC and update a virtual preview jar without mutating Tuto host cookies                            |
| Redirect and not-found control flow      | Next's redirect/not-found errors preserve 307/308/303/404 semantics and select eligible nested not-found boundaries           |
| Preview navigation                       | `next/link`, `useRouter`, raw internal links, redirects, replace, refresh, back, and forward hand off to host-owned history   |
| React `cache`                            | Repeated calls share one value during a render and recompute for the next RSC request                                         |
| `unstable_cache`                         | Next's own wrapper executes inside its work/request AsyncLocalStorage contexts over a Tuto adapter                            |
| Cache Components                         | Next SWC rewrites `"use cache"` functions and async Server Components through its real cache wrapper                          |
| `cacheLife` and `cacheTag`               | Built-in/custom lifetimes and explicit tags are collected inside Next's cache work-unit context                               |
| Cached Client boundaries                 | A cached Server Component can contain a Client Component and round-trip through Flight cache streams                          |
| Patched `fetch`                          | Explicit `next.revalidate`/`next.tags` requests use Next's patched fetch and the host data-cache bridge                       |
| Static and dynamic metadata              | Next's own metadata components resolve `metadata`, `generateMetadata`, parent templates, and URL fields                       |
| Imported global CSS                      | Lightning CSS transforms imported styles and only the matched route's reachable CSS is embedded                               |
| CSS Modules                              | Deterministic scoped names work in Server and Client Components and remain present through hydration                          |
| UTF-8 `public/` assets                   | Text-editable assets are artifact bytes with content types, ETags, conditional GET, and HEAD semantics                        |
| Tag invalidation                         | `updateTag` expires immediately; `revalidateTag(..., "max")` serves stale once and refreshes                                  |
| Path invalidation                        | `revalidatePath` expires entries through Next-generated implicit path tags                                                    |
| Cache generation reuse                   | Entries survive source generations for one workspace while identical keys in other workspaces isolate                         |
| Durable cache values                     | Hashed JSON envelopes round-trip through an AWS-signed S3 API compatible with Cloudflare R2                                   |
| Cross-instance invalidation              | Monotonic coordinator sequences prevent late object writes from resurrecting invalidated values                               |
| Cross-instance cache locks               | Coordinator leases serialize writers; fencing tokens reject computations that predate a newer invalidation                    |
| Secure execution backend                 | SecureExec runs the real RSC/SSR workers in capability-limited V8 isolates without a student-owned process or server           |
| Tenant isolation                         | An isolate is pinned to one workspace; bounded LRU pools evict idle workspaces instead of sharing mutable JS globals           |
| Capability policy                        | Host environment, filesystem writes, child processes, and unlisted outbound origins are denied                                |
| Bounded execution                        | Each isolate has a 256 MB limit, payload/handle/timer/output budgets, and a host-enforced request deadline                     |

The generated browser kernel contains React, React DOM, and Next's compiled
Flight browser client. Its content hash is part of every artifact identity.

## Secure execution mode

Local development continues to default to the faster child-process backend.
The request API refuses that backend on Vercel because a Node child process is
not a hostile-code boundary. Production-shaped execution is selected with:

```dotenv
TUTO_NEXT_EXECUTION_MODE=secure-exec
TUTO_NEXT_SECURE_WORKERS=2
TUTO_NEXT_REQUEST_TIMEOUT_MS=15000
TUTO_NEXT_NETWORK_ALLOWLIST=https://api.example.com,https://cdn.example.com
```

`TUTO_NEXT_SECURE_WORKERS` is the maximum number of warm workspace isolates in
each of the RSC and SSR pools (default 2, maximum 8). Workers are created lazily.
One worker can retain multiple immutable generations of one workspace, but it
rejects an artifact from any other workspace. When the pool is full, the least
recently used idle workspace is terminated before a new one starts. If all
slots are busy, allocation waits instead of exceeding the configured bound.
This is a fixed warm capacity, not a permanent server or sandbox per student.

The sandbox receives only `NODE_ENV` and Next's internal feature flags. Student
module imports are allowlisted by the evaluator; filesystem writes and child
processes are denied by SecureExec as a second boundary. Outbound `fetch` is
denied unless every URL origin, including redirects, is listed in
`TUTO_NEXT_NETWORK_ALLOWLIST`. The host validates response size and keeps the
cache and AES-GCM bridges on unguessable internal endpoints. Cache operations
must also carry the workspace currently active in that isolate.

SecureExec 0.1.0 does not yet expose every Node/browser primitive Next 16 uses.
The compatibility layer supplies Web streams, form-data/file behavior,
`EventTarget`, Web Crypto bridging, and request-local memoization. Two narrow
read-time patches adapt Next's hardened global-fetch assignment and its
`performance.timeOrigin` cache clock. Both patches assert the exact pinned Next
source shape so a Next upgrade fails closed rather than silently changing
semantics.

The production Next bundle keeps `secure-exec` and `isolated-vm` external so
their ESM `import.meta.url` values retain filesystem meaning. The request
route's output trace includes their transitive packages and Linux native ABI
prebuilds. A local `VERCEL=1` production-server smoke reached the built API,
selected SecureExec, and returned SSR HTML successfully; running the same trace
inside Fluid Compute remains the required deployment canary.

The cache boundary is host-owned. Student modules call the real `next/cache`
functions in the RSC worker, while cache reads, writes, and tag mutations cross
IPC into a `NextCacheAdapter` in the trusted host. The default adapter is a
bounded, workspace-scoped memory store. It survives immutable generation edits
and RSC worker restarts within a warm host, but not a Fluid Compute instance
replacement.

The opt-in `DurableNextCacheAdapter` splits the production responsibilities
instead of treating R2 as a database:

- `S3NextCacheValueStore` stores large, workspace-isolated value envelopes in
  R2 or another S3-compatible service. Workspace and cache keys are SHA-256
  path components rather than leaked object names.
- `NextCacheInvalidationCoordinator` owns monotonic mutation sequences, tag
  state, and expiring writer leases. `TransactionalNextCacheInvalidationCoordinator`
  can run over a transactional key-value API such as Durable Object storage.
- `HttpNextCacheInvalidationCoordinator` lets a Vercel host call that
  coordinator across instances. The matching authenticated request handler is
  included so the protocol is not application-specific glue.

This split is required for correctness. R2 is suitable for cache bodies, but an
R2-only adapter cannot atomically order a tag invalidation against an in-flight
write or safely arbitrate cache locks. A linearizable coordinator supplies that
small metadata path while object storage carries the larger and cheaper value
path. A lease captures a coordinator fencing sequence before computation and
the eventual write retains it. Therefore an invalidation that happens during a
slow computation remains newer even if that old computation writes to R2 later.
Coordinator sequences, not wall-clock ordering between Fluid instances, decide
whether a value predates an invalidation.

The host installs the durable adapter explicitly:

```ts
setNextCacheAdapter(
  createS3NextCacheAdapter({
    accessKeyId,
    bucket,
    coordinator: new HttpNextCacheInvalidationCoordinator({
      authorization: `Bearer ${coordinatorToken}`,
      endpoint: coordinatorUrl,
    }),
    endpoint: r2Endpoint,
    region: "auto",
    secretAccessKey,
  }),
);
```

The request API can install the same adapter once per host from environment
configuration:

```dotenv
TUTO_NEXT_CACHE_STORE=s3
TUTO_NEXT_CACHE_S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
TUTO_NEXT_CACHE_S3_BUCKET=tuto-next-cache
TUTO_NEXT_CACHE_S3_REGION=auto
TUTO_NEXT_CACHE_S3_ACCESS_KEY_ID=...
TUTO_NEXT_CACHE_S3_SECRET_ACCESS_KEY=...
TUTO_NEXT_CACHE_COORDINATOR_ENDPOINT=https://cache-coordinator.example/v1
TUTO_NEXT_CACHE_COORDINATOR_TOKEN=...
```

The deployable coordinator in `workers/next-cache-coordinator` exposes the
authenticated protocol through a SQLite-backed Cloudflare Durable Object. Its
outer Worker hashes the workspace key and selects a separate object for every
workspace rather than sending every student through one global object. The
token is sent as a Bearer credential. The package includes a checked-in R2
lifecycle configuration that expires value objects after seven days and aborts
incomplete multipart uploads after one day. Invalidated objects are still
deleted eagerly when read. Lifecycle deletion only turns a later request into a
cache miss; the Durable Object remains the authority for invalidation ordering.

`scripts/load-next-cache-coordinator.mjs` exercises monotonic allocation under
concurrency, single-winner writer leases, release/reacquisition, and an
invalidation racing an older writer fence. It accepts multiple ingress URLs and
can require multiple observed Cloudflare colos for a deployed cross-region
run. The same assertions also run against the in-process protocol in the
serverless Next test suite.

Cache Component values are genuine Flight streams. The worker serializes those
streams for IPC and the host stores them through the same adapter used by
`unstable_cache` and patched `fetch`. Cache Component keys include the immutable
artifact generation, following Next's build-ID safeguard against reusing a
result after the cached implementation changes. Explicit data/fetch cache keys
remain reusable across generations for the same workspace.

Route Handler modules are compiled by the same pinned Next SWC server transform
as pages. The worker evaluates their named method exports, then uses Next's
`autoImplementMethods`, `NextRequest`, request-store AsyncLocalStorage, and
mutable-cookie adapter. Tuto owns route matching and the IPC boundary. Streaming
handlers can produce genuine Web streams, but this checkpoint buffers the stream
before returning it across IPC; chunk-by-chunk host transport remains future
work. The workbench's complete JSON execution envelope is limited to 6 MiB.

Proxy modules use that same server transform. The worker invokes Next's Web
adapter, matcher parser, matcher evaluator, `NextRequest`, `NextResponse`, and
`NextFetchEvent`; Tuto interprets Next's generated control headers and then
dispatches the continued or rewritten request through its immutable router.
Proxy response cookies are also made visible to the downstream request, matching
Next's middleware-cookie propagation. External rewrites are rejected because
the current host has no explicit external-proxy capability boundary.

Generated Server Action calls now enter the same proxy dispatcher as page and
Route Handler requests. The host synthesizes the real action request shape—a
POST with `next-action`, the RSC argument body, content type, and virtual request
headers—before running Next's Web adapter. Continuation and internal rewrites
then execute the action against the resulting URL and request context. Mutable
cookies from the proxy and action are returned to the preview as an encoded
virtual cookie update; they are deliberately removed from the outer API
response so untrusted student code cannot write cookies on Tuto's own origin.
If proxy request overrides remove `next-action`, Tuto cancels action dispatch
instead of executing the action through its out-of-band transport metadata.

Captured inline actions use the shape emitted by Next's SWC transform. Closure
values are serialized through the same React Flight implementation as the page,
encrypted with an artifact-scoped AES-GCM key, and restored before the compiled
action body executes. React's own bound-server-reference metadata then appends
ordinary `.bind()` arguments. The encryption key never enters the browser; the
browser only receives the opaque encrypted closure payload.

React's progressive form protocol is preserved rather than translated into a
Tuto-only action format. SSR emits `$ACTION_ID_*` or `$ACTION_REF_*` fields; the
preview adds only a pinned artifact revision and workspace URL before targeting
the host action endpoint. On POST, the worker calls Flight `decodeAction`, runs
the result in the same request/cache context as a hydrated action, calls
`decodeFormState`, re-renders the route, and passes that state to React DOM SSR
and hydration. This is what makes `useActionState` survive a no-JavaScript form
round trip. `useFormStatus` comes from the precompiled shared React DOM module,
so pending state does not enlarge each student's browser bundle.

The route manifest now retains boundaries per App Router directory. The RSC
model nests Suspense and shared client error boundaries inside the matching
layout, and a server render failure selects the closest boundary that could
legally catch the failing page or layout. The shared kernel supplies reset
without putting host orchestration into student bundles. Flight contains the
segment loading fallback. Because the workbench API uses a buffered JSON
envelope, navigation first requests a lightweight loading-only model from the
already-hot artifact, displays it, and then requests the final route. This is a
two-phase request protocol, not fake chunk streaming.

Navigation is also host-owned. The shared kernel implements the request-runtime
surface of `next/link`, `useRouter`, `usePathname`, and `useSearchParams`.
Internal links and action redirects post a navigation intent out of the
sandboxed `srcdoc` iframe. The workbench maintains the virtual push/replace
stack and issues a new immutable-artifact request, so the iframe never escapes
to a Tuto host URL.

Metadata follows a deliberately different boundary from CSS. Tuto constructs a
loader tree for the matched immutable route and calls Next's own
`createMetadataComponents`, so static `metadata`, dynamic `generateMetadata`,
parent resolution, title templates, viewport defaults, Open Graph, Twitter,
alternates, robots, icons, and the rest of Next's tag generator stay governed by
the pinned Next version. As in Next itself, a layout title template applies to
child route segments, not a page in the same segment.

CSS is bundler functionality rather than an exposed Next compiler API. Tuto
therefore uses Lightning CSS for syntax lowering and deterministic CSS Module
names. CSS imports are retained as dependencies in the immutable artifact;
request dispatch embeds only styles reachable from the selected page, layouts,
and their Server/Client Component closure. The browser bundle imports CSS
Modules as the same class-name map used by server rendering, so hydration sees
identical class attributes without running a development server.

Files under `public/` are stored as bytes inside each immutable generation and
are dispatched after `proxy.ts` continuation/rewrite but before App Router page
or Route Handler matching. Stable public URLs use `max-age=0, must-revalidate`
because a later generation can replace their content, while strong ETags avoid
resending unchanged bytes. The current editor model stores strings, so this
checkpoint supports UTF-8/text-editable assets (including SVG, JSON, manifests,
and robots files). Binary images, fonts, and uploads require an explicit binary
workspace-file representation rather than accidental string coercion.

The R2/S3 value implementation, coordinator protocol, and deployable
Cloudflare Worker/Durable Object package are included. Until that service is
deployed and the environment variables above are configured, the request API
deliberately keeps using its bounded in-process adapter.

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

The shared minified browser kernel is 221,849 bytes before HTTP compression.
This result supports the shared-runtime design: cold compiler initialization is
the expensive event, not every request or ordinary Server Component edit.

A separate SecureExec run on 2026-09-03 measured the same compile-plus-HTML
shape with one RSC isolate and one SSR isolate. Unlike the child-process table,
the RSS values include the isolates because they live inside the Vitest host
process. They are end-of-phase deltas rather than sampled peaks.

| Secure request      |     Wall | Host CPU | Host RSS delta | End RSS   |
| ------------------- | -------: | -------: | -------------: | --------: |
| Cold compile + HTML | 3675.9 ms | 3145.9 ms |     +134.7 MiB | 192.2 MiB |
| Hot unchanged HTML  |   70.0 ms |  146.3 ms |      +15.0 MiB | 207.2 MiB |
| Server edit + HTML  |   61.0 ms |  132.8 ms |      -16.3 MiB | 190.9 MiB |

The secure cold path is about two seconds slower than the earlier child-worker
checkpoint because it initializes two isolates and their compatibility layer.
The important edit path remains request-based: it reuses the warm framework,
compiler cache, manifests, and workspace isolates rather than rebuilding or
restarting Next.js.

## Deliberately not supported yet

- Parallel/intercepted routes, `global-error.tsx`, templates, and route slots
- Chunk-by-chunk Flight/HTML transport (the workbench currently displays `loading.tsx` through its two-phase shell request)
- External proxy rewrites and streaming proxy IPC
- Next's webpack/Turbopack/PostCSS plugin pipeline, Sass, Tailwind directives, and CSS `url()` asset graph rewriting
- Binary public uploads, `next/image` optimization, font optimization, and metadata file conventions such as generated OG images
- Signed artifact capabilities and cross-region coordinator failover
- A deployed Vercel Fluid Compute proof that validates SecureExec native loading, cold memory, concurrency, and termination behavior in Vercel's actual runtime
- Independent security review and fuzzing of the SecureExec 0.1.0 compatibility/capability boundary

The child-process backend only reduces startup cost and contains crashes; it is
not a security sandbox. The Vercel request route therefore accepts only the
SecureExec backend. The local hostile-code suite verifies tenant-global
separation, environment and network denial, forbidden module imports, bounded
LRU eviction, and termination of an infinite CPU loop. That is an engineering
checkpoint, not a substitute for the Vercel deployment proof or a security
audit.

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

The next production slice is a Vercel canary: deploy one Fluid function with
SecureExec enabled, exercise cold/warm/edit requests and concurrent workspaces,
and record native-module loading, wall/CPU/RSS, timeout cleanup, and LRU
behavior. After that, load-test the already-packaged cache coordinator across
regions and fuzz the sandbox capability boundary.
