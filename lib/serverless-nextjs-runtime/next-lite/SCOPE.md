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
| `app/page.tsx` | supported | `test/.../next-lite-static-render.test.ts`, `test/.../next-lite-route-discovery.test.ts` | Root + nested. |
| `app/layout.tsx` | supported | `test/.../next-lite-static-render.test.ts`, `test/.../next-lite-route-discovery.test.ts` | Single + nested layout chain (root → posts → post-detail). Direct discovery test pins the chain order and missing-level holes. |
| Invisible segments `(group)`, `@slot`, `_private` | supported (literal `_private` only) | `test/.../next-lite-route-discovery.test.ts` | Direct discovery test covers each kind alone and all three combined. `_private` is matched literally, not as a general underscore-prefix rule — narrower than current Next.js, see the pinned test for the exact contract. |
| Route discovery (filesystem → `NextLiteRoute[]`) | supported | `route-discovery.ts`, `test/.../next-lite-route-discovery.test.ts` | Direct unit test covers sort order, error paths, page routes, and route handler routes. |
| Nested routes | supported | `test/.../next-lite-static-render.test.ts`, `test/.../next-lite-route-discovery.test.ts` | |
| Dynamic segments `[id]` | supported | `test/.../next-lite-static-render.test.ts`, `test/.../next-lite-route-discovery.test.ts` | |
| Catch-all segments `[...rest]` | supported | `test/.../next-lite-routing-vendored.test.ts`, `test/.../next-lite-route-discovery.test.ts` | Direct unit test of vendored `matchRoutePattern` plus discovery-level pattern. |
| Optional catch-all segments `[[...slug]]` | supported | `test/.../next-lite-routing-vendored.test.ts`, `test/.../next-lite-route-discovery.test.ts` | |
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
| Route groups `(group)` | supported (filtering only) | `test/.../next-lite-route-discovery.test.ts` | Used to hide route groups from URL; no layout-merging semantics. |

## Reused / vendored behavior (Rule 4 tests must pin these)

| Capability | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Route pattern parsing `[id]`, `[...rest]`, `[[...slug]]` | vendored | `vendor/vinext-routing/route-pattern.ts`, `test/.../next-lite-routing-vendored.test.ts` | Header + source path recorded. |
| Route trie / matching | vendored | `vendor/vinext-routing/route-trie.ts`, `vendor/vinext-routing/route-matching.ts` | Exercised in `next-lite-static-render.test.ts`. |
| `compareRoutes` precedence | vendored | `vendor/vinext-routing/utils.ts`, `test/.../next-lite-routing-vendored.test.ts` | Static > dynamic > catch-all, `+` < `*`, alphabetic tie-break. |
| `decodeRouteSegment` / `normalizePathnameForRouteMatch` / `decodeMatchedParams` | vendored | `vendor/vinext-routing/utils.ts`, `test/.../next-lite-routing-vendored.test.ts` | |
| Next error digest parsing (`NEXT_REDIRECT`, `NEXT_NOT_FOUND`, `NEXT_HTTP_ERROR_FALLBACK`) | vendored | `vendor/vinext-server/next-error-digest.ts`, `test/.../next-lite-next-error-digest.test.ts` | Used by the route handler policy module and dispatch path. |
| `app-route-handler-policy.ts` (upstream file) | not vendored | — | File imports `app-route-handler-runtime.js`; not isolated. Replaced with local policy module. |
| `app-route-handler-runtime.ts`, `app-route-handler-dispatch.ts` | not vendored | — | Rule 3 deferral. |
| Vinext `next/*` shims (`NextRequest`, `NextResponse`, etc.) | partial | `next-server-shim.ts`, `test/.../next-lite-route-handler-render.test.ts` | Local lightweight `next/server` shim supports `NextResponse.json()` and `NextResponse.redirect()`. `NextRequest` is intentionally not exported yet. |

## Route handlers

| Capability | Status | Evidence | Notes |
| --- | --- | --- | --- |
| HTTP method policy (allowed methods, auto-HEAD, auto-OPTIONS, Allow header) | supported | `route-handler-policy.ts`, `test/.../next-lite-route-handler-policy.test.ts`, `test/.../next-lite-route-handler-render.test.ts` | Policy primitive is wired into the generated request pipeline. |
| Digest → `Response` mapping (`redirect()`, `notFound()`, `forbidden()`, `unauthorized()`) | supported | `route-handler-policy.ts`, `test/.../next-lite-route-handler-policy.test.ts` | Uses vendored digest parser and is called by route handler dispatch. |
| `app/.../route.ts` discovery | supported | `test/.../next-lite-route-discovery.test.ts` | Covers `.ts`, `.tsx`, `.js`, `.jsx`, dynamic pattern generation, route-only workspaces, and page/handler conflicts. |
| `app/.../route.ts` execution in the request pipeline | supported | `test/.../next-lite-route-handler-render.test.ts` | Uses standard Web `Request` input. Handlers may return standard Web `Response` or the local `NextResponse` shim. |
| Dynamic / static route handler cache policy | unsupported | — | Not implemented. |

## Route Handler Request / Response Roadmap

Current focus: keep the route handler runtime on the standard Web platform contract while adding only the smallest `next/server` compatibility surface needed by common App Router examples.

What is supported now:

- Route handlers receive the original standard Web `Request`.
- Route handlers receive decoded params as the second argument: `{ params }`.
- Route handlers must return a standard Web `Response`.
- Method policy is wired: valid HTTP methods, auto-`HEAD`, auto-`OPTIONS`, `405` with `Allow`, and invalid-method `400`.
- `next/server` is aliased to a local lightweight shim during the Next Lite build.
- `NextResponse.json(body, init?)` is supported.
- `NextResponse.redirect(url, init?)` is supported for redirect statuses `301`, `302`, `303`, `307`, and `308`.

Next `Response` slice to consider:

- Add only concrete `NextResponse` members that are needed by template or route handler examples.
- Possible future members: cookie mutation helpers, rewritten URLs, and other response metadata helpers.
- Each member must get direct route-handler render tests before it moves out of unsupported scope.

Left for later `Request` work:

- Do not implement full `NextRequest` yet.
- Keep handler input as standard Web `Request` until a concrete feature needs more.
- `NextRequest` is intentionally not exported by the local `next/server` shim.
- Later `NextRequest` work should be split into explicit slices such as `nextUrl`, cookies, headers helpers, geo/ip metadata, and middleware interaction.
- Avoid vendoring Vinext's full app route runtime for this; it pulls in orchestration and shim dependencies that violate the current lightweight boundary.

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
