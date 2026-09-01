import type { TanstackStartIsrDocument } from "./artifact-cache";

function parseCacheSeconds(value: string | undefined) {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function createTanstackStartIsrDocument(options: {
  cacheControl: string | null;
  generatedAt?: number;
  maxRedirects: number;
  requestHeaders: Record<string, string>;
  routePath: string;
  staticServerFunctionPaths?: string[];
}): TanstackStartIsrDocument | null {
  if (!options.cacheControl) return null;
  const directives = new Map<string, string | undefined>();
  for (const directive of options.cacheControl.split(",")) {
    const [rawName, ...rawValue] = directive.trim().split("=");
    if (!rawName) continue;
    directives.set(
      rawName.toLowerCase(),
      rawValue.length > 0
        ? rawValue.join("=").trim().replace(/^\"|\"$/g, "")
        : undefined,
    );
  }
  if (directives.has("private") || directives.has("no-store")) return null;
  const parsedRevalidateSeconds = parseCacheSeconds(
    directives.get("s-maxage") ?? directives.get("max-age"),
  );
  if (parsedRevalidateSeconds === null) return null;
  const revalidateSeconds = directives.has("no-cache")
    ? 0
    : parsedRevalidateSeconds;
  const staleWhileRevalidateSeconds =
    parseCacheSeconds(directives.get("stale-while-revalidate")) ?? 0;
  return {
    cacheControl: options.cacheControl,
    generatedAt: options.generatedAt ?? Date.now(),
    maxRedirects: options.maxRedirects,
    requestHeaders: options.requestHeaders,
    revalidateSeconds,
    routePath: options.routePath,
    staticServerFunctionPaths: [...(options.staticServerFunctionPaths ?? [])].sort(),
    staleWhileRevalidateSeconds,
  };
}
