// Vendored from Cloudflare Vinext, MIT License.
// Source: opensrc/repos/github.com/cloudflare/vinext/packages/vinext/src/routing/route-matching.ts

import { normalizePathnameForRouteMatch } from "./utils";
import { buildRouteTrie, trieMatch, type TrieNode } from "./route-trie";

type RouteTrieCache<R extends { patternParts: string[] }> = WeakMap<R[], TrieNode<R>>;

export function createRouteTrieCache<R extends { patternParts: string[] }>(): RouteTrieCache<R> {
  return new WeakMap<R[], TrieNode<R>>();
}

function getOrBuildTrie<R extends { patternParts: string[] }>(
  cache: RouteTrieCache<R>,
  routes: R[],
): TrieNode<R> {
  let trie = cache.get(routes);
  if (!trie) {
    trie = buildRouteTrie(routes);
    cache.set(routes, trie);
  }
  return trie;
}

export function matchRouteWithTrie<R extends { patternParts: string[] }>(
  url: string,
  routes: R[],
  cache: RouteTrieCache<R>,
): { route: R; params: Record<string, string | string[]> } | null {
  const pathname = url.split("?")[0];
  let normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\/$/, "");
  normalizedUrl = normalizePathnameForRouteMatch(normalizedUrl);

  const urlParts = normalizedUrl.split("/").filter(Boolean);
  const trie = getOrBuildTrie(cache, routes);
  return trieMatch(trie, urlParts);
}
