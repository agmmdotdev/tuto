# TanStack Start Playground Remaining Tasks

The following items are remaining for the TanStack Start playground integration:

1. **Explorer File Actions (Create/Delete/Rename):**
   - Implement frontend UI controls in the sidebar tree explorer to allow users to add, delete, and rename files. This will enable dynamic adding and deleting of routes (e.g. creating `src/routes/about.tsx`).
2. **Hide/Lock Generated Files:**
   - Hide generated files (`src/routeTree.gen.ts`, `src/tanstack-router-register.d.ts`, and `src/tanstack-router-editor-shim.tsx`) from the explorer tree, or mark them as read-only in the editor.
3. **Monaco Diagnostics Refresh:**
   - Force a diagnostics compile check on all open Monaco editor models when the route tree is regenerated to resolve or display link type warnings instantly.
4. **Polish Client-Side Preview & Serverless RPC:**
   - Keep the architecture strictly aligned with Vercel serverless constraints by relying on Client-Side Rendering (CSR) for the preview, while using our highly-optimized, stateless API route (`core-rpc/route.ts`) to execute server functions. This avoids the overhead of bundling full SSR engines in serverless functions.
