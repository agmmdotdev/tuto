import { createRequire } from "node:module";
import path from "node:path";

const runtimeRequire = createRequire(path.join(process.cwd(), "package.json"));

type ProxyMatcher = {
  has?: unknown[];
  locale?: false;
  missing?: unknown[];
  originalSource: string;
  regexp: string;
};

export function compileNextProxyMatchers(config: unknown): ProxyMatcher[] | null {
  if (!config || typeof config !== "object" || !("matcher" in config)) {
    return null;
  }
  const matcher = (config as { matcher?: unknown }).matcher;
  if (matcher === undefined) return null;
  const { getMiddlewareMatchers } = runtimeRequire(
    "next/dist/build/analysis/get-page-static-info",
  ) as {
    getMiddlewareMatchers(
      matcher: unknown,
      nextConfig: Record<string, never>,
    ): ProxyMatcher[];
  };
  return getMiddlewareMatchers(matcher, {});
}

