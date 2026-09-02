# Tuto Next.js-on-Wasmer benchmark

This experiment runs a preinstalled Next.js student workspace inside
`@wasmer/sdk` and `wasmer/edgejs`, proxies HTTP over the SDK's Node network
bridge, edits the workspace through `sandbox.fs`, and measures wall time, host
CPU time, RSS, PSS, private memory, and thread count.

The dependency tree is prepared on the host because this execution environment
allows npm through a host proxy but blocks direct DNS from the WASIX guest. That
also matches Tuto's intended prebuilt-template model: dependency installation is
not part of request latency.

```sh
npm install
npm --prefix fixture install --ignore-scripts --omit=optional
npm run smoke
npm run benchmark
npm --prefix fixture run build
npm run smoke:production:host
npm run benchmark:production
```

Edge.js currently requires Node's experimental JSPI flag. The package scripts
pass `--experimental-wasm-jspi` directly because Node rejects it in
`NODE_OPTIONS`.

`npm run benchmark` intentionally uses `next dev --webpack` and the SWC
WebAssembly fallback. Turbopack is unavailable on the guest's `wasi/wasm32`
platform.

`npm run benchmark:production` instead loads a host-precompiled
`.next/standalone` artifact. It tests a Pages Router control, an App Router RSC
route, a Flight request, and a progressively enhanced Server Action. The
benchmark records a failure result before exiting nonzero when Edge.js cannot
execute one of those paths.

See `RESULTS.md` for the measured result and compatibility findings.
