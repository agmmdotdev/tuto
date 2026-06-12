# Monaco Route Types Proposal

## Problem

TanStack Router's real type safety depends on generated route files and global
module augmentation:

- `src/routeTree.gen.ts` declares `FileRoutesByPath`.
- `src/router.tsx` registers `Register.router = typeof router`.
- `Link`, `useParams`, and `useSearch` infer route params/search through that
  registered router.

This works in a normal TypeScript project, but Monaco's browser TypeScript
worker is not a full `tsserver` project. It only sees editor models and
explicitly injected type libraries. In practice, Monaco can miss or split the
module augmentation, causing `RegisteredRouter` to fall back to `AnyRouter`.
That produces errors like:

```ts
Object literal may only specify known properties, and 'postId' does not exist
```

## Current Pragmatic Direction

Keep the runtime path real:

- Build/runtime still use real `@tanstack/react-router`.
- The compile path still materializes a generated `src/routeTree.gen.ts`.

Use an editor-only Monaco shim:

- Generate `src/tanstack-router-editor-shim.tsx` from the same route scan.
- Configure Monaco TypeScript `paths` so `@tanstack/react-router` resolves to
  that shim in the editor only.
- Type route params directly from known route paths, for example:

```ts
type RouteParamsByPath = {
  "/posts/$postId": { postId: string }
}
```

This avoids depending on Monaco correctly applying TanStack's global router
registration chain.

## Required Proper Version

The shim must not be static. It must be regenerated from the live workspace
graph.

Implementation direction:

1. Add create/delete/rename file actions to the explorer.
2. Run route materialization from the current working snapshot whenever files or
   drafts change.
3. Generate these derived files from `src/routes`:
   - `src/routeTree.gen.ts`
   - `src/tanstack-router-register.d.ts`
   - `src/tanstack-router-editor-shim.tsx`
4. Hide or mark generated files read-only in the explorer.
5. Feed the materialized working snapshot into Monaco so link/param/search
   types update live.
6. Feed the same materialized snapshot into compile and RPC.

## Tradeoff

This is not pure TanStack Router typing inside Monaco, but it is more reliable
for a browser IDE. Runtime behavior stays real; only editor diagnostics use the
shim.

If the playground later moves to a real project filesystem and a persistent
language server, this shim can be removed and replaced with normal TanStack
route generation plus `tsserver`.

