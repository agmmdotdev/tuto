import { describe, expect, it } from "vitest";
import { compareRoutes } from "@/lib/serverless-nextjs-runtime/next-lite/vendor/vinext-routing/utils";
import {
  matchRoutePattern,
  routePattern,
  routePatternParts,
} from "@/lib/serverless-nextjs-runtime/next-lite/vendor/vinext-routing/route-pattern";
import {
  buildParams,
  decodeMatchedParams,
  decodeRouteSegment,
  normalizePathnameForRouteMatch,
} from "@/lib/serverless-nextjs-runtime/next-lite/vendor/vinext-routing/utils";

describe("vendored Vinext route-pattern helpers", () => {
  describe("routePattern / routePatternParts", () => {
    it("returns the empty pattern for the root pathname", () => {
      expect(routePattern("/")).toBe("");
      expect(routePatternParts("/")).toEqual([]);
    });

    it("passes through static segments", () => {
      expect(routePattern("/posts")).toBe("/posts");
      expect(routePatternParts("/posts")).toEqual(["posts"]);
    });

    it("converts dynamic segments [id] to :id", () => {
      expect(routePattern("/posts/[id]")).toBe("/posts/:id");
      expect(routePatternParts("/posts/[id]")).toEqual(["posts", ":id"]);
    });

    it("converts catch-all segments [...rest] to :rest+", () => {
      expect(routePattern("/docs/[...rest]")).toBe("/docs/:rest+");
      expect(routePatternParts("/docs/[...rest]")).toEqual(["docs", ":rest+"]);
    });

    it("converts optional catch-all segments [[...slug]] to :slug*", () => {
      expect(routePattern("/[[...slug]]")).toBe("/:slug*");
      expect(routePatternParts("/[[...slug]]")).toEqual([":slug*"]);
      expect(routePattern("/posts/[[...slug]]")).toBe("/posts/:slug*");
    });

    it("mixes static, dynamic, catch-all, and optional catch-all in one path", () => {
      expect(routePattern("/a/[b]/[...c]/[[...d]]")).toBe("/a/:b/:c+/:d*");
      expect(routePatternParts("/a/[b]/[...c]/[[...d]]")).toEqual([
        "a",
        ":b",
        ":c+",
        ":d*",
      ]);
    });
  });

  describe("matchRoutePattern", () => {
    it("returns an empty params object when both url and pattern are static and equal", () => {
      expect(matchRoutePattern(["posts"], ["posts"])).toEqual({});
    });

    it("returns null when the static lengths do not match", () => {
      expect(matchRoutePattern(["posts"], ["posts", "extra"])).toBeNull();
      expect(matchRoutePattern(["posts", "extra"], ["posts"])).toBeNull();
    });

    it("matches a single dynamic segment and captures the value", () => {
      expect(matchRoutePattern(["posts", "42"], ["posts", ":id"])).toEqual({
        id: "42",
      });
    });

    it("decodes percent-encoded dynamic segment values", () => {
      expect(
        matchRoutePattern(["posts", "hello%20world"], ["posts", ":id"]),
      ).toEqual({ id: "hello world" });
    });

    it("matches a required catch-all and captures the array of remaining segments", () => {
      expect(
        matchRoutePattern(["docs", "a", "b", "c"], ["docs", ":rest+"]),
      ).toEqual({ rest: ["a", "b", "c"] });
    });

    it("does not match a required catch-all with zero remaining segments", () => {
      expect(matchRoutePattern(["docs"], ["docs", ":rest+"])).toBeNull();
    });

    it("matches an optional catch-all with zero remaining segments (param absent)", () => {
      const result = matchRoutePattern(["posts"], ["posts", ":slug*"]);
      expect(result).toEqual({});
      expect(result && "slug" in result ? result.slug : "absent").toBe("absent");
    });

    it("matches an optional catch-all with one remaining segment", () => {
      expect(matchRoutePattern(["posts", "a"], ["posts", ":slug*"])).toEqual({
        slug: ["a"],
      });
    });

    it("returns null when url and pattern diverge on a static segment", () => {
      expect(matchRoutePattern(["posts", "x"], ["users", ":id"])).toBeNull();
    });

    it("captures a single dynamic segment as a string (not an array)", () => {
      const result = matchRoutePattern(["posts", "x"], ["posts", ":id"]);
      expect(result).toEqual({ id: "x" });
      expect(Array.isArray(result?.id)).toBe(false);
    });
  });
});

describe("vendored Vinext routing utils", () => {
  describe("compareRoutes (route precedence)", () => {
    const pat = (pattern: string) => ({ pattern });

    it("orders static routes before dynamic routes at the same depth", () => {
      const sorted = [pat("/posts/:id"), pat("/posts")].sort(compareRoutes);
      expect(sorted.map((route) => route.pattern)).toEqual(["/posts", "/posts/:id"]);
    });

    it("orders dynamic routes before catch-all routes at the same depth", () => {
      const sorted = [pat("/posts/:rest+"), pat("/posts/:id")].sort(compareRoutes);
      expect(sorted.map((route) => route.pattern)).toEqual([
        "/posts/:id",
        "/posts/:rest+",
      ]);
    });

    it("orders a required catch-all before an optional catch-all at the same depth", () => {
      const sorted = [pat("/:slug*"), pat("/:slug+")].sort(compareRoutes);
      expect(sorted.map((route) => route.pattern)).toEqual(["/:slug+", "/:slug*"]);
    });

    it("breaks ties between static patterns by alphabetic order (no length-based precedence)", () => {
      const sorted = [pat("/a/b"), pat("/a")].sort(compareRoutes);
      expect(sorted.map((route) => route.pattern)).toEqual(["/a", "/a/b"]);
    });

    it("breaks ties by lexicographic pattern order", () => {
      const sorted = [pat("/b"), pat("/a")].sort(compareRoutes);
      expect(sorted.map((route) => route.pattern)).toEqual(["/a", "/b"]);
    });
  });

  describe("buildParams", () => {
    it("builds a null-prototype params object from entries", () => {
      const params = buildParams([
        ["id", "42"],
        ["rest", ["a", "b"]],
      ]);
      expect(params).toEqual({ id: "42", rest: ["a", "b"] });
      expect(Object.getPrototypeOf(params)).toBeNull();
    });
  });

  describe("decodeMatchedParams", () => {
    it("decodes percent-encoded string values in place", () => {
      const params: Record<string, string | string[]> = { id: "hello%20world" };
      decodeMatchedParams(params);
      expect(params.id).toBe("hello world");
    });

    it("decodes percent-encoded values inside arrays in place", () => {
      const params: Record<string, string | string[]> = {
        rest: ["hello%20world", "%2Ffoo"],
      };
      decodeMatchedParams(params);
      expect(params.rest).toEqual(["hello world", "/foo"]);
    });

    it("leaves values that fail to decode unchanged", () => {
      const params: Record<string, string | string[]> = { id: "%E0%A4%A" };
      decodeMatchedParams(params);
      expect(params.id).toBe("%E0%A4%A");
    });
  });

  describe("decodeRouteSegment", () => {
    it("decodes a percent-encoded segment to its plain form", () => {
      expect(decodeRouteSegment("hello%20world")).toBe("hello world");
    });

    it("re-encodes path delimiter characters after decoding so they cannot break routing", () => {
      expect(decodeRouteSegment("a%2Fb")).toBe("a%2Fb");
      expect(decodeRouteSegment("a%23b")).toBe("a%23b");
      expect(decodeRouteSegment("a%3Fb")).toBe("a%3Fb");
    });

    it("returns the original segment when decoding throws", () => {
      expect(decodeRouteSegment("%E0%A4%A")).toBe("%E0%A4%A");
    });
  });

  describe("normalizePathnameForRouteMatch", () => {
    it("decodes each path segment", () => {
      expect(normalizePathnameForRouteMatch("/posts/hello%20world")).toBe(
        "/posts/hello world",
      );
    });

    it("keeps path delimiters inside a segment percent-encoded after decoding", () => {
      expect(normalizePathnameForRouteMatch("/posts/a%2Fb")).toBe("/posts/a%2Fb");
    });

    it("preserves the leading slash and segment count", () => {
      expect(normalizePathnameForRouteMatch("/a/b/c")).toBe("/a/b/c");
      expect(normalizePathnameForRouteMatch("/")).toBe("/");
    });
  });
});
