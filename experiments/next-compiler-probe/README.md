# Tuto Next.js internal compiler probe

This experiment evaluates which parts of Next.js 16.2.6 can be called as
request-based compiler primitives instead of invoking `next build` for every
student edit.

It covers:

- Server and Client Components
- module-level and inline Server Actions
- invalid Server Action validation
- App Route Handlers
- Pages API routes
- static and dynamic App Router routes
- route normalization and matching
- middleware transformation and matcher analysis
- Next entry-loader generation
- client-reference, Server Action, route, pages, and middleware manifests
- production runtime behavior for every feature above
- `use cache`, `cacheLife`, and `cacheTag` compilation
- production cache miss/hit behavior and Server Action `updateTag` invalidation

## Run

```sh
npm run install:fixtures
npm run probe
npm run build:fixed-actions
npm run inspect
npm run runtime
npm run build:cache
npm run runtime:cache
```

The cache runtime fixture is intentionally separate from the broader feature
fixture. It enables Cache Components and verifies a first-request miss, an
across-request hit, immediate `updateTag` invalidation from a Server Action, the
action's same-response render, and the following cache refill/hit sequence.

The fixture uses `middleware.ts` deliberately to verify backward compatibility.
Next.js 16.2.6 accepts it but warns that the convention is deprecated in favor
of `proxy.ts`.

`compiler-probe.mjs` calls internal `next/dist/*` modules. These are available
in the npm package but are not supported public compiler APIs. The experiment
therefore pins Next.js exactly and treats the generated results as contract
tests.

The fixed Server Action key in this experiment is deliberately public and only
for deterministic comparison. A real Tuto deployment must generate and protect
its own per-application secret.

See `REPORT.md` for conclusions and the JSON files for raw results.
