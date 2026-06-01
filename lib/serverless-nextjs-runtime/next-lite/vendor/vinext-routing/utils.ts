// Vendored from Cloudflare Vinext, MIT License.
// Source: opensrc/repos/github.com/cloudflare/vinext/packages/vinext/src/routing/utils.ts

function routePrecedence(pattern: string): number {
  const parts = pattern.split("/").filter(Boolean);
  let score = 0;

  let staticPrefixCount = 0;
  for (const part of parts) {
    if (part.startsWith(":") || part.endsWith("+") || part.endsWith("*")) break;
    staticPrefixCount += 1;
  }

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.endsWith("+")) {
      score += 1000 + index;
    } else if (part.endsWith("*")) {
      score += 2000 + index;
    } else if (part.startsWith(":")) {
      score += 100 + index;
    } else if (index >= staticPrefixCount) {
      score -= 500;
    }
  }

  const isDynamic = parts.some(
    (part) => part.startsWith(":") || part.endsWith("+") || part.endsWith("*"),
  );
  if (isDynamic && staticPrefixCount > 0) {
    score -= staticPrefixCount * 50;
  }

  return score;
}

export function compareRoutes<T extends { pattern: string }>(a: T, b: T): number {
  const diff = routePrecedence(a.pattern) - routePrecedence(b.pattern);
  return diff !== 0 ? diff : a.pattern.localeCompare(b.pattern);
}

const pathDelimiterRegex = /([/#?\\]|%(2f|23|3f|5c))/gi;

function encodePathDelimiters(segment: string): string {
  return segment.replace(pathDelimiterRegex, (char) => encodeURIComponent(char));
}

export function decodeRouteSegment(segment: string): string {
  try {
    return encodePathDelimiters(decodeURIComponent(segment));
  } catch {
    return segment;
  }
}

export function normalizePathnameForRouteMatch(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => decodeRouteSegment(segment))
    .join("/");
}

function decodeMatchedParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildParams(
  entries: Array<[string, string | string[]]>,
): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = Object.create(null);
  for (const [key, value] of entries) {
    params[key] = value;
  }
  return params;
}

export function decodeMatchedParams(params: Record<string, string | string[]>): void {
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (Array.isArray(value)) {
      params[key] = value.map(decodeMatchedParam);
    } else {
      params[key] = decodeMatchedParam(value);
    }
  }
}
