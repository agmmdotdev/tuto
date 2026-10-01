# Tuto request-compiled Next runtime

This is the real-Next direction for Tuto. It does not use Next Lite, `next
build`, `next dev`, Wasmer, or a per-student server. Student source is compiled
against a shared, precompiled runtime and executed for a request.

The compiler adapter is intentionally pinned to Next.js 16.3.6 because the RSC
SWC loader options and bundled React Flight modules are internal Next APIs, not
a stable public compiler SDK. A Next upgrade must rebuild the browser kernel
and rerun the compatibility suite.

The compiler rejects a browser kernel built against another Next version.
RSC and SSR workers use production mode to match the shared browser kernel;
production Flight redacts uncaught error messages while retaining Next's
control-flow digests for streamed not-found boundaries.

## Next 16.3.6 regression checkpoint

Verified on 2026-10-01 in the Tuto cloud environment with Node 24.19.0,
Yarn 4.13.0, and Linux x64:

- Immutable dependency installation and browser-kernel generation passed.
  The kernel is 229,744 bytes and targets Next 16.3.6 / React 19.2.6 (artifact version 22).
- `yarn test:serverless-next --maxWorkers=1`: 106 tests passed, including SecureExec isolation,
  streaming, cache invalidation, Cache Components, and App Router topology.
  Forcing the entire suite through `TUTO_NEXT_EXECUTION_MODE=secure-exec`
  yields 105 passes and one failure: the Cache Components fixture's nested
  `CachedCard` loses Next's WorkUnitStore. The same isolated test fails on the
  clean merged PR #30 commit `dafe77ff4468120d04e821ccfe533f0b23b6a61d`;
  this is a preexisting SecureExec async-context compatibility gap, not a passing
  Cache Components checkpoint for that backend.
- `yarn test:serverless-nextjs-runtime --maxWorkers=1`: 111 tests passed. The
  parallel run under concurrent browser/build load hit the existing Next Lite
  template's five-second timeout; the serial rerun passed without source changes.
- The seventy-one Next browser checkpoints passed in installed Chromium 151 with
  both child-process and SecureExec execution. They cover hydration,
  persistent navigation, independent slot history, refresh/state retention, native iframe reloads, Server Actions, virtual cookies, forms, and streamed slot-local
  error/not-found boundaries, recursive slots, and ancestor error propagation.
  Seven manual-prefetch cases cover deduplication, invalidation,
  expiry, request context, slot selection, and canonical reloads.
  New navigation cases use a real incremental HTTP response: primary and nested
  slot loading, successive Suspense chunks, cancellation/ordering, streamed
  errors/redirects/notFound, and a partially streamed modal background. Four
  equivalent cases also pass against stock Next 16.3.6; a fifth specifically
  checks Tuto transport cancellation before handing the shell to React.
  Nineteen shared-segment browser cases cover sibling layout/loading reuse with
  fresh primary/nested slot pages, retained layout state, refresh, action-cookie
  invalidation, superseded navigation, receipt expiry and parameterized revisits.
  They also cover pre-display sibling reuse without client mounts, pre-display
  refresh/action-cookie invalidation, failed decoding, late cancellation, retry
  after Link cancellation, and pre-display expiry. Four acknowledgment races
  cover server invalidation, expiry during validation, action invalidation while
  acknowledgment is pending, and superseding navigation/history. The normal
  retained-model path asserts one POST carrying validation headers and fresh
  incremental Flight, without duplicate shell transfer. Two further cases gate
  the body after headers, exercise interactive cancellation/history and failure
  rollback. Failed decoding retains the legacy Flight-transfer fallback. Five
  corresponding
  stock Next16.3.6 production cases pass; fourteen transport/policy cases remain
  Tuto-only. Five runtime/receipt cases cover owner/workspace/header isolation,
  forged hints, epoch/expiry/capacity, fresh leaves, and discarded/replaced children.
  Three decoder unit cases cover lazy Flight traversal without component invocation,
  granted keys, atomic failure/cancellation, graph/resolution bounds, insertion
  gating, bounded eviction and retained request snapshots.
  Three standalone acknowledgment API cases verify bodyless/single-use consumption, fresh
  descendant execution, complete context checks, refresh invalidation and full-ticket rejection.
  Five combined-navigation API cases verify incremental fresh descendants, omitted
  retained output, single-use/context/refresh misses, full-ticket rejection and
  preserved redirect/virtual-cookie headers and cancellation before body consumption.
  Six Route Handler API cases cover tag expiration, literal/page/layout/dynamic
  path invalidation, cross-document/workspace isolation, renewed shell receipts,
  and preserved max-profile stale-while-revalidate behavior. Three unit cases
  exercise mutation races, overlapping invalidations, bounded idle-version
  eviction and partial adapter failure. Five browser cases reject invalidated
  full Flight or shell/layout receipts while retaining the root counter.
  Eight viewport cases cover automatic warming, off-screen cancellation/re-entry,
  intent priority, navigation/history ordering, refresh/cookie-context replay,
  explicit caller ownership after unmount, and per-entry capacity eviction.
  Nine scheduler unit cases cover queue bounds, shared destination interests,
  ordering, invalidation, disposal, and fallback without IntersectionObserver.
  Two production stock Next 16.3.6 viewport/navigation comparisons pass; six
  transport/cache policy cases remain Tuto-specific and are skipped for stock.
  Six Link-intent cases cover hover/touch, disabled links, event handlers and
  refs, local-target eligibility, changed props, refresh and navigation priority.
  Three equivalent visible-behavior cases pass against a stock Next 16.3.6
  production server. Its test fixture uses a dynamic root and a Suspense-wrapped
  control panel to satisfy production prerender requirements; unrelated
  download/new-window links disable stock viewport prefetch in that comparison.
  Eight loading-shell cases cover fresh descendants, full-prefetch upgrade,
  cancellation/history, failed transport recovery, cookies/actions, interceptions,
  streamed control flow and primary/nested slot boundaries. Five corresponding
  production stock cases pass with the history-state differences documented below.
  Firefox was not run because its download hosts
  are denied by the environment's network policy.
- `yarn lint`, `yarn typecheck:tsgo`, and
  `yarn typecheck:next-cache-coordinator` passed. Lint reports three existing
  warnings in the playground and measurement scripts.
- The Next 16.3.6 Turbopack production build passed with Google Fonts CSS
  supplied through `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` and real Space Grotesk
  / IBM Plex Mono WOFF2 files served locally from Fontsource packages. The
  ordinary build's Google Fonts requests are denied by this environment;
  live font retrieval remains unverified. The build retains the existing
  TanStack runtime-store tracing warning.
- A local `VERCEL=1`, SecureExec-enabled production server returned HTTP 200
  for the app, the request control API, and a streamed preview containing the
  Suspense shell, delayed Server Component content, and hydration script.
  A further browser smoke test against the compiled production server consumed
  a prefetch hit, invalidated it after an action/cookie change, and retained the
  root counter with SecureExec. These remain local smoke tests, not deployed
  Fluid Compute canaries.
  A compiled production Link smoke test also consumes a hover-prefetched ticket,
  preserves the root counter and restores history with SecureExec.
  The viewport smoke also warms without hover, consumes a ticket, and retains
  root state and history through the compiled SecureExec production API.
  A shared-segment production smoke also checks sibling reuse, fresh leaf output
  and action-cookie invalidation with retained root state. Its retained-model
  navigation receives `shell-stream-hit` and fresh Flight through one POST,
  with retained root/loading output omitted from that Flight. A browser Fetch
  clone drains the fresh body concurrently with rendering, verifying completion
  without delaying the streamed UI.
  A further compiled SecureExec smoke test validates a loading-shell ticket,
  streams fresh page/Suspense content and applies an action-cookie refresh while
  retaining the root counter.

The explicitly labeled Next 16.2.6 boundary differential and performance
measurements below remain historical evidence; they were not remeasured for
this upgrade. The nested dashboard differential below uses Next 16.3.6.

## Covered by the Next 16.3.6 regression suite

| Capability                               | Evidence                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Root `app/layout.tsx` and `app/page.tsx` | Next SWC server transforms render genuine Flight and SSR HTML                                                                 |
| Async Server Components                  | Promise-backed page content is present in Flight and HTML                                                                     |
| Nested App Router pages                  | Static, dynamic, catch-all, and optional catch-all matchers select pages without `next build`                                 |
| Layout composition                       | Root and nested layouts wrap the matched page; route groups are omitted from URL patterns                                     |
| Templates                                | Root, nested, and slot `template.tsx` files remount around the selected branch without becoming layouts                       |
| Parallel routes                          | Recursively nested named slots are props of their owning layouts; hard requests match branches or select `default.tsx`, with missing defaults returning 404 |
| Intercepted routes                       | `(.)`, `(..)`, `(..)(..)`, and `(...)` markers target a named slot on soft navigation while direct loads use canonical pages  |
| Global error boundary                    | A Client Component `app/global-error.tsx` replaces the root document when no normal segment boundary can handle a failure     |
| Segment boundary manifest                | Every matched segment retains its own `error.tsx`, `loading.tsx`, and `not-found.tsx` instead of only the nearest file        |
| Error boundaries                         | Primary and named-slot failures select the nearest eligible segment error UI while preserving owner layouts and sibling slots |
| Loading boundaries                       | Nested and named-slot `loading.tsx` files become real Suspense fallbacks in Flight and in hot loading-shell requests          |
| Not-found boundaries                     | Primary and named-slot `not-found.tsx` files localize 404 control flow without replacing unaffected sibling branches          |
| `params` and `searchParams`              | Next 16-style promised props are resolved for pages and route params are decoded                                              |
| `app/**/route.ts`                        | Route-only workspaces and static/dynamic/catch-all handlers are discovered in the immutable manifest                          |
| Web request APIs                         | Handlers receive Next's real `NextRequest`; native `Request`/`Response` and `NextResponse` execute                            |
| Route methods                            | Next's own method resolver supplies `HEAD`, `OPTIONS`, 405, and invalid-method behavior                                       |
| Handler context                          | Promised dynamic `params`, URL/search params, request headers, cookies, and request bodies are verified                       |
| Route response semantics                 | Status, status text, headers, multiple cookies, JSON, and Web `ReadableStream` bodies cross IPC                               |
| Handler cache/invalidation               | `unstable_cache` and tag/path revalidation share the host-owned adapter; mutations invalidate workspace-local prefetched Flight and shared layout receipts |
| Next 16 `proxy.ts`                       | Root and `src/` proxy entries are compiled into the immutable artifact; legacy `middleware.ts` works                          |
| Proxy adapter                            | Next's Web adapter constructs the real request/event and request/work AsyncLocalStorage contexts                              |
| Proxy matchers                           | Next's matcher parser and route matcher apply path patterns plus `has` and `missing` predicates                               |
| Proxy continuation                       | `NextResponse.next()` request headers, response headers, and cookies reach downstream pages/handlers                          |
| Proxy rewrites                           | Internal rewrites re-enter Tuto routing with the rewritten pathname, query, headers, and cookies                              |
| Proxy terminal responses                 | `redirect`, JSON/direct responses, status, headers, cookies, bodies, and `waitUntil` are verified                             |
| `"use client"` boundary                  | Next's server transform produces its client-reference proxy                                                                   |
| Client Component bundle                  | Only the student client closure is bundled against the shared kernel                                                          |
| Browser hydration                        | Chromium Playwright checkpoints verify `hydrateRoot` and interaction in child-process and SecureExec modes                     |
| Immutable generations                    | Source, compiler, kernel, workspace identity, and action salt determine the revision                                          |
| Unchanged request reuse                  | The hot artifact cache returns the same immutable artifact                                                                    |
| Server-only edit                         | A new generation changes only the edited server module; the client manifest and bundle are reused                             |
| Boundary enforcement                     | A client graph importing `server-only` is rejected                                                                            |
| Module-level Server Actions              | Next SWC emits genuine action IDs and browser proxies; Flight `encodeReply`/`decodeReply` carries args                        |
| Captured and bound Server Actions        | Inline closure values are Flight-serialized, artifact-key encrypted, and combined with explicit `.bind()` args                |
| Progressive Server Action forms          | React `$ACTION_ID_*`/`$ACTION_REF_*` fields decode without JavaScript and return refreshed SSR HTML                           |
| Action form hooks                        | `useActionState` form-state replay and `useFormStatus` pending UI work in the shared client kernel                            |
| Action refresh                           | The action result returns in Flight; the browser requests a state-aware refresh of its active branches                             |
| Action proxy lifecycle                   | Generated action POSTs carry `next-action`, args, headers, and cookies through proxy matching/dispatch                        |
| Action rewrites and termination          | Continued/internal-rewritten actions execute; proxy redirects and direct responses short-circuit                              |
| Action request mutations                 | Proxy request headers/cookies reach `headers()`/`cookies()` in both the action and refreshed RSC render                       |
| Action response cookies                  | Proxy/action cookies cross IPC and update a virtual preview jar without mutating Tuto host cookies                            |
| Redirect and not-found control flow      | Next's redirect/not-found errors preserve 307/308/303/404 semantics and select eligible nested not-found boundaries           |
| Preview navigation                       | `next/link`, `useRouter`, raw links, replace/refresh and native back/forward apply Flight to the current document with per-entry slot state   |
| Link viewport and intent prefetch        | Shared observer queues visible local page tickets; hover/touch has priority; off-screen/unmounted Links cancel owned pending work; `prefetch={false}` disables warming and navigation takes priority |
| Loading-shell prefetch                   | Default/auto Link intent stops eligible branches at their first loading boundary; validated provisional UI precedes a separate fresh streamed navigation |
| Shared layout/loading templates         | Validated shell receipts reuse held templates across sibling destinations; fresh slot/page Flight, context checks, expiry and invalidation remain |
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
| Bounded streaming                        | Flight, SSR HTML, and Route Handler bodies use 256 KiB pull chunks, backpressure, cancellation, idle deadlines, and a 16 MiB cap |
| Streaming preview capability             | The control request issues an opaque five-minute capability; the iframe performs the one real streamed page or GET handler request |

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
prebuilds. The pinned `node-stdlib-browser` dependency has a narrow Yarn patch
so its ESM self-relative polyfills still resolve when Next exposes a global
`require`. A local `VERCEL=1` production-server smoke reached the built API,
selected SecureExec, and streamed a Suspense shell through the real HTTP route.
With a 1.2 second delayed component, that run observed the shell at about 2.1
seconds on the first cold isolate and 24 ms on the warm request; delayed content
arrived at about 3.0 and 1.22 seconds respectively. These are local diagnostic
numbers, not Fluid Compute benchmarks. Running the same trace inside Fluid
Compute remains the required deployment canary.

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
handlers retain their chunk timing across both the child-process and SecureExec
boundaries. SecureExec 0.1.0 buffers its HTTP-server bridge, so Tuto uses an
explicit pull protocol: each bridge call returns at most 256 KiB, the SSR input
channel acknowledges writes according to consumer demand, cancellation
propagates into the worker, and the worker terminates a response after 16 MiB.
The workbench's non-streamed JSON execution envelope remains limited to 6 MiB.

For page previews and GET Route Handlers, the JSON control request compiles the
immutable artifact but does not execute it a second time. It returns an
unguessable, process-local capability with a five-minute lifetime. The sandboxed
iframe follows that URL and receives the real streamed response. For pages,
Flight is teed into SSR and a bounded hydration copy; the HTML shell and
Suspense fallback can arrive before a delayed Server Component, while hydration
begins when the completed Flight payload is appended. Navigating away cancels
the worker streams and releases the workspace lease.

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
model nests Suspense plus shared client error and not-found boundaries inside
the matching branch. A server render failure selects the closest boundary that
could legally catch the failing page or layout, reconstructs only that branch,
and preserves its owner layout and sibling slots. A boundary cannot catch an
error thrown by its own layout or boundary module, so selection moves outward
to the next eligible owner, matching Next's component-tree topology. The shared
kernel supplies reset and HTTP-not-found recognition without putting host
orchestration into student bundles. Flight contains the segment loading
fallback. Because the workbench API uses a buffered JSON envelope, navigation
first requests a lightweight loading-only model from the already-hot artifact,
displays it, and then requests the final route. This is a two-phase request
protocol, not fake chunk streaming.

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

## App Router topology

Parallel route folder names do not enter the public URL. For each named slot,
a hard request independently matches the current URL against that slot's page
branches and falls back to its `default.tsx`. A slot without either match makes
the hard request a 404, matching the important full-reload safety rule. A slot
that only contains `default.tsx` is supported, which is useful for an initially
empty modal.

The hydrated preview owns state-only native history entries. Each entry stores
its visible virtual URL and the independently selected primary/named branches.
The server validates the generation, page identities, branch URLs, and layout
owner parameters before rendering those branches. Soft navigation matches the
new URL, retaining unmatched active slots and implicit children under unchanged
owners. Back/forward restores the saved branch selection rather than inferring
it from a previous URL; `router.refresh()` re-renders that same selection.

Flight navigation responses are applied to the existing React root and preview
document. Layout identities follow physical directories and dynamic owner
parameters. Bounded React Activity caches preserve client state in visited
branches (up to eight entries at each branch boundary); eviction or a new source
generation remounts that state. Defaults remain leaf fallbacks for named slots.
Implicit `children` defaults restore a slot-only hard load beneath its owning
layouts. New route CSS arrives with the navigation response.

An intercepted photo retains its background tree during soft navigation and
refresh, closes on back, and reopens on forward. A fresh hard request uses the
canonical photo page. Successful navigation also updates the private preview
capability's current URL, guarded by a per-document session and monotonic
sequence, so native iframe reloads hard-render that URL rather than the initial
background. The capability remains process-local and expires after five minutes.
The workbench keeps the iframe mounted across response tabs; manual Send and
source saves deliberately start a fresh document/generation.

`usePathname` and read-only `useSearchParams` react to URL changes. `useParams`
merges the selected branches, and selected-layout-segment hooks use their owning
layout context. The pinned 16.3.6 implementation exposes `(__SLOT__)` in named
slot segment arrays and selects the last named-slot segment; Tuto follows that
observed behavior rather than silently filtering internal/group segments.

Stock Next 16.3.6 without Cache Components was exercised with the same fixture
for retained active slots/layouts, refresh, modal back/forward, error reset,
not-found, slot-only hard defaults, replace, and hash navigation. It remounts
visited pages after leaving them; Tuto's bounded Activity cache additionally
preserves their state. This is an explicit behavior difference, not proof of
Next's complete Cache Components/bfcache implementation. The Tuto browser suite
also exercises its actual POST/GET capability transport and sandboxed iframe.

Navigation POST responses stream the Flight envelope, including independently
resolving primary/nested slot subtrees, into the existing React root. A React
transition reveals each changed branch's `loading.tsx` while owner layouts stay
interactive. The branch cache contains its own loading/error boundaries, so a
new entry can show loading without replacing its shared owner. URL/history
ownership follows the root's commit; newer requests invalidate older ownership.
Before a model is handed to React, superseding navigation aborts its transport
and propagates request cancellation to the worker stream. After React owns it,
the remaining Flight is drained: aborting then would reject unresolved references
in retained/hidden Activity branches and can remount the background. This keeps
existing worker bounds; it does not promise immediate termination of an already
rendered background task or concurrent execution within a SecureExec workspace.

Streamed redirects preserve Next's control-flow digest and push/replace kind;
custom error/not-found boundaries receive late failures after headers are sent.
Such responses retain HTTP 200. Without a loading boundary, the transition keeps
the previous view until the changed tree can commit. Prefetch uses the bounded
full/shell ticket paths described below. PPR, `bfcacheId`, native host-address-bar URLs and full unknown-route/global
fallback state preservation are not established by this checkpoint. Server
Actions use the current virtual URL and schedule an additional state-aware
refresh after receiving their result. They do not await its React commit inside
the action promise, which would deadlock a pending `useActionState` transition.
Action Flight itself remains buffered.

Manual `router.prefetch(href, {onInvalidate})` and explicit `prefetch={true}` Link intent opt into a full page Flight
render. It does not render or hydrate that tree in the document, change history,
apply response cookies, or update the reload capability. A completed eligible
render receives an opaque single-use ticket. The navigation endpoint consumes
that ticket instead of rendering again, retaining the normal URL/sequence and
capability handling. A server roundtrip is still required on cache hits.

Keys include artifact identity/revision, document owner, pathname/query, all
normalized request headers (including cookies/auth), and the independently
selected primary/slot state. Transport IDs and URL hashes do not affect the key.
A route/slot change clears unused document entries; a new document/generation
starts with an empty cache. Refresh and actions clear client entries and bump
server artifact epochs before and after execution. A speculative render that
races an invalidation cannot publish its old epoch. Cookie changes clear entries.
Expired, evicted, context-mismatched or invalidated tickets fall back to fresh
streamed navigation. Subscribers are notified once on invalidation/expiry, and
also if a ticket misses server-side. Callback rescheduling cannot mutate the
entry set being invalidated.

The conservative limits are 30 seconds, eight tickets per document, one active
client prefetch, one MiB per Flight payload and sixteen MiB / 128 tickets per
process. Real navigation cancels speculative work rather than waiting for it.
New prefetch calls during navigation are ignored until the newest navigation
commits or fails. A superseded request cannot clear the newer navigation guard.
Disconnect cancellation releases the worker stream. Handlers, public assets,
unknown/slot-only destinations and all proxy workspaces skip prefetch; ordinary
navigation still handles them. Failed/control-flow/cookie-setting responses are
not cached. Explicit prefetch renders Server Components and their data reads;
as in stock Next, these render functions must be pure. This path does not
dispatch Server Actions or invoke route handlers/proxy middleware. See the pinned
[Next prefetch guide](https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/prefetching.mdx)
for its render-purity and partial-prefetch semantics.

Tickets are process-local. Another instance safely misses a ticket; this is not
a distributed router cache or an out-of-band invalidation subscription. Mutations
outside this document's action/refresh flow and this process's API epoch need a
refresh or expire at the bounded lifetime. There is no PPR/static-vs-dynamic
analysis, generalized segment caching, or Next five-minute static cache.
Validated loading-shell layout/loading template reuse is described below.

Link mouse-enter and touch-start run the user's handler, then warm local page
destinations using this same cache. `false` disables both; `true` uses the
full-ticket path. `"auto"`, `null` and the default select a loading shell when
the selected route tree has an eligible boundary. Routes without one retain
the existing full-ticket behavior; there is no static/dynamic classification.
External, download, new-window and same-path/query hash-only links do not warm.
Ordinary click, modifier keys, forwarded refs, prevented clicks, replace and
scroll options retain their behavior. The raw-anchor fallback is installed
after React's delegated handlers so it respects their `preventDefault()`.
SSR and hydration use the same Link implementation and omit runtime-only props
from the DOM. Link intent also runs in Tuto's learner preview; stock hover
prefetch is production-only.

### Viewport scheduling limits

One IntersectionObserver per preview document registers eligible mounted Links.
Actual viewport intersections use a conservative `0px` margin; pinned stock Next
uses `200px` and enables viewport warming only in production. Tuto also enables
it in learner previews. The scheduler allows one active speculative request and
eight queued destination/context/strategy keys. Earlier Links in a visibility
batch have priority. Hover/touch intent takes priority over queued viewport
work and aborts an active viewport-owned request for a different destination.
Navigation and pending Server Actions pause all Link speculation.

A destination shared by several Links remains active while any source is
visible. Leaving the viewport, disabling/retargeting a Link, hiding its Activity
branch, or unmounting removes that source; owned pending work aborts when all
sources leave. Completed tickets stay in the existing eight-entry, bounded-TTL
cache. Capacity evicts one oldest entry and notifies only its subscribers;
it does not invalidate/replay every visible destination. Queue overflow drops
lowest-priority/oldest tasks until a later intent, re-entry or context change.
An explicit `router.prefetch` caller joining a Link request owns that request,
so Link cancellation alone cannot abort it; navigation/context invalidation can.

Refresh, route/slot context changes, actions and virtual cookie changes clear
old entries and reset visible attempts. Eligible visible Links replay after
the newest navigation/action settles in the updated request context. Timed
expiry waits for later intent or re-entry instead of creating background polling.
Browsers without IntersectionObserver retain intent-only warming, with no
automatic invalidation replay. There is no focus trigger or network-adaptive
budget. Standalone manual prefetch remains immediate and can retry if another
speculative request is active.

The existing intent and shell transport cases explicitly disable the observer
to verify that fallback independently; navigation-only fixture Links opt out
of speculation. The new real-HTTP viewport cases exercise the actual observer
and cancellation, including fresh cookie context and capacity callbacks.
Stock comparisons prove visible warming, distant-link exclusion and retained
layout/navigation behavior; they do not establish stock segment-cache/PPR
scheduler equivalence. The pinned
[Next Link scheduling implementation](https://raw.githubusercontent.com/vercel/next.js/v16.3.6/packages/next/src/client/components/links.ts)
provides the observer, visibility, intent and invalidation reference.

### Loading-shell ticket limits

The shell renderer follows the legacy, non-PPR first-loading-boundary cutoff
in pinned Next's
[component-tree builder](https://raw.githubusercontent.com/vercel/next.js/v16.3.6/packages/next/src/server/app-render/create-component-tree.tsx).
Each selected primary/slot branch stops at its first eligible loading boundary;
branches without one defer their leaf. Layouts below a cutoff and their owned
descendant slots do not execute. Metadata is deferred to fresh navigation.
Layouts/loading components above the cutoff still execute and must be pure.
A module-evaluation guard regression proves the nested page is not imported
during its outer shell prefetch.

Full and automatic strategy keys are distinct. A completed full ticket can
satisfy either intent; a later full intent can upgrade a completed shell.
Link intent queues behind the active bounded scheduler; standalone manual calls
while speculation is busy can retry later.
Shell tickets retain the same revision, document-owner, complete-header,
selected-slot, epoch, size and expiry checks. They cannot satisfy a full-page
navigation. Refresh/actions invalidate both strategies.

Navigation first consumes/validates the shell ticket through one endpoint
request. A hit sends complete shell Flight. Its RouterRoot is provisional:
display does not own the global router state, virtual URL, history, cookies or
reload capability. A second request, without a ticket and with the original
slot selection, executes fresh streamed page work through the existing transport.
This is deliberately two roundtrips. It does not splice cached Flight bytes or
implement a PPR continuation. Validated shared templates can now omit repeated
layout/loading rendering, as described below. The shell's
loading UI may appear while the virtual URL still identifies the previous entry;
normal navigation owns that entry when fresh Flight commits.

Existing cached client branches and unaffected slots are preserved during
provisional display; a visited target can stay visible with its old client state
until fresh Flight updates it. New targets show the prefetched loading UI.
Cancellation before handing fresh Flight to React aborts transport and adds no
canceled history entry. A fresh transport failure restores the committed model
and releases the prefetch guard. Once React owns fresh unresolved references,
the existing bounded drain policy applies. Fresh Flight retains its normal
error/notFound/redirect and response-cookie behavior.

Eight real-HTTP browser cases pass with both execution backends. Fresh execution
uses a controlled next-request header probe because SecureExec's existing timing
mitigation freezes its wall clock; absolute timestamp comparisons use child
execution and stock Next only. Five stock production cases compare first-load
loading/freshness, cookies, modal background/refresh/history, streamed control
flow and parallel loading. Stock remounts the dynamic page/modal counters on
back/forward in this fixture (zero); Tuto retains its bounded Activity entries
(one). Layout/sibling state remains preserved. The stock fixture uses a dynamic
root and Suspense-wrapped controls and moves the unit-only module guard into its
page function to permit compilation. These are recorded behavioral differences,
not full App Router or Cache Components/bfcache parity.

Seven Tuto browser cases exercise deduplication, refresh, action/cookie changes,
expiry/subscriber callbacks, slot-context changes, intercepted reloads and a
server-side miss after another document's action. Four stock Next 16.3.6 cases
compare visible state/history, refreshed navigation, action cookie context and
retained slots. The dynamic fixture's default stock prefetch uses its PPR/AUTO
strategy and did not fire the unused-entry callbacks on refresh/action; Tuto's
explicit full ticket invalidation does. Tuto's artifact-local mutation counter
is checked only in Tuto: stock action/RSC bundles do not share that fixture's
module counter. These comparisons do not establish identical cache strategies.

### Validated shared layout/loading templates

A completed, error-free automatic shell can issue an opaque segment receipt.
Its prefetch response includes the already validated shell Flight bytes (at most
one MiB before base64 encoding). The browser decodes the shell during prefetch
and collects only granted, cacheable layout/loading templates without invoking
or mounting client components. Flight decoding can evaluate client modules and
resolve lazy references; module-level side effects are not deferred until display.
It advertises only templates it still holds. The API overwrites raw renderer hints
and resolves receipts against the exact artifact object, revision/generation,
document owner, normalized complete headers (including cookies/auth), mutation
epoch and thirty-second expiry. Forged keys and another owner/workspace/context
miss safely. Proxy workspaces are excluded. Receipt metadata is capped at eight
receipts per document, sixteen keys per receipt, and 128 receipts per process.
Parameterized revisits select the held template matching the requested key; an
active component cannot keep another parameter selection's template by accident.
Keys over 4096 characters or layouts with over 64 rendered holes are ineligible.

Keys identify module path, concrete params and declared owned slot names.
Params are conservatively complete for each selected branch, so changing a
child's dynamic params may miss an otherwise shared ancestor. Current slot
selections are **not** captured as the template's future children: each navigation
rebuilds/matches its primary and recursive owned-slot branches and passes them
through scoped holes. LayoutScope/router metadata is fresh even when the
surrounding server layout output is reused. Only holes actually rendered by the
Layout are authorized, so discarded children do not execute or gain receipts.
Explicit child replacement through cloneElement is preserved too. Unticketed
initial/fresh layouts carry their children in the normal template and retain
normal render behavior; generalized child-type introspection is not a parity claim.

A valid held template makes the worker omit that layout/loading component from
Flight. The browser composes its retained template with fresh child/slot Flight.
It keeps root/layout client state, nested ownership and streamed error/notFound,
redirect/action and history behavior. The sibling fixture asserts identical
layout/loading diagnostic output across navigation, while the next page executes
with fresh data. The API test also asserts omitted shared output and emitted
fresh page output. Diagnostic module counters measure render calls for these
fixtures; they are not recommended application side effects or a broad benchmark.

The document holds at most sixteen reusable templates. Requests pin their
advertised templates until completion, or a prefetched ticket's expiry/eviction,
so another response cannot evict a referenced model before Flight resolves.
Existing Activity entries independently retain their mounted client models.
Refresh/actions/virtual cookie changes clear local reusable templates and receipts;
server-side epoch changes make other documents' receipts miss. Before another
request, templates with no live local receipt are pruned. An expired template
cannot be reauthorized by a newly issued receipt with the same context/key.
Active response snapshots remain available until their own completion.

Reuse can start before the first shell display: warming one sibling allows the
next sibling to reuse its decoded parent templates. Dynamic descendants do not
execute during automatic shell decoding. Collection is staged and published only
while the entry is current, uncanceled and unexpired. Traversal is bounded to
4096 distinct objects and 4096 lazy resolutions with a two-second deadline;
failure falls back to normal ticket validation and rendering. Cancellation or
expiry removes an unfinished entry so the destination can be warmed again.
Only shell-derived templates enter the reusable map: unticketed dynamic page
output and explicit full prefetches do not populate it. A successful bounded
decode also retains the complete shell model with its ticket, within the existing
eight-entry document limit and thirty-second expiry. Expiry/eviction/invalidation
releases the entry; an in-flight navigation owns its consumed model and pinned
templates until completion. The prefetch decode never owns visible UI,
URL/history, cookies or styles.

Navigation with an unexpired decoded shell uses one POST for ticket validation
and fresh streamed navigation. The server consumes the same single-use ticket
with exact artifact object/epoch, owner, URL/search, complete headers, mode and
slot-state checks, then executes fresh page/slot work even on a miss. A
`prefetchShellStream` request receives `shell-stream-hit` or `shell-stream-miss`
in the normal response headers. The hit acknowledges the retained shell; the
body contains fresh Flight rather than retransmitting that shell. Full tickets
cannot supply this fresh body. Redirect/status/cookie/capability handling remains
part of the ordinary fresh response.

Before display, the browser applies fresh virtual cookies and rechecks local
epoch, expiry, complete context, sequence and Flight response shape. A cookie
change, redirect or miss skips provisional display. The retained model becomes
visible as soon as validated response headers arrive, while fresh content streams
through its existing boundaries. Headers still wait for fresh response metadata;
this does not promise zero server latency or independent shell acknowledgment
before that metadata exists. Root updates publish normally rather than deferring
another transition, preventing a retained Activity branch from remaining on its
previous model after Flight resolves. Root/layout fibers and
state remain intact. Only the fresh commit owns URL/history. Cancellation before
fresh rendering aborts transport; after rendering, bounded Flight drains while
sequence checks prevent canceled history ownership. The API directly cancels the
worker reader on request abort, including when no body consumer has started; a
backpressured TransformStream write cannot hold the worker lease. Actions cancel
pending navigation transport before starting when React has not consumed it, so
an invalidated destination cannot hold the worker while mutation waits. A body
failure before fresh
rendering restores the committed model and releases navigation.

Failed speculative decoding retains the legacy validation-only shell-Flight
response followed by a separate fresh request. The standalone bodyless 204
`shell-ack` protocol remains available to older callers; the current decoded
browser path uses combined validation and streaming. Neither fallback grants
shared cache reuse across owners or changed contexts.
A missed/expired/evicted receipt renders layouts normally. Process changes miss
receipts safely, with no distributed segment cache. Data mutations outside the
host cache revalidation bridge and known action/refresh epochs still require
refresh or expiry. Reused server layout
output deliberately stays fixed within that lifetime, matching the shared-layout
retention goal; render-time authorization must not rely on an always-rerendered
layout. Fresh page/actions still execute their own request-context checks.

This increment leaves dynamic descendants fresh and makes no static/session/data
classification. It is not Next's complete segment cache, PPR continuation,
per-segment staleTimes/tag subscriptions or full bfcache/Cache Components reuse.
The pinned [Next prefetch guide](https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/prefetching.mdx)
is the reference for shared parent layouts and fresh sibling leaves. Stock cases
compare visible layout/loading stability, refresh and action cookies; Tuto's
transport receipts and bounded policy are explicitly separate.

### Tag/path revalidation and speculative render reuse

The child-process IPC bridge and SecureExec HTTP bridge route completed Next
tag/path mutations through `revalidateNextCacheTags`. Next's own `revalidatePath`
generates implicit tags; no separate guessed URL-to-tag mapping is introduced.
Before entering the data adapter, and again on settlement (including partial
failure), a workspace version changes. Artifact epochs observe that version:
unused full Flight tickets, loading-shell tickets, and layout/loading receipts
from any owner or hot revision of that workspace miss. Other workspaces keep
their tickets. Invalidation versions keep 128 idle workspaces plus active
mutations; idle eviction changes identity on the next lookup and therefore
causes a conservative miss rather than resurrecting old receipts.

New speculative tickets/receipts cannot be issued or consumed while mutations
are pending. Overlapping mutations remain fenced until every operation settles,
and a render started before or during a mutation cannot publish a reusable
ticket afterward. Receipt keys change with the epoch, so a fresh grant cannot
reauthorize old held layout models. A miss still returns normal fresh streamed
navigation and invokes the existing browser invalidation subscriber once when
that unused entry is consumed. Root/layout client fibers retain their state.
Already-consumed navigation snapshots remain pinned until completion; this is
not a retroactive cancellation of active renders or mounted history entries.

Eviction is deliberately workspace-wide, even for a tag/path unrelated to a
particular prefetched destination: shell models do not yet carry complete
dependency metadata, including inherited models from sibling reuse. This does
**not** flush the entire data cache. The adapter retains its normal selective
tag/path expiration and stale profiles. `revalidateTag(tag, "max")` can therefore
serve stale data on the first **fresh** render and refresh it in the background;
`{expire:0}` blocks on a miss. Five stock Next 16.3.6 production cases compare
these data-cache semantics on new document requests for tag, page, layout,
dynamic page-pattern, and max-profile invalidations.

These comparisons do not establish identical client Router Cache behavior.
Tuto conservatively rejects server-validated tickets on their next use after
an out-of-band Route Handler mutation. Documents receive no push notification or eager
`onInvalidate` callback from an external mutation. Invalidations performed in
another process, a coordinator directly, or a database without the local host
bridge are not observed by this process-local fence. Cross-instance invalidation
and dependency-selective speculative eviction remain separate work. Two compiled
SecureExec production browser cases verify full/shell misses, fresh Flight and
root state after invoking a real Route Handler through the control API.

The pinned [revalidateTag reference](https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/04-functions/revalidateTag.mdx),
[revalidatePath reference](https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/04-functions/revalidatePath.mdx),
and [previous-model caching guide](https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/caching-without-cache-components.mdx)
define the underlying Next data-cache behavior.

Named slots can nest recursively, including repeated names under different
owners, route groups, dynamic/catch-all parameters, and slots inside an
intercepted branch. Each slot requires a layout in its owner directory. The
manifest assigns each page to its nearest slot; rendering, style collection,
and boundary lookup recurse only through the layouts selected for the request.
Inactive owners do not activate their descendant slots.

An unmatched `default.tsx` is a leaf fallback: it does not mount that slot's
normal layout or its descendant slots. Default props contain only parameters
from its ancestor segments. A page error or `notFound()` selects its local
boundary; a same-segment layout error skips that segment's own error component
and uses its owner's boundary. Errors can bubble through multiple slot owners
while preserving the catching owner's other branches.

The nested dashboard fixture was checked against a stock Next 16.3.6 development
server in Chromium for matched pages, defaults, page errors, not-found, and
layout errors. The runtime and browser regressions cover four levels of slots,
local streaming/Suspense, hydration and interaction, nested default failures,
ancestor error propagation, route groups, optional catch-all matching, missing
defaults, and nested interceptions. Stock streamed page error/not-found cases
retain HTTP 200 after headers are sent; Tuto's buffered fallback may report
500/404 instead, while streamed responses preserve the committed status.
Tuto retains its existing missing-default behavior (request-time 404); the
stock 16.3.6 webpack loader also validates required named-slot defaults during
compilation. This slice does not add that compiler validation. Implicit
`children` default recovery is now covered for slot-only hard loads. These
checkpoints do not establish full App Router parity.

### Next 16.2.6 boundary differential

The implementation was checked against a stock pinned Next development server
using a canonical photo page plus an intercepted `@modal` page with local
`error.tsx`, `loading.tsx`, and `not-found.tsx`. Next's own
`create-component-tree` also shows why the ownership rules differ: an owner's
error component is passed to each parallel `LayoutRouter`, while an HTTP
not-found component is attached to the `children` branch at that level.

| Intercepted slot outcome | Stock Next initial document | Tuto streamed document | Tuto buffered request |
| ------------------------ | --------------------------- | ---------------------- | --------------------- |
| Success                  | HTTP 200, final modal        | HTTP 200, final modal  | HTTP 200, final modal |
| Page throws              | HTTP 200, modal loading; error stays in Flight until hydration | HTTP 200, modal loading; error stays in Flight until hydration | HTTP 500, final modal error UI |
| Page calls `notFound()`  | HTTP 200, modal loading; 404 signal stays in Flight until hydration | HTTP 200, modal loading; 404 signal stays in Flight until hydration | HTTP 404, final modal not-found UI |

The different buffered status is intentional: that transport has already
observed the complete RSC render and can return its final outcome. The streamed
transport cannot change an HTTP status after its shell is committed, so the
shared browser kernel resolves the encoded Flight signal into the local slot
boundary after hydration. Browser, child-worker, and SecureExec fixtures assert
that the primary page and sibling slots remain mounted.

## Local checkpoint measurement

A single Next 16.2.6 local run on 2026-09-02 measured the full compile plus hydratable HTML
request below. These are development-machine directional numbers, not Vercel
benchmarks. CPU and RSS deltas cover the Vitest host process; child-worker memory
is separate and each worker has a 256 MB V8 heap ceiling.

| Request           |      Wall | Host CPU | Host RSS delta | Reuse                                                 |
| ----------------- | --------: | -------: | -------------: | ----------------------------------------------------- |
| Cold workspace    | 1669.3 ms | 952.8 ms |      +58.9 MiB | No transform or artifact hits                         |
| Unchanged request |   34.2 ms |  12.1 ms |       +1.1 MiB | Hot immutable artifact                                |
| Server page edit  |  113.5 ms |  51.5 ms |       +1.1 MiB | 2/3 server transforms and the client transform reused |

The shared minified browser kernel is 222,266 bytes before HTTP compression.
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

- Generalized segment/PPR continuation caching and full `bfcacheId`/Cache Components router caching
- Incremental Server Action Flight responses and streamed proxy terminal responses
- External proxy rewrites and streaming proxy IPC
- Next's webpack/Turbopack/PostCSS plugin pipeline, Sass, Tailwind directives, and CSS `url()` asset graph rewriting
- Binary public uploads, `next/image` optimization, font optimization, and metadata file conventions such as generated OG images
- Cross-instance signed preview capabilities and cross-region coordinator failover
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

The next compatibility repair is preserving Next's WorkUnitStore for nested
Cache Components during SecureExec rendering. After that, dependency metadata
for speculative Flight and inherited layout/loading models can allow selective
tag/path eviction without invalidating unrelated destinations. PPR continuation
and cross-instance invalidation require separate architecture and evidence.
Deployment validation and sandbox security review remain separate operational
work.
