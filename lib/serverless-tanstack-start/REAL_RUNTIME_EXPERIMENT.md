# Real TanStack Start runtime experiment

This experiment answers one narrow question before the playground is changed:

> Can Tuto's request-based esbuild path run the real TanStack Start client and
> server-function runtimes without implementing `createServerFn`, middleware,
> RPC serialization, redirects, or `FormData` itself?

Run it with:

```bash
yarn experiment:tanstack-real-runtime
```

The script creates an entirely virtual student workspace and performs this
round trip in one host process:

1. `@tanstack/start-plugin-core` produces the client transform and server split.
2. esbuild resolves `@tanstack/react-start`,
   `@tanstack/react-start/client-rpc`, and
   `@tanstack/react-start/server-rpc` through the official package exports.
   Tuto does not alias those specifiers to the core packages.
3. The real Start compiler selects the client/server implementations of the
   environment-specific functions inside the prebuilt framework packages.
4. The real client runtime serializes a server-function request.
5. A custom fetch transport sends that unchanged request to the real Start
   server-function handler. A tiny host adapter supplies the response-status
   context that Start normally receives from its framework request handler.
6. The real server runtime runs validation and middleware, serializes the
   result, and the real client runtime deserializes it.

The experiment fails unless the returned value proves that both the validator
and server middleware ran. It also checks esbuild's metafile to ensure the
client and server bundles actually include TanStack's runtime packages.

## First confirmed result

The official `@tanstack/react-start@1.168.49` dependency selects its compatible
client, server, and plugin core versions. Direct compiler/host dependencies are
pinned to that same resolved graph instead of assuming every independently
published TanStack package has the same version number. The locked package
versions complete the native round trip. One cold local run
produced a 91,194-byte client bundle, a 104,986-byte server bundle, and a
14.8ms in-process RPC round trip. Transform/build timings are printed on every
run; they are diagnostic numbers, not stable benchmarks yet.

The important failure found along the way is that package resolution by itself
is not sufficient. `@tanstack/start-client-core` contains environment-specific
function chains such as `createIsomorphicFn().client(...).server(...)`. Start's
compiler normally selects the correct implementation. A raw esbuild bundle can
therefore pull `node:async_hooks` into the browser and/or choose server
behavior. Tuto's framework-kernel build must run the real Start environment
transform for both the client and server kernels.

## Playground integration

The proof is now the playground's native compile path. A save hashes the canonical
workspace snapshot, builds the browser and server artifacts once, and stores
the result in a bounded LRU/TTL cache. The browser bundle uses the real Start
client runtime with a base URL containing the revision and a random per-artifact
capability token. A call sends Start's native request body plus `revision`,
capability, and `serverFnId`; it never sends source files. The gateway validates
that capability before dispatch and normalizes the opaque preview origin into a
trusted same-origin internal request for Start's CSRF middleware.

The API route resolves the revision from the hot or durable artifact tier and
dispatches the native request to a bounded pool of child processes. Each child
is pinned to one revision for its entire lifetime: it loads the generated
server kernel and that revision's compiled server artifact once, then handles
sequential native Start requests. A worker is killed before its slot can be
used by another revision. Student server code is never imported by the Next.js
host process.

The worker runs the public `createStartHandler` request host from
`@tanstack/react-start/server`. An optional student `src/start.ts` can export a
`startInstance` from the official `createStart` API. Request middleware, global
function middleware, request context, request/response helpers, cookies, and
encrypted cookie sessions therefore use upstream Start/H3 behavior for native
server-function requests. The transport preserves repeated `Set-Cookie` headers
and performs credentialed browser fetches. Cookies used from the sandbox still
need browser-compatible cross-site attributes (normally `SameSite=None; Secure`)
and remain subject to the browser's third-party-cookie policy.

Current cache defaults are 24 artifacts, 32 MiB total, and a sliding 10-minute
TTL. They can be tuned with `TUTO_TANSTACK_ARTIFACT_CACHE_MAX_ENTRIES`,
`TUTO_TANSTACK_ARTIFACT_CACHE_MAX_BYTES`, and
`TUTO_TANSTACK_ARTIFACT_CACHE_TTL_MS`.
The worker pool defaults to four processes, 50 successful requests per worker,
and a 60-second idle TTL. Idle workers are evicted in least-recently-used order
when another revision needs a full pool. Concurrent calls may use multiple
workers pinned to the same revision. Calls are capped at 1.25 MiB of request
data, 3 MiB of worker response data, 10 seconds of execution, and 15 seconds of
worker startup. The worker limits can be tuned with
`TUTO_TANSTACK_WORKER_POOL_SIZE`, `TUTO_TANSTACK_WORKER_MAX_REQUESTS`,
`TUTO_TANSTACK_WORKER_IDLE_TTL_MS`,
`TUTO_TANSTACK_WORKER_EXECUTION_TIMEOUT_MS`,
`TUTO_TANSTACK_WORKER_STARTUP_TIMEOUT_MS`, and
`TUTO_TANSTACK_WORKER_MAX_RESPONSE_BYTES`.

Successful RPC responses expose `x-tuto-worker-id`,
`x-tuto-worker-request`, and `x-tuto-worker-reused` for diagnostics. These are
observability headers, not application state or cache keys.

### Router SSR checkpoint

Workspace revisions that export `getRouter()` from `src/router.tsx` now use the
official `createStartHandler(defaultStreamHandler)` document path. A capability-
checked render endpoint dispatches the document request to the same revision-
pinned worker used for server functions. Route matching, loaders, request
middleware, router dehydration, and HTML rendering therefore run in the real
Start server runtime.

The compiler also creates a revision hydration module using `StartClient` and
`hydrateRoot`, compiles the workspace CSS, and exposes both through authenticated
artifact endpoints. The generated Start manifest adds the shared client kernel,
revision hydration module, module preload, and stylesheet to the server-rendered
document. The default starter template now exports a router factory and renders
`HeadContent` and `Scripts` from its root route.

This is the first router/SSR slice, not the complete production host. The worker
protocol currently buffers the rendered response before returning it to Next.js,
so the React render is streaming internally but the browser does not yet receive
end-to-end streamed chunks. A complete generated route manifest, server-route
dispatch verification, route-level chunking, and browser hydration/navigation
coverage remain.

### Cross-instance artifact storage

The LRU is now a hot cache in front of a durable artifact store. Compilation
writes successful artifacts to both tiers. An RPC request that misses the hot
cache reads the signed artifact from durable storage, validates its revision,
kernel, expiry, size, and HMAC, then promotes it back into the LRU. A missing or
expired revision returns HTTP 410; an unavailable or corrupt durable store
returns HTTP 503 instead of pretending the revision was evicted.

Durable storage is disabled unless explicitly configured. For Cloudflare R2 or
another S3-compatible service:

```bash
TUTO_TANSTACK_ARTIFACT_STORE=s3
TUTO_TANSTACK_ARTIFACT_S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
TUTO_TANSTACK_ARTIFACT_S3_BUCKET=tuto-artifacts
TUTO_TANSTACK_ARTIFACT_S3_REGION=auto
TUTO_TANSTACK_ARTIFACT_S3_ACCESS_KEY_ID=...
TUTO_TANSTACK_ARTIFACT_S3_SECRET_ACCESS_KEY=...
TUTO_TANSTACK_ARTIFACT_SIGNING_KEY=...
```

AWS S3 uses its regional service endpoint and region instead. The endpoint is
the service endpoint without the bucket name; the adapter uses path-style
object URLs. Use a long random signing key shared by every application
instance. Storage credentials and the signing key must remain server-only.

For local cross-process verification, set
`TUTO_TANSTACK_ARTIFACT_STORE=filesystem`; the default root is
`.tmp/tanstack-start-artifacts`. Optional settings are
`TUTO_TANSTACK_ARTIFACT_STORE_PREFIX`,
`TUTO_TANSTACK_ARTIFACT_STORE_TTL_MS`,
`TUTO_TANSTACK_ARTIFACT_STORE_MAX_BYTES`, and
`TUTO_TANSTACK_ARTIFACT_FILESYSTEM_ROOT`.

The default durable TTL is one hour. The envelope rejects expired objects, but
S3/R2 should also have a lifecycle rule that deletes objects under the chosen
prefix so unread expired objects do not accumulate.

## Shared framework kernels

The official client and server runtime graphs are now built once per framework
version. The kernel identifier hashes the builder implementation, framework
module set, and locked package versions. It is also part of every workspace
revision hash, so an artifact cannot silently run against an incompatible
kernel.

The browser loads the client kernel from an immutable versioned endpoint before
the revision module. The isolated RPC child loads the generated server kernel
before importing the student server artifact. Revision builds resolve Start,
React, React DOM, and React Router imports through small global-module proxies;
they no longer traverse or emit those framework graphs.

Run `yarn measure:tanstack-start-kernels` to rebuild and measure the boundary. A
local two-edit measurement produced these uncompressed minified sizes:

- shared client kernel: 337,697 bytes
- shared server kernel: 459,186 bytes
- first client/server revision: 3,027 / 3,887 bytes
- edited client/server revision: 3,025 / 3,887 bytes
- measured compile durations: 205 ms and 216 ms

Those timings are local diagnostics, not a production latency claim. The
important result is structural: each non-router edit emitted about 6.9 KiB
instead of rebundling roughly 797 KiB of shared framework code. The larger shared
server kernel now contains Start's public request host, React SSR graph, Router,
and its H3 request/session graph.

## Remaining architecture work

1. complete the Start router host with a generated per-route manifest,
   route-level chunking, server-route coverage, and end-to-end response
   streaming. The current checkpoint renders real router documents and loaders,
   but buffers the worker response before returning it to the browser.
2. move execution behind a hardened sandbox such as an isolated container or
   microVM before treating arbitrary untrusted student code as safe for a
   multi-tenant production service. The current child-process boundary protects
   the Next.js host module graph and makes worker lifecycle enforceable; it is
   not an operating-system security boundary.

The standalone proof script above still uses its original minimal host adapter
to isolate the compiler experiment. The integrated playground no longer relies
on that private handler path; its request host and student-facing APIs come from
the official React Start package exports.

This checkpoint claims router SSR and hydration for the covered document path.
It does not yet claim end-to-end streaming, complete server-route support, or
RSC support. Those remain work for the full-runtime tier.
