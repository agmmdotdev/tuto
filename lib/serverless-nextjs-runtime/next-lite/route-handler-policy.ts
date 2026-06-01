// Local implementation. Not vendored.
//
// The upstream file
//   opensrc/repos/github.com/cloudflare/vinext/packages/vinext/src/server/app-route-handler-policy.ts
// is *not* safe to vendor in full: its top-of-file imports pull in
// `app-route-handler-runtime.js`, which in turn depends on `vinext/shims/server`
// (NextRequest / NextResponse), middleware, and the i18n config path. That
// violates Rule 2 (vendor only small isolated modules) and Rule 3 (no
// orchestration vendoring by accident) of
//   ../next-lite-vinext-research.md.
//
// This module re-implements the *policy* surface that the request pipeline
// will need, in isolation, and depends only on:
//   - the standard Web Fetch Request / Response types
//   - the already-vendored `next-error-digest.ts` for digest parsing
//
// The methods, auto-HEAD rule, auto-OPTIONS rule, Allow-header shape, and
// digest-to-Response mapping mirror Vinext's behavior so that future route
// handler work has a stable contract to call against.

import {
  parseNextHttpErrorDigest,
  parseNextRedirectDigest,
} from "./vendor/vinext-server/next-error-digest";

export const ROUTE_HANDLER_HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
] as const;

export type RouteHandlerHttpMethod = (typeof ROUTE_HANDLER_HTTP_METHODS)[number];

export type RouteHandlerModule = Partial<
  Record<RouteHandlerHttpMethod, unknown>
>;

/**
 * Recognized HTTP methods for App Router route handlers. Methods outside this
 * list must be rejected with 400 before any auto-OPTIONS or 405 logic runs.
 */
export function isValidHTTPMethod(
  maybeMethod: string,
): maybeMethod is RouteHandlerHttpMethod {
  return (ROUTE_HANDLER_HTTP_METHODS as readonly string[]).includes(maybeMethod);
}

/**
 * Returns the list of HTTP methods a route handler module actually exports,
 * plus `HEAD` if `GET` is exported (the Next.js auto-HEAD rule).
 */
export function collectRouteHandlerMethods(
  handler: RouteHandlerModule,
): RouteHandlerHttpMethod[] {
  const methods = ROUTE_HANDLER_HTTP_METHODS.filter(
    (method) => typeof handler[method] === "function",
  );

  if (methods.includes("GET") && !methods.includes("HEAD")) {
    methods.push("HEAD");
  }

  return methods;
}

/**
 * Builds the value for the `Allow` response header used on automatic
 * `OPTIONS` responses. Always includes `OPTIONS`, dedupes, sorts.
 *
 * Example: `["GET", "POST"]` → `"GET, OPTIONS, POST"`.
 */
export function buildRouteHandlerAllowHeader(
  exportedMethods: readonly RouteHandlerHttpMethod[],
): string {
  const allow = new Set<RouteHandlerHttpMethod>(exportedMethods);
  allow.add("OPTIONS");
  return Array.from(allow).sort().join(", ");
}

export type ResolvedRouteHandlerMethod = {
  allowHeaderForOptions: string;
  exportedMethods: RouteHandlerHttpMethod[];
  handlerFn: unknown;
  isAutoHead: boolean;
  shouldAutoRespondToOptions: boolean;
};

/**
 * Resolves what the pipeline should do for a `(handler, method)` pair. Returns
 * the handler function (or the GET handler if HEAD was requested and only GET
 * is exported — the auto-HEAD rule), the list of exported methods, the
 * precomputed Allow header, whether the response was synthesized as auto-HEAD,
 * and whether the pipeline should auto-respond to this OPTIONS request.
 *
 * `handlerFn` is typed as `unknown` because the runtime decides how to invoke
 * it; the pipeline calls it with `(request, context)` once route handlers are
 * wired in.
 */
export function resolveRouteHandlerMethod(
  handler: RouteHandlerModule,
  method: string,
): ResolvedRouteHandlerMethod {
  const exportedMethods = collectRouteHandlerMethods(handler);
  const allowHeaderForOptions = buildRouteHandlerAllowHeader(exportedMethods);
  const shouldAutoRespondToOptions =
    method === "OPTIONS" && typeof handler.OPTIONS !== "function";

  let handlerFn: unknown =
    typeof handler[method as RouteHandlerHttpMethod] === "function"
      ? handler[method as RouteHandlerHttpMethod]
      : undefined;
  let isAutoHead = false;

  if (
    method === "HEAD" &&
    typeof handler.HEAD !== "function" &&
    typeof handler.GET === "function"
  ) {
    handlerFn = handler.GET;
    isAutoHead = true;
  }

  return {
    allowHeaderForOptions,
    exportedMethods,
    handlerFn,
    isAutoHead,
    shouldAutoRespondToOptions,
  };
}

export type DigestResponse =
  | { kind: "redirect"; location: string; statusCode: number }
  | { kind: "status"; statusCode: number }
  | { kind: "none" };

/**
 * Inspects a thrown value and decides whether it represents a Next.js
 * control-flow digest (`redirect()`, `notFound()`, `forbidden()`,
 * `unauthorized()`). When it does, returns a structured decision the
 * pipeline can turn into a `Response`; otherwise returns `{ kind: "none" }`
 * and the pipeline should treat the error as a real exception.
 *
 * - `requestUrl` is used to resolve relative redirect targets, matching
 *   `URL(redirectUrl, requestUrl)`.
 * - `isAction` flips the redirect status to 303 for Server Action responses,
 *   matching Next.js's action-vs-document behavior. Unused until Server
 *   Actions are implemented, but the slot is here so callers don't have to
 *   change shape later.
 */
export function resolveRouteHandlerSpecialError(
  error: unknown,
  requestUrl: string,
  options: { isAction?: boolean } = {},
): DigestResponse {
  if (!error || typeof error !== "object" || !("digest" in error)) {
    return { kind: "none" };
  }

  const digest = String((error as { digest: unknown }).digest);

  const redirect = parseNextRedirectDigest(digest);
  if (redirect) {
    return {
      kind: "redirect",
      location: new URL(redirect.url, requestUrl).toString(),
      statusCode: options.isAction ? 303 : redirect.status,
    };
  }

  const httpError = parseNextHttpErrorDigest(digest);
  if (httpError) {
    return { kind: "status", statusCode: httpError.status };
  }

  return { kind: "none" };
}

/**
 * Turns a `DigestResponse` into a real `Response` object. Returns `null` for
 * `{ kind: "none" }` so the caller can re-throw the original error.
 *
 *   - redirect → `302/303/307/308` with `Location` header
 *   - status   → plain body, the parsed status code
 */
export function digestResponseToResponse(decision: DigestResponse): Response | null {
  if (decision.kind === "none") return null;

  if (decision.kind === "redirect") {
    return new Response(null, {
      status: decision.statusCode,
      headers: { location: decision.location },
    });
  }

  return new Response(null, { status: decision.statusCode });
}
