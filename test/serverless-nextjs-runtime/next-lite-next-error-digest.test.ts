import { describe, expect, it } from "vitest";
import {
  getNextErrorDigest,
  parseNextHttpErrorDigest,
  parseNextRedirectDigest,
} from "@/lib/serverless-nextjs-runtime/next-lite/vendor/vinext-server/next-error-digest";

describe("vendored Vinext next-error-digest helpers", () => {
  describe("getNextErrorDigest", () => {
    it("returns the stringified digest from a digest-bearing error", () => {
      const error = { digest: "NEXT_NOT_FOUND" };
      expect(getNextErrorDigest(error)).toBe("NEXT_NOT_FOUND");
    });

    it("returns the stringified digest from a redirect digest", () => {
      const error = {
        digest: "NEXT_REDIRECT;replace;%2Fposts%2Fhello;307",
      };
      expect(getNextErrorDigest(error)).toBe("NEXT_REDIRECT;replace;%2Fposts%2Fhello;307");
    });

    it("returns null for non-digest-bearing values", () => {
      expect(getNextErrorDigest(null)).toBeNull();
      expect(getNextErrorDigest(undefined)).toBeNull();
      expect(getNextErrorDigest("NEXT_NOT_FOUND")).toBeNull();
      expect(getNextErrorDigest(42)).toBeNull();
      expect(getNextErrorDigest({})).toBeNull();
    });

    it("coerces non-string digest fields to a string", () => {
      const error = { digest: 404 };
      expect(getNextErrorDigest(error)).toBe("404");
    });
  });

  describe("parseNextRedirectDigest", () => {
    it("parses a redirect digest with type, encoded url, and status", () => {
      expect(
        parseNextRedirectDigest("NEXT_REDIRECT;replace;%2Fposts%2Fhello;307"),
      ).toEqual({
        status: 307,
        type: "replace",
        url: "/posts/hello",
      });
    });

    it("parses a redirect digest with a permanent status", () => {
      expect(
        parseNextRedirectDigest("NEXT_REDIRECT;push;%2Flogin;308"),
      ).toEqual({
        status: 308,
        type: "push",
        url: "/login",
      });
    });

    it("defaults status to 307 when omitted", () => {
      expect(parseNextRedirectDigest("NEXT_REDIRECT;replace;%2Fposts%2Fhello")).toEqual({
        status: 307,
        type: "replace",
        url: "/posts/hello",
      });
    });

    it("leaves type as null when omitted so the caller can apply context-specific defaults", () => {
      expect(parseNextRedirectDigest("NEXT_REDIRECT;;%2Fposts%2Fhello;307")).toEqual({
        status: 307,
        type: null,
        url: "/posts/hello",
      });
    });

    it("decodes percent-encoded urls including spaces and unicode", () => {
      expect(parseNextRedirectDigest("NEXT_REDIRECT;replace;hello%20world;307")).toEqual({
        status: 307,
        type: "replace",
        url: "hello world",
      });
      expect(
        parseNextRedirectDigest("NEXT_REDIRECT;replace;%E2%9C%93;307"),
      ).toEqual({
        status: 307,
        type: "replace",
        url: "\u2713",
      });
    });

    it("returns null when the digest is not a redirect digest", () => {
      expect(parseNextRedirectDigest("NEXT_NOT_FOUND")).toBeNull();
      expect(parseNextRedirectDigest("NEXT_HTTP_ERROR_FALLBACK;500")).toBeNull();
      expect(parseNextRedirectDigest("")).toBeNull();
    });

    it("returns null when the encoded url segment is missing", () => {
      expect(parseNextRedirectDigest("NEXT_REDIRECT;replace;")).toBeNull();
      expect(parseNextRedirectDigest("NEXT_REDIRECT;replace")).toBeNull();
    });
  });

  describe("parseNextHttpErrorDigest", () => {
    it("returns 404 for NEXT_NOT_FOUND", () => {
      expect(parseNextHttpErrorDigest("NEXT_NOT_FOUND")).toEqual({ status: 404 });
    });

    it("parses the status code from NEXT_HTTP_ERROR_FALLBACK", () => {
      expect(parseNextHttpErrorDigest("NEXT_HTTP_ERROR_FALLBACK;500")).toEqual({
        status: 500,
      });
      expect(parseNextHttpErrorDigest("NEXT_HTTP_ERROR_FALLBACK;403")).toEqual({
        status: 403,
      });
      expect(parseNextHttpErrorDigest("NEXT_HTTP_ERROR_FALLBACK;401")).toEqual({
        status: 401,
      });
    });

    it("returns null for unrelated digests", () => {
      expect(parseNextHttpErrorDigest("NEXT_REDIRECT;replace;%2F;307")).toBeNull();
      expect(parseNextHttpErrorDigest("")).toBeNull();
      expect(parseNextHttpErrorDigest("NEXT_HTTP_ERROR_FALLBACK")).toBeNull();
    });
  });
});
