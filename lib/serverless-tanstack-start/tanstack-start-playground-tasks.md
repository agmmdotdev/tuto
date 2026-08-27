# TanStack Start Playground Remaining Tasks

The following items are remaining for the TanStack Start playground integration:

1. **Explorer File Actions (Create/Delete/Rename):**
   - Implement frontend UI controls in the sidebar tree explorer to allow users to add, delete, and rename files. This will enable dynamic adding and deleting of routes (e.g. creating `src/routes/about.tsx`).
2. **Hide/Lock Generated Files:**
   - Hide generated files (`src/routeTree.gen.ts`, `src/tanstack-router-register.d.ts`, and `src/tanstack-router-editor-shim.tsx`) from the explorer tree, or mark them as read-only in the editor.
3. **Monaco Diagnostics Refresh:**
   - Force a diagnostics compile check on all open Monaco editor models when the route tree is regenerated to resolve or display link type warnings instantly.
4. **Full Start Router/SSR Host:**
   - The public Start request host now renders real workspace routers and loaders and emits a hydration module, CSS, and manifest assets in addition to the server-function tier. Complete the generated per-route manifest, route-level chunking, server-route coverage, browser hydration/navigation tests, and end-to-end streaming (the current worker protocol buffers the response).
5. **Harden Untrusted Execution:**
   - Move arbitrary student server code from the current bounded child-process lifecycle into a container or microVM security boundary before multi-tenant production use.
