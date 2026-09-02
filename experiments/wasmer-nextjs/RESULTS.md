# Next.js 16.2.6 in Wasmer/Edge.js: local result

Test environment:

- Node.js 24.19.0 on Linux x64
- 9 logical CPUs and 22 GiB host RAM available
- `@wasmer/sdk` 0.11.0
- `wasmer/edgejs` 0.2.0
- Next.js 16.2.6 with webpack and `@next/swc-wasm-nodejs`
- fresh Wasmer client and sandbox; Wasmer registry package cache already warm
- preinstalled student artifact with source maps, declarations, licenses, and
  Markdown removed

## Successful Pages Router run

| Phase | Wall time | Host CPU time | End/peak RSS |
|---|---:|---:|---:|
| Read host artifact | 1.15 s | 1.25 s | 171.9 MiB |
| Create Wasmer client and sandbox | 3.47 s | 3.60 s | 425.9 MiB |
| Start Next.js until port ready | 3.25 s | 5.88 s | 993.0 MiB |
| First render request | 24.15 s | 25.06 s | 1,702.3 MiB |
| Cold sandbox through first response | 30.91 s | 34.64 s | 1,707.0 MiB |
| Stop, edit, restart, and return updated response | 26.47 s | 27.84 s | 2,324.0 MiB peak |
| Already-compiled steady request | 67.5 ms | 66.6 ms | 2,319.5 MiB |

The optimized artifact contained 4,940 files and 122,472,520 bytes
(116.8 MiB). The first and edited responses both returned HTTP 200 with their
expected markers.

Terminating the first Next.js guest process did not return the host process near
its earlier memory level. Starting and compiling the edited process increased
resident memory from roughly 1.7 GiB to 2.3 GiB. This may be retained allocator
or WebAssembly memory rather than a logical object leak, but it is resident
memory from the hosting platform's perspective.

## Compatibility findings

1. Plain `node` aborts Edge.js with `the JavaScript host does not support
   WebAssembly JSPI`. `node --experimental-wasm-jspi` works, while
   `NODE_OPTIONS=--experimental-wasm-jspi` is rejected by Node.
2. Next.js App Router reached the ready state but its first RSC request returned
   HTTP 500 with `Invariant: Expected workStore to be initialized`.
3. Pages Router rendered successfully.
4. A correct `sandbox.fs.writeText("app/pages/index.js", ...)` was immediately
   visible to a new Edge.js process.
5. The running Next.js webpack watcher did not observe that edit within 60
   seconds despite polling being enabled. The measured edit path therefore
   terminates and restarts Next.js.
6. Turbopack is unavailable because Next's native SWC binding has no
   `wasi/wasm32` build; the explicit SWC WebAssembly package is required.

## Interpretation for Tuto

The SDK and HTTP bridge work, and real Next.js can render inside the sandbox.
The current versions are not suitable as Tuto's primary request-time runtime:
App Router is broken, live edits do not invalidate the running dev server, cold
rendering is tens of seconds, and one minimal workspace consumes well over 1
GiB. The experiment is worth retaining as a compatibility target, but it does
not justify replacing Tuto's shared host compiler/runtime yet.

## Host-precompiled production standalone run

The second experiment built the fixture natively with `next build --webpack`
and `output: "standalone"`, then loaded only the production artifact into a
fresh Wasmer sandbox. The fixture contains both the Pages Router control and a
dynamic App Router route with a real RSC render and Server Action.

The filtered production artifact contained 1,952 files and 28,784,607 bytes
(27.5 MiB), compared with 116.8 MiB for the development artifact.

| Phase | Wall time | Host CPU time | End/peak RSS |
|---|---:|---:|---:|
| Read production artifact | 73.2 ms | 108.3 ms | 82.1 MiB |
| Create Wasmer client and sandbox | 3.42 s | 3.53 s | 219.1/327.2 MiB |
| Start production Next server | 1.69 s | 3.25 s | 607.8 MiB |
| First Pages response | 757.7 ms | 1.88 s | 770.6/771.8 MiB |
| Steady Pages response | 517.0 ms | 668.4 ms | 820.8 MiB |
| First App Router/RSC response | 321.9 ms | 497.9 ms | 822.6/852.7 MiB |

The cold path through the first successful Pages response was approximately
5.87 seconds after the artifact was in host memory, or 5.94 seconds including
artifact reading. That is a large improvement over the 30.91-second dev cold
path, but still expensive for request-scoped execution. The steady static Pages
response was also 517 ms rather than the dev run's 67.5 ms.

The Pages requests returned HTTP 200. The first production App Router request
returned HTTP 500 with:

```text
RangeError: Maximum call stack size exceeded
    at Reflect.get (<anonymous>)
```

The identical standalone artifact was then run under native Node.js as a
control. Pages Router, the RSC route, and the progressive Server Action all
returned HTTP 200. Native timings in that smoke run were 209.5 ms to server
ready, 154.8 ms for the first Pages request, 56.5 ms for RSC HTML, and 28.0 ms
for the action plus redirect. This isolates the RSC failure to the current
Edge.js execution path rather than the Next build output.

## Student RSC edit and rebuild

Changing only the RSC page marker and running the stock production builder took
16.42 seconds wall time, 21.30 seconds user CPU, and 4.29 seconds system CPU.
The preceding warm baseline build took 15.26 seconds wall time, so the stock
`next build` path provides no useful edit latency.

The output delta was much smaller than the rebuild cost suggests. Among the
route output and relevant manifests, only the 57,817-byte server route bundle
changed. The client chunk, client-reference manifest, file trace, app-paths
manifest, and Server Action manifest remained byte-identical. The action ID
also remained stable:

```text
4090b179d7ad2f41eb46505a65b1288e7ec51037ac
```

This supports Tuto's proposed split: cache an immutable Next/React runtime and
compile a small per-student server module plus only the manifests affected by
that edit. It does not make stock Next request-based compilation fast by
itself; Tuto still needs a host incremental compiler or a deliberately limited
lesson-module boundary.

Editing the body of the Server Action produced the same pattern. The full build
took 16.97 seconds wall time, but only the same server route bundle changed
(from 57,817 to 57,827 bytes). The action ID, Server Action manifest,
client-reference manifest, and browser chunk remained byte-identical. Native
Node executed the edited action and redirected to
`/rsc?action=action-v2-server-action-worked`.

This is favorable for lessons that edit the body of an existing exported
action: the framework kernel, browser proxy, and action registration can stay
precompiled. Adding, removing, or renaming action exports still needs manifest
regeneration and should be treated as a broader compilation boundary.

## Updated conclusion

Precompiling Next.js is worthwhile and removes most of the dev compiler cost.
It does not make the current Wasmer/Edge.js combination suitable for teaching
modern Next.js: production RSC still fails, Server Actions therefore cannot be
reached in the sandbox, JSPI is still required, and a minimal warmed sandbox is
around 800 MiB PSS after two Pages requests.

The viable architecture remains:

1. Precompile and cache the framework kernel outside the student request.
2. Compile only student-owned modules and affected RSC/action metadata on the
   host.
3. Execute the resulting request handler in an isolation backend.
4. Treat Wasmer/Edge.js as a future backend after App Router compatibility and
   memory improve, not as Tuto's compiler.
