// Vendored from Cloudflare Vinext, MIT License.
// Source: opensrc/repos/github.com/cloudflare/vinext/packages/vinext/src/routing/route-pattern.ts

import { decodeMatchedParams } from "./utils";

export type RoutePatternParams = Record<string, string | string[]>;

function routePatternPart(segment: string): string {
  if (segment.startsWith("[[...") && segment.endsWith("]]")) {
    return `:${segment.slice(5, -2)}*`;
  }
  if (segment.startsWith("[...") && segment.endsWith("]")) {
    return `:${segment.slice(4, -1)}+`;
  }
  if (segment.startsWith("[") && segment.endsWith("]")) {
    return `:${segment.slice(1, -1)}`;
  }
  return segment;
}

export function routePatternParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(routePatternPart);
}

export function routePattern(pathname: string): string {
  const parts = routePatternParts(pathname);
  return parts.length > 0 ? `/${parts.join("/")}` : "";
}

export function matchRoutePattern(
  urlParts: readonly string[],
  patternParts: readonly string[],
): RoutePatternParams | null {
  const params: RoutePatternParams = Object.create(null);

  function matchFrom(urlIndex: number, patternIndex: number): boolean {
    if (patternIndex === patternParts.length) {
      return urlIndex === urlParts.length;
    }

    const patternPart = patternParts[patternIndex];
    if (patternPart.startsWith(":") && (patternPart.endsWith("+") || patternPart.endsWith("*"))) {
      const paramName = patternPart.slice(1, -1);
      const minLength = patternPart.endsWith("+") ? 1 : 0;
      for (let endIndex = urlIndex + minLength; endIndex <= urlParts.length; endIndex += 1) {
        const value = urlParts.slice(urlIndex, endIndex);
        if (value.length > 0) {
          params[paramName] = value;
        } else {
          delete params[paramName];
        }
        if (matchFrom(endIndex, patternIndex + 1)) {
          return true;
        }
      }
      delete params[paramName];
      return false;
    }

    if (patternPart.startsWith(":")) {
      if (urlIndex >= urlParts.length) {
        return false;
      }
      const paramName = patternPart.slice(1);
      params[paramName] = urlParts[urlIndex];
      if (matchFrom(urlIndex + 1, patternIndex + 1)) {
        return true;
      }
      delete params[paramName];
      return false;
    }

    if (urlIndex >= urlParts.length || urlParts[urlIndex] !== patternPart) {
      return false;
    }
    return matchFrom(urlIndex + 1, patternIndex + 1);
  }

  if (!matchFrom(0, 0)) return null;
  decodeMatchedParams(params);
  return params;
}
