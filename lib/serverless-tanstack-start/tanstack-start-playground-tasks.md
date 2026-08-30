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
4. **Advanced Deferred Hydration Compatibility:**
   - The official compiler transform, default child splitting, SSR preservation, interaction trigger, delayed chunk load, and post-hydration interaction are complete. Add focused fixtures for `idle`, `visible`, `media`, `condition`, `never`, and prefetch behavior.
5. **Configurable Import Protection:**
   - Default client/server suffixes, marker imports, the protected server specifier, and type-only exemptions are complete. Add user-configurable deny/include/exclude rules and development mock/log modes.

The versioned support contract and its executable evidence live in
[`TANSTACK_START_COMPATIBILITY.md`](./TANSTACK_START_COMPATIBILITY.md). Static
prerendering, ISR, static server functions, third-party hosting adapters, and a
per-student Vite/HMR server are not prerequisites for the interactive Tuto
preview path.

Deferred loader data, deferred hydration's interaction path, environment
functions/variables, selective SSR, SEO/head metadata, path aliases, and custom
client/server entry points are covered by the real-browser checkpoint.
