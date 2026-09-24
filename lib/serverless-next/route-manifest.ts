import path from "node:path";
import type {
  NextInterceptionDefinition,
  NextParallelRouteDefinition,
  NextRouteDefinition,
  NextRouteHandlerDefinition,
  NextRouteManifest,
  NextRouteMatcher,
  NextRouteParam,
} from "./artifact";

const sourceExtensions = [".tsx", ".ts", ".jsx", ".js"] as const;
const interceptionMarkers = ["(..)(..)", "(.)", "(..)", "(...)"] as const;
type RouteFileName =
  | "default"
  | "error"
  | "global-error"
  | "layout"
  | "loading"
  | "not-found"
  | "page"
  | "route"
  | "template";

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

function interceptionMarker(segment: string) {
  return interceptionMarkers.find((marker) => segment.startsWith(marker));
}

function publicSegment(
  segment: string,
):
  | { kind: "static"; value: string }
  | { kind: NextRouteParam["kind"]; name: string }
  | null {
  if (isRouteGroup(segment) || segment.startsWith("@")) return null;
  if (interceptionMarker(segment)) {
    throw new Error(`An interception marker must be normalized first: ${segment}`);
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

function publicSegments(segments: string[]) {
  return segments
    .map(publicSegment)
    .filter((segment) => segment !== null);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matcherFor(directorySegments: string[]): {
  matcher: NextRouteMatcher;
  pattern: string;
} {
  const params: NextRouteParam[] = [];
  const patternSegments: string[] = [];
  let source = "^";
  const segments = publicSegments(directorySegments);
  segments.forEach((segment, index) => {
    if (segment.kind === "static") {
      source += `/${escapeRegExp(segment.value)}`;
      patternSegments.push(segment.value);
      return;
    }
    if (
      (segment.kind === "catchall" || segment.kind === "optional-catchall") &&
      index !== segments.length - 1
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
  source += "/?$";
  return {
    matcher: { params, source },
    pattern: patternSegments.length > 0 ? `/${patternSegments.join("/")}` : "/",
  };
}

function appSegments(directory: string) {
  return directory === "app" ? [] : directory.slice(4).split("/");
}

function ancestors(directory: string) {
  const segments = appSegments(directory);
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

function compareRoutes(
  left: Pick<NextRouteDefinition, "pattern">,
  right: Pick<NextRouteDefinition, "pattern">,
) {
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

function routeDefinition(
  paths: Set<string>,
  page: string,
  options: { minimumDirectory?: string; routeSegments?: string[] } = {},
): NextRouteDefinition {
  const directory = path.posix.dirname(page);
  const boundaryDirectories = ancestors(directory);
  const directories = boundaryDirectories.filter(
    (entry) =>
      !options.minimumDirectory ||
      entry === options.minimumDirectory ||
      entry.startsWith(`${options.minimumDirectory}/`),
  );
  const { matcher, pattern } = matcherFor(
    options.routeSegments ?? appSegments(directory),
  );
  const nearest = (
    basename: "error" | "loading" | "not-found",
    candidates = directories,
  ) =>
    [...candidates]
      .reverse()
      .map((entry) => routeFile(paths, entry, basename))
      .find(Boolean);
  return {
    boundaries: boundaryDirectories
      .map((entry) => ({
        directory: entry,
        ...(routeFile(paths, entry, "error")
          ? { error: routeFile(paths, entry, "error") }
          : {}),
        ...(routeFile(paths, entry, "loading")
          ? { loading: routeFile(paths, entry, "loading") }
          : {}),
        ...(routeFile(paths, entry, "not-found")
          ? { notFound: routeFile(paths, entry, "not-found") }
          : {}),
      }))
      .filter(
        (boundary) => boundary.error || boundary.loading || boundary.notFound,
      ),
    ...(nearest("error", boundaryDirectories)
      ? { error: nearest("error", boundaryDirectories) }
      : {}),
    layouts: directories
      .map((entry) => routeFile(paths, entry, "layout"))
      .filter((entry): entry is string => Boolean(entry)),
    ...(nearest("loading") ? { loading: nearest("loading") } : {}),
    matcher,
    ...(nearest("not-found") ? { notFound: nearest("not-found") } : {}),
    page,
    pattern,
    templates: directories
      .map((entry) => routeFile(paths, entry, "template"))
      .filter((entry): entry is string => Boolean(entry)),
  };
}

function slotInformation(modulePath: string) {
  const segments = appSegments(path.posix.dirname(modulePath));
  const slotIndexes = segments
    .map((segment, index) => (segment.startsWith("@") ? index : -1))
    .filter((index) => index >= 0);
  if (slotIndexes.length > 1) {
    throw new Error(
      `Nested parallel route slots are not supported yet: ${modulePath}`,
    );
  }
  const slotIndex = slotIndexes[0];
  if (slotIndex === undefined) return null;
  const name = segments[slotIndex].slice(1);
  if (!name || name === "children" || name === "params") {
    throw new Error(`Invalid parallel route slot @${name}: ${modulePath}`);
  }
  return {
    name,
    ownerDirectory: path.posix.join("app", ...segments.slice(0, slotIndex)),
    slotDirectory: path.posix.join("app", ...segments.slice(0, slotIndex + 1)),
  };
}

function interceptionInformation(modulePath: string) {
  const segments = appSegments(path.posix.dirname(modulePath));
  const markerIndex = segments.findIndex((segment) => interceptionMarker(segment));
  if (markerIndex < 0) return null;
  if (segments.slice(markerIndex + 1).some((segment) => interceptionMarker(segment))) {
    throw new Error(`A route can contain only one interception marker: ${modulePath}`);
  }
  const slot = slotInformation(modulePath);
  const slotIndex = segments.findIndex((segment) => segment === `@${slot?.name}`);
  if (!slot || markerIndex <= slotIndex) {
    throw new Error(
      `Tuto currently supports interception routes only inside a named parallel slot: ${modulePath}`,
    );
  }
  const markedSegment = segments[markerIndex];
  const marker = interceptionMarker(markedSegment)!;
  const interceptedFirstSegment = markedSegment.slice(marker.length);
  if (!interceptedFirstSegment) {
    throw new Error(`Invalid interception route segment ${markedSegment}.`);
  }
  const interceptingSegments = segments
    .slice(0, markerIndex)
    .filter((segment) => !segment.startsWith("@") && !isRouteGroup(segment));
  const retained =
    marker === "(.)"
      ? interceptingSegments
      : marker === "(...)"
        ? []
        : interceptingSegments.slice(0, marker === "(..)" ? -1 : -2);
  if (marker === "(..)" && interceptingSegments.length < 1) {
    throw new Error(`Invalid interception depth in ${modulePath}.`);
  }
  if (marker === "(..)(..)" && interceptingSegments.length < 2) {
    throw new Error(`Invalid interception depth in ${modulePath}.`);
  }
  const interceptedSegments = [
    ...retained,
    interceptedFirstSegment,
    ...segments.slice(markerIndex + 1),
  ];
  return {
    ...slot,
    intercepted: matcherFor(interceptedSegments),
    intercepting: matcherFor(interceptingSegments),
    routeSegments: interceptedSegments,
  };
}

function assertUniquePatterns(
  routes: Array<Pick<NextRouteDefinition, "page" | "pattern">>,
  label = "Routes",
) {
  const patterns = new Map<string, string>();
  for (const route of routes) {
    const existing = patterns.get(route.pattern);
    if (existing) {
      throw new Error(
        `${label} ${existing} and ${route.page} resolve to the same URL pattern ${route.pattern}.`,
      );
    }
    patterns.set(route.pattern, route.page);
  }
}

export function buildNextRouteManifest(
  modulePaths: Iterable<string>,
): NextRouteManifest {
  const paths = new Set(modulePaths);
  const pagePaths = [...paths].filter((modulePath) =>
    sourceExtensions.some((extension) => modulePath.endsWith(`/page${extension}`)),
  );
  const defaultPaths = [...paths].filter((modulePath) =>
    sourceExtensions.some((extension) =>
      modulePath.endsWith(`/default${extension}`),
    ),
  );
  const handlerPaths = [...paths].filter((modulePath) =>
    sourceExtensions.some((extension) => modulePath.endsWith(`/route${extension}`)),
  );
  const proxyPaths = ["proxy", "middleware", "src/proxy", "src/middleware"]
    .flatMap((basename) =>
      sourceExtensions.map((extension) => `${basename}${extension}`),
    )
    .filter((modulePath) => paths.has(modulePath));
  if (proxyPaths.length > 1) {
    throw new Error(
      `The Next workspace can define only one proxy.ts or middleware.ts entry: ${proxyPaths.join(", ")}.`,
    );
  }

  const routes: NextRouteDefinition[] = [];
  const slotMap = new Map<string, NextParallelRouteDefinition>();
  const interceptions: NextInterceptionDefinition[] = [];
  for (const defaultPage of defaultPaths) {
    const slot = slotInformation(defaultPage);
    if (!slot) {
      throw new Error(
        `A default component must belong to a named parallel route slot: ${defaultPage}`,
      );
    }
    slotMap.set(slot.slotDirectory, {
      ...slot,
      default: routeDefinition(paths, defaultPage, {
        minimumDirectory: slot.slotDirectory,
      }),
      routes: [],
    });
  }
  for (const page of pagePaths) {
    const interception = interceptionInformation(page);
    const slot = slotInformation(page);
    if (!slot) {
      routes.push(routeDefinition(paths, page));
      continue;
    }
    let parallelRoute = slotMap.get(slot.slotDirectory);
    if (!parallelRoute) {
      parallelRoute = {
        ...slot,
        routes: [],
      };
      slotMap.set(slot.slotDirectory, parallelRoute);
    }
    if (interception) {
      const route = routeDefinition(paths, page, {
        minimumDirectory: slot.slotDirectory,
        routeSegments: interception.routeSegments,
      });
      interceptions.push({
        interceptedMatcher: interception.intercepted.matcher,
        interceptedPattern: interception.intercepted.pattern,
        interceptingMatcher: interception.intercepting.matcher,
        interceptingPattern: interception.intercepting.pattern,
        ownerDirectory: slot.ownerDirectory,
        route,
        slotDirectory: slot.slotDirectory,
        slotName: slot.name,
      });
    } else {
      parallelRoute.routes.push(
        routeDefinition(paths, page, { minimumDirectory: slot.slotDirectory }),
      );
    }
  }

  const parallelRoutes = [...slotMap.values()];
  for (const slot of parallelRoutes) {
    if (!routeFile(paths, slot.ownerDirectory, "layout")) {
      throw new Error(
        `Parallel route @${slot.name} requires a layout in ${slot.ownerDirectory}.`,
      );
    }
    assertUniquePatterns(slot.routes, `Parallel route @${slot.name}`);
    slot.routes.sort(compareRoutes);
  }

  const handlers = handlerPaths.map((handler): NextRouteHandlerDefinition => {
    if (slotInformation(handler) || interceptionInformation(handler)) {
      throw new Error(
        `Route Handlers cannot be declared inside a parallel or intercepted route: ${handler}`,
      );
    }
    const directory = path.posix.dirname(handler);
    const { matcher, pattern } = matcherFor(appSegments(directory));
    return { handler, matcher, pattern };
  });

  if (routes.length === 0 && handlers.length === 0) {
    throw new Error(
      "The Next workspace requires at least one canonical app/**/page or app/**/route file.",
    );
  }
  assertUniquePatterns(routes);
  const patterns = new Map(routes.map((route) => [route.pattern, route.page]));
  for (const route of handlers) {
    const existing = patterns.get(route.pattern);
    if (existing) {
      throw new Error(
        `Routes ${existing} and ${route.handler} resolve to the same URL pattern ${route.pattern}.`,
      );
    }
    patterns.set(route.pattern, route.handler);
  }
  const interceptionKeys = new Set<string>();
  for (const interception of interceptions) {
    const key = `${interception.interceptingPattern}\0${interception.interceptedPattern}\0${interception.slotDirectory}`;
    if (interceptionKeys.has(key)) {
      throw new Error(
        `Duplicate interception from ${interception.interceptingPattern} to ${interception.interceptedPattern} in @${interception.slotName}.`,
      );
    }
    interceptionKeys.add(key);
  }
  routes.sort(compareRoutes);
  handlers.sort(compareRoutes);
  parallelRoutes.sort((left, right) =>
    left.slotDirectory.localeCompare(right.slotDirectory),
  );
  interceptions.sort((left, right) =>
    left.interceptedPattern.localeCompare(right.interceptedPattern),
  );

  return {
    handlers,
    interceptions,
    parallelRoutes,
    ...(proxyPaths[0]
      ? {
          proxy: {
            kind: proxyPaths[0].includes("middleware")
              ? ("middleware" as const)
              : ("proxy" as const),
            modulePath: proxyPaths[0],
          },
        }
      : {}),
    ...(routeFile(paths, "app", "global-error")
      ? { rootGlobalError: routeFile(paths, "app", "global-error") }
      : {}),
    ...(routeFile(paths, "app", "layout")
      ? { rootLayout: routeFile(paths, "app", "layout") }
      : {}),
    ...(routeFile(paths, "app", "not-found")
      ? { rootNotFound: routeFile(paths, "app", "not-found") }
      : {}),
    routes,
  };
}

function matchDefinitions<
  T extends { matcher: NextRouteMatcher; pattern: string },
>(definitions: T[], url: URL) {
  for (const route of definitions) {
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

export function matchNextRoute(manifest: NextRouteManifest, url: URL) {
  return matchDefinitions(manifest.routes, url);
}

export function matchNextRouteHandler(manifest: NextRouteManifest, url: URL) {
  return matchDefinitions(manifest.handlers, url);
}

export function nextSearchParams(url: URL) {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
}
