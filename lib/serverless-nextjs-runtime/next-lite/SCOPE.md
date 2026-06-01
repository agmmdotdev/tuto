# Next-Lite Supported Scope

This file is the authoritative statement of what `next-lite` supports, partially supports, intentionally does not support, vendors, or delegates. It exists to satisfy Rule 6 of `../next-lite-vinext-research.md`: every supported-scope decision must be recorded in repo form, not implied by passing tests or template prose.

Last verified against the working tree on 2026-06-01.

## Status legend

- **supported** — implemented, tested, exercised in the runtime path.
- **partial** — implemented in part, with explicit gaps called out.
- **unsupported** — not implemented, but on the near-term roadmap.
- **vendored** — implemented by copying a small isolated module from Vinext, with tests pinning the reused behavior.
- **delegated** — implemented by relying on a public Vinext package export, with tests pinning the boundary.
- **out of scope** — not implemented and not on the roadmap; documented so we stop being asked.

## How to read this

- The **Evidence** column is the test file or vendored source file that proves the row.
- The **Notes** column says why the status is what it is.
- A row that changes status must update this file in the same PR. A row that is added must include a test or a "no test needed" justification.

## Compiler

| Capability | Status | Evidence | Notes |
| --- | --- | --- | --- |
| esbuild compile pipeline | supported | `compiler.ts` | Sole production compiler path. |
| Rolldown compile pipeline | unsupported | `scripts/measure-offline-compilers.mjs` | Declared dependency and benchmark fixture only. Not wired. |
| Vinext / Vite / Next in request path | out of scope | Rule 5 in research notes | Forbidden by design. |
| Background rebuild on file change | unsupported | — | Not implemented. |

## App Router subset

| Capability | Status | Evidence | Notes |
| --- | --- | --- | --- |
| `app/page.tsx` | supported | `test/.../next-lite-static-render.test.ts` | Root + nested. |
| `app/layout.tsx` | supported | `test/.../next-lite-static-render.test.ts` | Single + nested layout chain (root → posts → post-detail). |
| Invisible segments `(group)`, `@slot`, `_private` | supported | `route-discovery.ts` (`isInvisibleAppSegment`) | Filtered during discovery; tested implicitly. |
| Route discovery (filesystem → `NextLiteRoute[]`) | supported | `route-discovery.ts`, `next-lite-static-render.test.ts` | Sorts by vendored `compareRoutes`. |
| Nested routes | supported | `next-lite-static-render.test.ts` | |
| Dynamic segments `[id]` | supported | `next-lite-static-render.test.ts` | |
| Catch-all segments `[...rest]` | supported | `test/.../next-lite-routing-vendored.test.ts` | Direct unit test of vendored `matchRoutePattern`. |
| Optional catch-all segments `[[...slug]]` | supported | `test/.../next-lite-routing-vendored.test.ts` | |
| URL-encoded dynamic params | supported | `next-lite-static-render.test.ts` | Decoded by vendored `matchRoutePattern`. |
| `params` prop on page | supported | `next-lite-template.test.ts`, `next-lite-static-render.test.ts` | |
| `searchParams` prop on page | supported | `next-lite-template.test.ts` | Single value and array forms. |
| 404 for unmatched paths | supported | `next-lite-static-render.test.ts` | Plain text body. |
| `loading.tsx` | unsupported | — | Not implemented. |
| `error.tsx`, `global-error.tsx` | unsupported | — | Not implemented. |
| `not-found.tsx` | unsupported | — | Not implemented. |
| `template.tsx` | unsupported | — | Not implemented. |
| Parallel routes `@slot` | unsupported | — | Filtered out by discovery; no rendering. |
| Intercepting routes `(.)`, `(..)`, `(...)` | unsupported | — | Not implemented. |
| Route groups `(group)` | supported (filtering only) | `route-discovery.ts` | Used to hide route groups from URL; no layout-merging semantics. |

## Reused / vendored behavior (Rule 4 tests must pin these)

| Capability | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Route pattern parsing `[id]`, `[...rest]`, `[[...slug]]` | vendored | `vendor/vinext-routing/route-pattern.ts`, `test/.../next-lite-routing-vendored.test.ts` | Header + source path recorded. |
| Route trie / matching | vendored | `vendor/vinext-routing/route-trie.ts`, `vendor/vinext-routing/route-matching.ts` | Exercised in `next-lite-static-render.test.ts`. |
| `compareRoutes` precedence | vendored | `vendor/vinext-routing/utils.ts`, `test/.../next-lite-routing-vendored.test.ts` | Static > dynamic > catch-all, `+` < `*`, alphabetic tie-break. |
| `decodeRouteSegment` / `normalizePathnameForRouteMatch` / `decodeMatchedParams` | vendored | `vendor/vinext-routing/utils.ts`, `test/.../next-lite-routing-vendored.test.ts` | |
| Next error digest parsing (`NEXT_REDIRECT`, `NEXT_NOT_FOUND`, `NEXT_HTTP_ERROR_FALLBACK`) | vendored | `vendor/vinext-server/next-error-digest.ts`, `test/.../next-lite-next-error-digest.test.ts` | Used by the new policy module. No runtime wiring yet. |
| `app-route-handler-policy.ts` (upstream file) | not vendored | — | File imports `app-route-handler-runtime.js`; not isolated. Replaced with local policy module. |
| `app-route-handler-runtime.ts`, `app-route-handler-dispatch.ts` | not vendored | — | Rule 3 deferral. |
| Vinext `next/*` shims (`NextRequest`, `NextResponse`, etc.) | unsupported | — | Would require either `vinext/shims/server` (delegated) or a local shim. Not started. |

## Route handlers

| Capability | Status | Evidence | Notes |
| --- | --- | --- | --- |
| HTTP method policy (allowed methods, auto-HEAD, auto-OPTIONS, Allow header) | supported (policy only) | `route-handler-policy.ts`, `test/.../next-lite-route-handler-policy.test.ts` | Policy primitive. No request-pipeline wiring yet. |
| Digest → `Response` mapping (`redirect()`, `notFound()`, `forbidden()`, `unauthorized()`) | supported (policy only) | `route-handler-policy.ts`, `test/.../next-lite-route-handler-policy.test.ts` | Uses vendored digest parser. |
| `app/.../route.ts` discovery | unsupported | — | Not implemented. |
| `app/.../route.ts` execution in the request pipeline | unsupported | — | Not implemented. |
| Dynamic / static route handler cache policy | unsupported | — | Not implemented. |

## Client / server directives

| Capability | Status | Evidence | Notes |
| --- | --- | --- | --- |
| `"use client"` directive transform | unsupported | — | Requires client reference manifest + browser target. |
| `"use server"` directive transform | unsupported | — | Requires action ID strategy + RPC stub + server reference manifest. |
| Server actions | unsupported | — | Depends on `use server`. |
| RSC streaming | unsupported | — | Out of scope for the lightweight path. |
| Client reference manifest | unsupported | — | Out of scope. |

## `next/*` imports

| Capability | Status | Evidence | Notes |
| --- | --- | --- | --- |
| `next/link` | out of scope | Template `README` | Deliberately not supported. |
| `next/navigation` (`useRouter`, `redirect`, `usePathname`, `useSearchParams`) | partial | `next-error-digest.ts` covers `redirect`/`notFound` digests | The redirect/notFound digests are parseable. The `useRouter` hooks are not. |
| `next/headers` | out of scope | — | Not implemented. |
| `next/image` | out of scope | — | Not implemented. |
| `next/font` | out of scope | — | Not implemented. |
| `next/dynamic` | out of scope | — | Not implemented. |

## Other

| Capability | Status | Evidence | Notes |
| --- | --- | --- | --- |
| CSS imports (`import "./foo.css"`) | out of scope | Template `README` | Avoided by design. |
| `public/` static assets | unsupported | — | Not wired into the runtime entry. |
| Middleware (`middleware.ts`) | out of scope | — | Not implemented. |
| Instrumentation (`instrumentation.ts`) | out of scope | — | Not implemented. |
| i18n routing | out of scope | — | Not implemented. |
| App Router metadata (file-based `metadata.ts`, `opengraph-image.tsx`, etc.) | out of scope | — | Not implemented. |
| Pages Router | out of scope | — | App Router only. |

## What this list does not promise

- It does not promise Next.js feature parity. Full parity is a non-goal (see research notes).
- It does not promise stability of the public API. The barrel `index.ts` is the only stable surface until we version this.
- It does not promise Vinext/Next behavior outside what the cited tests pin. Vendored code may evolve upstream; when it does, update both the vendored file and the tests in the same change.
