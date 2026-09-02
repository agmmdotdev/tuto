# TanStack Start playground roadmap

The request-based runtime is the fixed architecture: workspace revisions are
compiled with esbuild and executed by bounded, reusable Node workers. Tuto does
not start a per-student Vite watcher, container, or microVM.

The remaining playground work is:

1. **Explorer File Actions (Create/Delete/Rename):**
   - Implement frontend UI controls in the sidebar tree explorer to allow users to add, delete, and rename files. This will enable dynamic adding and deleting of routes (e.g. creating `src/routes/about.tsx`).
2. **Hide/Lock Generated Files:**
   - Hide generated files (`src/routeTree.gen.ts`, `src/tanstack-router-register.d.ts`, and `src/tanstack-router-editor-shim.tsx`) from the explorer tree, or mark them as read-only in the editor.
3. **Monaco Diagnostics Refresh:**
   - Force a diagnostics compile check on all open Monaco editor models when the route tree is regenerated to resolve or display link type warnings instantly.
4. **Configurable Import Protection — complete for the safe config surface:**
   - `tanstack-start.config.json` supports client/server specifier and file globs, `excludeFiles`, global include/exclude/ignored-importer scopes, build/development error or mock behavior, runtime mock diagnostics, log deduplication, and disabling protection.
   - Executable `RegExp` values and `onViolation` callbacks are intentionally not accepted by the declarative request compiler.
5. **SPA request preview and shell output — complete for Tuto's host:**
   - `tanstack-start.config.json` accepts `spa.enabled` and `spa.maskPath`.
   - The official Start shell marker renders root SSR plus the pending fallback; Firefox proves the child route boots client-side and server functions remain live.
   - The compiler persists `/_shell.html` as a revision-pinned static artifact and serves it for unmatched document paths. Hosting-specific rewrite generation remains adapter work.
6. **Static prerender output — complete for the safe declarative surface:**
   - Top-level `pages` merge with compiler-derived component routes and emit bounded, content-addressed HTML documents from the official Start handler.
   - Safe include/exclude glob arrays filter configured, discovered, and crawled routes without executing student callbacks.
   - Exact static routes are served before the SPA shell with private immutable caching; server functions and server routes remain dynamic.
   - A signed, revision-pinned deployment manifest describes HTML, static server-function assets, route outputs, and the SPA fallback.
   - Executable filters/hooks and third-party adapter packaging are intentionally not run by the shared compiler.
7. **Static server functions — complete:**
   - The documented `staticFunctionMiddleware` import works as the final middleware on GET server functions.
   - Prerendering executes validators and handlers in the existing worker, persists the upstream Seroval result under its function-ID/payload-derived key, and embeds it in static HTML.
   - Later browser calls fetch the authenticated immutable JSON artifact without running live RPC; ordinary server functions and routes stay dynamic.

The versioned support contract and its executable evidence live in
[`TANSTACK_START_COMPATIBILITY.md`](./TANSTACK_START_COMPATIBILITY.md).
Third-party hosting adapters and a per-student Vite/HMR server are not
prerequisites for the interactive Tuto preview path.

Deferred loader data, deferred hydration's interaction path, environment
functions/variables, selective SSR, SEO/head metadata, path aliases, and custom
client/server entry points are covered by the real-browser checkpoint.

Advanced deferred hydration is complete: the Firefox fixture covers `idle`,
`visible`, `media`, `condition`, `never`, and prefetch behavior while verifying
that deferred child chunks are not included in route preloads.

The next roadmap slice is Explorer File Actions: create, delete, and rename
workspace files while preserving route-tree regeneration and editor state.
