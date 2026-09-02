import path from "node:path";
import type {
  NextRouteDefinition,
  NextRouteManifest,
  NextRouteParam,
} from "./artifact";

const sourceExtensions = [".tsx", ".ts", ".jsx", ".js"] as const;
type RouteFileName = "error" | "layout" | "loading" | "not-found" | "page";

function routeFile(
  paths: Set<string>,
  directory: string,
  basename: RouteFileName,
) {
  for (const extension of sourceExtensions) {
    const candidate = path.posix.join(directory, `${basename}${extension}`);
    if (paths.has(candidate)) return candidate;
  }
  return undefined;
}

function isRouteGroup(segment: string) {
  return /^\([^.)][^/]*\)$/.test(segment);
}

function publicSegment(
  segment: string,
):
  | { kind: "static"; value: string }
  | { kind: NextRouteParam["kind"]; name: string }
  | null {
  if (isRouteGroup(segment)) return null;
  if (segment.startsWith("@") || /^\((?:\.{1,3})/.test(segment)) {
    throw new Error(
      `Parallel and intercepted route segments are not supported yet: ${segment}`,
    );
  }
  const optionalCatchall = /^\[\[\.\.\.([^/\]]+)\]\]$/.exec(segment);
  if (optionalCatchall)
    return { kind: "optional-catchall", name: optionalCatchall[1] };
  const catchall = /^\[\.\.\.([^/\]]+)\]$/.exec(segment);
  if (catchall) return { kind: "catchall", name: catchall[1] };
  const dynamic = /^\[([^/\]]+)\]$/.exec(segment);
  if (dynamic) return { kind: "dynamic", name: dynamic[1] };
  if (segment.includes("[") || segment.includes("]")) {
    throw new Error(`Unsupported dynamic route segment: ${segment}`);
  }
  return { kind: "static", value: segment };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matcherFor(directorySegments: string[]) {
  const params: NextRouteParam[] = [];
  const patternSegments: string[] = [];
  let source = "^";
  const publicSegments = directorySegments
    .map(publicSegment)
    .filter((segment) => segment !== null);
  publicSegments.forEach((segment, index) => {
    if (segment.kind === "static") {
      source += `/${escapeRegExp(segment.value)}`;
      patternSegments.push(segment.value);
      return;
    }
    if (
      (segment.kind === "catchall" || segment.kind === "optional-catchall") &&
      index !== publicSegments.length - 1
    ) {
      throw new Error(`Catch-all route segments must be last: ${segment.name}`);
    }
    params.push(segment);
    if (segment.kind === "dynamic") {
      source += "/([^/]+)";
      patternSegments.push(`[${segment.name}]`);
    } else if (segment.kind === "catchall") {
      source += "/(.+)";
      patternSegments.push(`[...${segment.name}]`);
    } else {
      source += "(?:/(.*))?";
      patternSegments.push(`[[...${segment.name}]]`);
    }
  });
  source += publicSegments.length === 0 ? "/?$" : "/?$";
  return {
    matcher: { params, source },
    pattern: patternSegments.length > 0 ? `/${patternSegments.join("/")}` : "/",
  };
}

function ancestors(directory: string) {
  const segments = directory === "app" ? [] : directory.slice(4).split("/");
  return Array.from({ length: segments.length + 1 }, (_, index) =>
    path.posix.join("app", ...segments.slice(0, index)),
  );
}

function segmentRank(segment: string) {
  if (segment.startsWith("[[...")) return 1;
  if (segment.startsWith("[...")) return 2;
  if (segment.startsWith("[")) return 3;
  return 4;
}

function compareRoutes(left: NextRouteDefinition, right: NextRouteDefinition) {
  const leftSegments = left.pattern.split("/").filter(Boolean);
  const rightSegments = right.pattern.split("/").filter(Boolean);
  for (
    let index = 0;
    index < Math.max(leftSegments.length, rightSegments.length);
    index += 1
  ) {
    const rankDifference =
      segmentRank(rightSegments[index] ?? "[[...missing]]") -
      segmentRank(leftSegments[index] ?? "[[...missing]]");
    if (rankDifference !== 0) return rankDifference;
  }
  return (
    rightSegments.length - leftSegments.length ||
    left.pattern.localeCompare(right.pattern)
  );
}

export function buildNextRouteManifest(
  modulePaths: Iterable<string>,
): NextRouteManifest {
  const paths = new Set(modulePaths);
  const pagePaths = [...paths].filter((modulePath) =>
    sourceExtensions.some((extension) =>
      modulePath.endsWith(`/page${extension}`),
    ),
  );
  if (pagePaths.length === 0) {
    throw new Error(
      "The Next workspace requires at least one app/**/page file.",
    );
  }

  const routes = pagePaths.map((page): NextRouteDefinition => {
    const directory = path.posix.dirname(page);
    const directories = ancestors(directory);
    const { matcher, pattern } = matcherFor(
      directory === "app" ? [] : directory.slice(4).split("/"),
    );
    const nearest = (basename: "error" | "loading" | "not-found") =>
      [...directories]
        .reverse()
        .map((entry) => routeFile(paths, entry, basename))
        .find(Boolean);
    return {
      ...(nearest("error") ? { error: nearest("error") } : {}),
      layouts: directories
        .map((entry) => routeFile(paths, entry, "layout"))
        .filter((entry): entry is string => Boolean(entry)),
      ...(nearest("loading") ? { loading: nearest("loading") } : {}),
      matcher,
      ...(nearest("not-found") ? { notFound: nearest("not-found") } : {}),
      page,
      pattern,
    };
  });

  const patterns = new Map<string, string>();
  for (const route of routes) {
    const existing = patterns.get(route.pattern);
    if (existing) {
      throw new Error(
        `Routes ${existing} and ${route.page} resolve to the same URL pattern ${route.pattern}.`,
      );
    }
    patterns.set(route.pattern, route.page);
  }
  routes.sort(compareRoutes);

  return {
    ...(routeFile(paths, "app", "layout")
      ? { rootLayout: routeFile(paths, "app", "layout") }
      : {}),
    ...(routeFile(paths, "app", "not-found")
      ? { rootNotFound: routeFile(paths, "app", "not-found") }
      : {}),
    routes,
  };
}

export function matchNextRoute(manifest: NextRouteManifest, url: URL) {
  for (const route of manifest.routes) {
    const match = new RegExp(route.matcher.source).exec(url.pathname);
    if (!match) continue;
    const params: Record<string, string | string[] | undefined> = {};
    route.matcher.params.forEach((param, index) => {
      const value = match[index + 1];
      params[param.name] =
        value === undefined || value === ""
          ? undefined
          : param.kind === "dynamic"
            ? decodeURIComponent(value)
            : value.split("/").map(decodeURIComponent);
    });
    return { params, route };
  }
  return null;
}

export function nextSearchParams(url: URL) {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
}
