# Next.js 16.2.6 internal compiler report for Tuto

## Executive result

Tuto can reuse substantially more of Next.js than the earlier custom-runtime
design assumed. The genuine Next SWC transform is callable and successfully
handled Server Components, Client Component proxies, browser Client Components,
module-level and inline Server Actions, App Route Handlers, Pages API routes,
middleware, Cache Component/function directives, TypeScript, and JSX.

This does not provide a complete incremental Next compiler. The SWC transform
produces module code and metadata; webpack/Turbopack still constructs the module
graph, assigns module and chunk IDs, creates route entry wrappers, and emits the
client-reference, Server Action, route, pages, and middleware manifests.

The practical result is encouraging: Tuto should reuse Next's real transforms
and implement a pinned, tested orchestration layer around them. It should not
run `next build` after each edit.

## Environment

- Node.js 24.19.0, Linux x64
- Next.js 16.2.6
- React and React DOM 19.2.6
- webpack production reference build
- 9 logical CPUs available

Dependency installation is excluded from all measurements.

## Direct compiler results

The probe loaded `next/dist/build/swc`,
`next/dist/build/swc/options`, static page analysis, entry generation, and route
matching directly from the installed Next package.

SWC binding initialization varied from 72 to 117 ms across fresh Node
processes. The first transformed module took about 35 ms. Subsequent warm
transforms generally took 1-9 ms.

| Feature | Direct result | Warm time observed | What Next emitted |
|---|---|---:|---|
| Server Component | Passed | 2-4 ms after warm-up | JSX runtime code and RSC server metadata |
| Client Component, RSC view | Passed | 6.2 ms | `createProxy()` module and client-entry metadata |
| Client Component, browser view | Passed | 8.8 ms | Browser JSX, hooks, React Refresh metadata |
| Module Server Actions | Passed | 2.5-8.3 ms | Action IDs, validation, `registerServerReference()` |
| Inline Server Action | Passed | 1.9 ms | Hoisted action export and registration |
| `use cache` function and component | Passed | 2-4 ms | Stable cache IDs, Next cache wrappers, server-reference registration |
| Invalid synchronous action | Correctly rejected | 1.8 ms | `Server Actions must be async functions` diagnostic |
| Client importing `server-only` | Correctly rejected | 6.9 ms | RSC boundary diagnostic |
| App Route Handler | Passed | 3.7 ms | Type removal and server module code |
| Pages API route | Passed | 1.1 ms | Type removal and Node API module code |
| Middleware | Passed | 1.3 ms | Transformed middleware module |
| Student-created route module | Passed | 2-3 ms | Server module code; no route registration |

The Client Component was compiled twice, as a real Next build requires:

1. The RSC compilation produced a server-side proxy with internal client-entry
   metadata.
2. The browser compilation produced the executable React component.

This dual compilation is essential. Compiling only the browser or only the RSC
side is insufficient.

## Cache compilation and invalidation boundary

With `cacheComponents` and `useCacheEnabled` enabled in the pinned SWC options,
the direct transform compiled both a cached async data function and a cached
async Server Component. For each scope it:

- removed the `"use cache"` directive;
- hoisted the original function body;
- assigned a deterministic reference ID;
- wrapped the export with React request memoization and Next's
  `private-next-rsc-cache-wrapper`;
- preserved `cacheLife()` and `cacheTag()` inside the cached body; and
- registered the cache wrapper as a server reference.

This is an important positive result, but it is only the compile-time half.
The wrapper expects a live App Router request context and configured Next cache
handlers. The compiler does not supply cache storage, tag/path indexes, expiry,
cross-instance invalidation, or the Server Action re-render transaction.

For Tuto, the required runtime contract is:

| Operation | Required behavior |
|---|---|
| `use cache` | Key by cache kind, compiled function/reference ID, serialized arguments and captured values, inside a per-student app namespace |
| `cacheLife` | Track stale, revalidate, and expire thresholds; stale entries may be served while one refresh runs |
| `cacheTag` | Add reverse tag-to-entry indexes in the same student namespace |
| `updateTag` | Server Action only; expire immediately so the action's following render waits for fresh data |
| `revalidateTag(tag, profile)` | Mark tagged entries stale using the selected stale-while-revalidate profile; do not promise immediate read-your-own-writes |
| `revalidatePath` | Invalidate the path's implicit tags and relevant route output |
| `refresh` | Re-render/refetch the current route's dynamic RSC data without expiring tagged cache entries |
| cookie write or redirect | Preserve Next's action behavior: render the updated current tree or stream the redirect destination |

The cache cannot exist only in a Fluid Compute process. Instances can disappear,
and concurrent instances would otherwise disagree about invalidations. Tuto
needs a shared cache/invalidation service (or a custom Next cache handler backed
by one), optionally fronted by a small per-instance LRU. Compiler artifacts and
runtime data must use different lifecycles. Next's wrapper includes the build or
deployment ID, compiled cache-function ID, and serialized arguments in its key.
The safest Tuto development policy is therefore to issue a new build-generation
ID after a student edit, invalidating that generation's application-data cache
along with affected module and route artifacts. Selective reuse across edits can
be added later only with explicit compatibility tests.

Every cache key, tag, path, and invalidation event must be namespaced by at least
the Tuto app/workspace and student identity. Otherwise one student's action can
invalidate or observe another student's lesson state.

The Server Action response is the hardest compatibility point. For immediate
invalidation, Tuto must execute the mutation, commit the tag/path changes,
re-render the current route against the updated cache state, and return both the
action result and refreshed RSC payload in the same Flight response. Merely
deleting a value from a JavaScript `Map` does not reproduce Next behavior.

## Server Action equivalence

The probe used the same test-only encryption salt, production options, and
canonical absolute filename as the reference build. Direct SWC generated:

```text
createLesson  4096928209b8d504ec5855321a3fda18d9000f54a2
archiveLesson 40d8d0c5cf50d8627e71f5bdc11dab9d86b3fb8a2f
```

The full `next build` generated the exact same IDs. The existing
`createLesson` ID also remained unchanged when `archiveLesson` was added.

Three inputs were required for equivalence:

1. The same encryption/hash salt.
2. The same canonical filename.
3. The same production SWC options and RSC layer.

Without a fixed key, the baseline and second build generated different IDs for
the unchanged action. Tuto therefore needs a stable secret per compatible build
generation and deterministic virtual filenames. A random temporary workspace
path would change action IDs. Action IDs remain references, not authorization;
the action must still authenticate and validate every request.

## Routing and static analysis

Next's internal route utilities successfully:

- found the fixture's `app` and `pages` directories;
- normalized `/posts/[id]`;
- generated `^/posts/([^/]+?)(?:/)?$`;
- matched `/posts/compiler-probe` to `{ id: "compiler-probe" }`;
- rejected `/posts`;
- generated a `next-app-loader` entry request for the dynamic page;
- parsed the middleware matcher into the same regex later emitted in the
  production middleware manifest.

The entry API does not return an executable route. It returns a webpack loader
request. That loader creates the route tree and imports layouts, pages,
boundaries, metadata, and framework templates. Tuto can reuse the route naming
and matcher utilities, but using `getAppEntry()` directly means adopting Next's
webpack loader pipeline.

For a custom request compiler, Tuto should maintain its own virtual route index
and use Next's normalization/matcher behavior as a compatibility oracle.

## Reference build artifacts

The final reference build contained:

- six App Router entries, including `/new-route`, `/api/hello`, and
  `/posts/[id]`;
- one Pages API route;
- two Server Actions;
- one middleware entry and matcher;
- one student Client Component in the home client-reference manifest;
- nine RSC mappings and nine SSR mappings for the home route;
- an approximately 153 MiB complete `.next` directory;
- a 60.26 MiB standalone production runtime.

Adding one route and one action increased the standalone artifact by only about
0.05 MiB, despite requiring another full build.

## Full build cost

| Build | Wall | User CPU | System CPU | Next compile stage |
|---|---:|---:|---:|---:|
| Baseline, one action | 82.59 s | 98.67 s | 27.47 s | 17.1 s |
| Add route and action, random salt | 85.80 s | 103.24 s | 30.44 s | 17.2 s |
| Same source, fixed salt | 78.64 s | 95.25 s | 26.53 s | 16.7 s |

The environment made build tracing particularly expensive, but even Next's
reported compilation stage was about 17 seconds. In contrast, direct production
transforms for the added action file and route were roughly 2-4 ms each.

## Runtime verification

The standalone production runtime successfully verified all of the following:

| Request | Result | Measured wall time |
|---|---:|---:|
| First home HTML with Server and Client Components | 200 | 919 ms |
| RSC Flight request | 200, `text/x-component` | 36 ms |
| Dynamic `/posts/compiler-42` | 200 | 179 ms |
| Student-created `/new-route` | 200 | 30 ms |
| App Route Handler GET | 200 | 41 ms |
| App Route Handler POST | 200 | 40 ms |
| Pages API route | 200 | 51 ms |
| Existing Server Action plus redirect | 200 | 136 ms |
| Student-created Server Action plus redirect | 200 | 59 ms |

Middleware ran for every request and returned the expected path and
`x-tuto-middleware: hit` headers. The legacy `middleware.ts` convention still
works in Next 16.2.6, but the build warns that modern applications should use
`proxy.ts`.

### Cache runtime verification

A second production fixture enabled Cache Components and exercised Next's
default cache handler with a runtime-only cached function, `cacheLife`,
`cacheTag`, and a Server Action calling `updateTag`.

| Step | Stored value | Cached-function executions | Observation |
|---|---:|---:|---|
| First GET | 0 | 1 | Cache miss and fill |
| Second GET | 0 | 1 | Cache hit across requests |
| Action POST after mutation + `updateTag` | 1 | 2 | Expired tag and fresh same-response render |
| First GET after action | 1 | 3 | Refilled after the action transaction |
| Second GET after action | 1 | 3 | New entry was reused |

The debug trace confirmed `get` miss, `set`, `get` hit, `updateTags`, and an
expired-tag miss. The action response itself contained the mutated value, so
the read-your-own-writes behavior was verified without a redirect or follow-up
request. In this native form/MPA probe, the cache filled during the action
render was invalidated again by the action's pending tag update, so the next
independent GET performed one more fill before subsequent hits.

This is not yet complete cache coverage. Time-based expiry,
`revalidateTag(tag, "max")` stale-while-revalidate, `revalidatePath`, `refresh`,
cookie mutation, browser-side action dispatch, and a distributed custom handler
still require dedicated runtime tests.

There is no first-party Next.js R2 implementation for the new `cacheHandlers`
interface. OpenNext Cloudflare ships an R2 incremental-cache adapter for the
separate singular `cacheHandler` path (ISR, route output, cached fetches, and
legacy incremental-cache entries), but it is not a drop-in backend for Next 16
`use cache`. For Tuto, R2 can hold large serialized cache bodies, but tag
timestamps, invalidation coordination, and regeneration locks should live in a
low-latency shared index such as Redis/Valkey, a database, or a dedicated
coordination service. A small per-instance LRU can sit in front of that shared
layer.

## What is directly reusable

| Next subsystem | Reuse assessment |
|---|---|
| SWC transform and diagnostics | Strong candidate; pin exact Next version |
| RSC/client directive metadata | Strong candidate |
| Server Action transform and IDs | Strong candidate with stable salt/path |
| Page static info and middleware matcher analysis | Useful but internal |
| Route normalization and regex matching | Useful and easy to contract-test |
| `getAppEntry` and Next webpack loaders | Coupled to webpack; not request-sized |
| Flight client-entry and action-manifest plugins | Valuable reference, tightly coupled to compilation graph |
| Full `next build` | Correctness oracle and advanced fallback only |

## What Tuto still must build

### 1. Virtual module graph

Track imports per student generation and compile affected dependants. Every
Client Component needs both its RSC proxy representation and browser output.

### 2. Route index

Scan the virtual `app/` and `pages/` workspace and atomically update routes for
`page`, `layout`, `route`, dynamic segments, and boundaries. SWC transforms a
route file but does not register the URL.

### 3. Client-reference registry

Map each client module to Tuto's browser chunk and server-side RSC proxy. Next's
manifest uses webpack IDs; Tuto can use deterministic IDs from its own bundler.

### 4. Server Action registry

Read the action metadata comment emitted by SWC, map each action ID to the
compiled server module and export, and generate browser proxies. The experiment
proves that these IDs can match Next exactly.

### 5. Request wrappers

Provide route-specific RSC rendering, action dispatch, App Route Handler
dispatch, Pages API compatibility, and middleware/proxy execution.

### 6. Immutable generations

Publish route, action, and client-reference metadata atomically with compiled
modules. Never serve a browser chunk from one generation with an action or RSC
manifest from another.

### 7. Namespaced cache and invalidation transaction

Provide the real cache-wrapper request context, shared cache handlers, tag and
implicit-path indexes, time profiles, and per-student namespaces. During a
Server Action, apply immediate invalidations before the follow-up RSC render and
publish the appropriate client-router invalidation signal in the Flight
response. Keep compiler cache eviction separate from application-data
revalidation.

## Recommended implementation order

1. Integrate the pinned Next SWC transform behind a small Tuto adapter and save
   the transformed metadata.
2. Support Server Components plus imported Client Components for existing
   routes.
3. Add module-level Server Actions with a fixed per-app secret and canonical
   virtual paths.
4. Add student-created static and dynamic `page` routes.
5. Add App Route Handlers.
6. Add layouts, loading/error boundaries, and nested route trees.
7. Add `proxy.ts`/legacy `middleware.ts` after route dispatch is stable.
8. Add `use cache`, `cacheLife`, and `cacheTag` with a per-student shared cache
   adapter.
9. Add `updateTag`, `revalidateTag`, `revalidatePath`, and `refresh` to the
   Server Action render transaction and verify the returned Flight payload.
10. Add inline actions, Pages API compatibility, advanced cache directives, and
    unsupported Next configuration incrementally.

Keep a real Next build fixture as the compatibility oracle for every supported
Next version. Because the compiler imports come from `next/dist/*`, upgrades
must be deliberate and gated by these contract tests.

## Primary references

- [Next.js Compiler](https://nextjs.org/docs/architecture/nextjs-compiler)
- [Next.js CLI](https://nextjs.org/docs/app/api-reference/cli/next)
- [Next.js Adapters](https://nextjs.org/docs/app/api-reference/adapters)
- [Server Action deployment behavior](https://nextjs.org/docs/messages/failed-to-find-server-action)
- [`use cache`](https://nextjs.org/docs/app/api-reference/directives/use-cache)
- [Caching](https://nextjs.org/docs/app/getting-started/caching)
- [Revalidating](https://nextjs.org/docs/app/getting-started/revalidating)
- [Server Actions](https://nextjs.org/docs/app/guides/server-actions)
- [Custom cache handlers](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers)
- [OpenNext Cloudflare caching](https://opennext.js.org/cloudflare/caching)
- [Cloudflare R2 architecture](https://developers.cloudflare.com/r2/how-r2-works/)
- [Middleware to Proxy migration](https://nextjs.org/docs/messages/middleware-to-proxy)
