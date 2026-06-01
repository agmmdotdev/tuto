import { describe, expect, it } from "vitest";
import {
  ROUTE_HANDLER_HTTP_METHODS,
  buildRouteHandlerAllowHeader,
  collectRouteHandlerMethods,
  digestResponseToResponse,
  isValidHTTPMethod,
  resolveRouteHandlerMethod,
  resolveRouteHandlerSpecialError,
  type RouteHandlerModule,
} from "@/lib/serverless-nextjs-runtime/next-lite/route-handler-policy";

const handler = (overrides: Partial<RouteHandlerModule> = {}): RouteHandlerModule => ({
  GET: () => new Response("ok"),
  POST: () => new Response("created"),
  ...overrides,
});

describe("route-handler-policy / HTTP method primitives", () => {
  it("exposes the seven recognized HTTP methods in a stable order", () => {
    expect(ROUTE_HANDLER_HTTP_METHODS).toEqual([
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "DELETE",
      "PATCH",
      "OPTIONS",
    ]);
  });

  it("accepts only the seven recognized HTTP methods", () => {
    for (const method of ROUTE_HANDLER_HTTP_METHODS) {
      expect(isValidHTTPMethod(method)).toBe(true);
    }

    expect(isValidHTTPMethod("TRACE")).toBe(false);
    expect(isValidHTTPMethod("CONNECT")).toBe(false);
    expect(isValidHTTPMethod("FOO")).toBe(false);
    expect(isValidHTTPMethod("")).toBe(false);
  });
});

describe("route-handler-policy / collectRouteHandlerMethods", () => {
  it("returns the exported function-typed methods and auto-adds HEAD when GET is present", () => {
    expect(collectRouteHandlerMethods(handler())).toEqual(["GET", "POST", "HEAD"]);
  });

  it("adds HEAD when GET is exported and HEAD is not (auto-HEAD rule)", () => {
    expect(collectRouteHandlerMethods(handler({ HEAD: undefined }))).toEqual([
      "GET",
      "POST",
      "HEAD",
    ]);
  });

  it("does not duplicate HEAD when both GET and HEAD are exported", () => {
    const methods = collectRouteHandlerMethods(
      handler({ HEAD: () => new Response(null, { status: 200 }) }),
    );
    expect(methods).toContain("GET");
    expect(methods).toContain("HEAD");
    expect(methods).toContain("POST");
    expect(methods.filter((m) => m === "HEAD")).toHaveLength(1);
  });

  it("does not add HEAD when GET is not exported", () => {
    expect(collectRouteHandlerMethods({ POST: () => new Response() })).toEqual(["POST"]);
  });

  it("ignores non-function exports", () => {
    const module: RouteHandlerModule = {
      GET: "not a function",
      POST: () => new Response(),
    };
    expect(collectRouteHandlerMethods(module)).toEqual(["POST"]);
  });
});

describe("route-handler-policy / buildRouteHandlerAllowHeader", () => {
  it("adds OPTIONS, dedupes, and sorts the result", () => {
    expect(buildRouteHandlerAllowHeader(["GET", "POST"])).toBe("GET, OPTIONS, POST");
  });

  it("does not duplicate OPTIONS when it is already in the input", () => {
    expect(buildRouteHandlerAllowHeader(["OPTIONS", "GET"])).toBe("GET, OPTIONS");
  });

  it("returns only OPTIONS when the input is empty", () => {
    expect(buildRouteHandlerAllowHeader([])).toBe("OPTIONS");
  });
});

describe("route-handler-policy / resolveRouteHandlerMethod", () => {
  it("resolves a normal exported method to its handler function", () => {
    const h = handler();
    const resolved = resolveRouteHandlerMethod(h, "GET");
    expect(resolved.exportedMethods).toEqual(["GET", "POST", "HEAD"]);
    expect(resolved.allowHeaderForOptions).toBe("GET, HEAD, OPTIONS, POST");
    expect(resolved.handlerFn).toBe(h.GET);
    expect(resolved.isAutoHead).toBe(false);
    expect(resolved.shouldAutoRespondToOptions).toBe(false);
  });

  it("substitutes the GET handler for HEAD and sets isAutoHead", () => {
    const h = handler({ HEAD: undefined });
    const resolved = resolveRouteHandlerMethod(h, "HEAD");
    expect(resolved.handlerFn).toBe(h.GET);
    expect(resolved.isAutoHead).toBe(true);
    expect(resolved.shouldAutoRespondToOptions).toBe(false);
  });

  it("prefers an explicit HEAD export over auto-HEAD", () => {
    const explicitHead = () => new Response(null, { status: 200 });
    const h = handler({ HEAD: explicitHead });
    const resolved = resolveRouteHandlerMethod(h, "HEAD");
    expect(resolved.handlerFn).toBe(explicitHead);
    expect(resolved.isAutoHead).toBe(false);
  });

  it("marks shouldAutoRespondToOptions for OPTIONS when no OPTIONS export exists", () => {
    const resolved = resolveRouteHandlerMethod(handler(), "OPTIONS");
    expect(resolved.shouldAutoRespondToOptions).toBe(true);
    expect(resolved.handlerFn).toBeUndefined();
  });

  it("does not mark shouldAutoRespondToOptions when an OPTIONS export exists", () => {
    const h = handler({ OPTIONS: () => new Response(null) });
    const resolved = resolveRouteHandlerMethod(h, "OPTIONS");
    expect(resolved.shouldAutoRespondToOptions).toBe(false);
    expect(resolved.handlerFn).toBe(h.OPTIONS);
  });

  it("returns undefined handlerFn for unexported methods that are not HEAD", () => {
    const resolved = resolveRouteHandlerMethod(handler(), "PUT");
    expect(resolved.handlerFn).toBeUndefined();
    expect(resolved.isAutoHead).toBe(false);
  });
});

describe("route-handler-policy / resolveRouteHandlerSpecialError", () => {
  it("returns kind:none for non-digest-bearing values", () => {
    expect(resolveRouteHandlerSpecialError(null, "http://x/")).toEqual({ kind: "none" });
    expect(resolveRouteHandlerSpecialError(new Error("boom"), "http://x/")).toEqual({
      kind: "none",
    });
    expect(resolveRouteHandlerSpecialError({ message: "no digest" }, "http://x/")).toEqual({
      kind: "none",
    });
  });

  it("resolves a NEXT_REDIRECT digest against the request URL", () => {
    const error = { digest: "NEXT_REDIRECT;replace;%2Fposts%2Fhello;307" };
    expect(resolveRouteHandlerSpecialError(error, "http://x/a/b")).toEqual({
      kind: "redirect",
      location: "http://x/posts/hello",
      statusCode: 307,
    });
  });

  it("keeps the redirect status for document requests", () => {
    const error = { digest: "NEXT_REDIRECT;push;%2Flogin;308" };
    const decision = resolveRouteHandlerSpecialError(error, "http://x/");
    expect(decision.kind).toBe("redirect");
    if (decision.kind === "redirect") {
      expect(decision.statusCode).toBe(308);
    }
  });

  it("swaps the redirect status to 303 for action requests", () => {
    const error = { digest: "NEXT_REDIRECT;push;%2Flogin;307" };
    const decision = resolveRouteHandlerSpecialError(error, "http://x/", { isAction: true });
    expect(decision.kind).toBe("redirect");
    if (decision.kind === "redirect") {
      expect(decision.statusCode).toBe(303);
    }
  });

  it("resolves an absolute redirect URL unchanged", () => {
    const error = {
      digest: `NEXT_REDIRECT;replace;${encodeURIComponent("https://other.example/x")};308`,
    };
    const decision = resolveRouteHandlerSpecialError(error, "http://x/");
    expect(decision.kind).toBe("redirect");
    if (decision.kind === "redirect") {
      expect(decision.location).toBe("https://other.example/x");
    }
  });

  it("returns kind:status with the parsed status for NEXT_NOT_FOUND", () => {
    expect(
      resolveRouteHandlerSpecialError({ digest: "NEXT_NOT_FOUND" }, "http://x/"),
    ).toEqual({ kind: "status", statusCode: 404 });
  });

  it("returns kind:status with the parsed status for NEXT_HTTP_ERROR_FALLBACK", () => {
    expect(
      resolveRouteHandlerSpecialError({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" }, "http://x/"),
    ).toEqual({ kind: "status", statusCode: 403 });
    expect(
      resolveRouteHandlerSpecialError({ digest: "NEXT_HTTP_ERROR_FALLBACK;401" }, "http://x/"),
    ).toEqual({ kind: "status", statusCode: 401 });
    expect(
      resolveRouteHandlerSpecialError({ digest: "NEXT_HTTP_ERROR_FALLBACK;500" }, "http://x/"),
    ).toEqual({ kind: "status", statusCode: 500 });
  });
});

describe("route-handler-policy / digestResponseToResponse", () => {
  it("returns null for kind:none so the caller can re-throw", () => {
    expect(digestResponseToResponse({ kind: "none" })).toBeNull();
  });

  it("returns a 307/308/302 redirect response with a Location header", () => {
    const r1 = digestResponseToResponse({
      kind: "redirect",
      location: "https://other.example/x",
      statusCode: 307,
    });
    expect(r1).not.toBeNull();
    expect(r1!.status).toBe(307);
    expect(r1!.headers.get("location")).toBe("https://other.example/x");

    const r2 = digestResponseToResponse({
      kind: "redirect",
      location: "/x",
      statusCode: 308,
    });
    expect(r2!.status).toBe(308);
    expect(r2!.headers.get("location")).toBe("/x");
  });

  it("returns a 303 redirect response when the action flag flipped the status", () => {
    const r = digestResponseToResponse({
      kind: "redirect",
      location: "/x",
      statusCode: 303,
    });
    expect(r!.status).toBe(303);
    expect(r!.headers.get("location")).toBe("/x");
  });

  it("returns a bodyless response with the parsed status for kind:status", () => {
    const r = digestResponseToResponse({ kind: "status", statusCode: 404 });
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
    expect(r!.headers.get("content-length")).not.toBe("0");
    expect(r!.headers.get("content-type")).toBeNull();
  });
});
