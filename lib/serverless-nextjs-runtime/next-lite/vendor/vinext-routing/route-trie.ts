// Vendored from Cloudflare Vinext, MIT License.
// Source: opensrc/repos/github.com/cloudflare/vinext/packages/vinext/src/routing/route-trie.ts

import { buildParams, decodeMatchedParams } from "./utils";

export type TrieNode<R> = {
  staticChildren: Map<string, TrieNode<R>>;
  dynamicChild: { paramName: string; node: TrieNode<R> } | null;
  catchAllChild: { paramName: string; route: R } | null;
  optionalCatchAllChild: { paramName: string; route: R } | null;
  route: R | null;
};

function createNode<R>(): TrieNode<R> {
  return {
    staticChildren: new Map(),
    dynamicChild: null,
    catchAllChild: null,
    optionalCatchAllChild: null,
    route: null,
  };
}

export function buildRouteTrie<R extends { patternParts: string[] }>(routes: R[]): TrieNode<R> {
  const root = createNode<R>();

  for (const route of routes) {
    const parts = route.patternParts;

    if (parts.length === 0) {
      if (root.route === null) {
        root.route = route;
      }
      continue;
    }

    let node = root;

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];

      if (part.endsWith("+") && part.startsWith(":")) {
        if (index !== parts.length - 1) break;
        const paramName = part.slice(1, -1);
        if (node.catchAllChild === null) {
          node.catchAllChild = { paramName, route };
        }
        break;
      }

      if (part.endsWith("*") && part.startsWith(":")) {
        if (index !== parts.length - 1) break;
        const paramName = part.slice(1, -1);
        if (node.optionalCatchAllChild === null) {
          node.optionalCatchAllChild = { paramName, route };
        }
        break;
      }

      if (part.startsWith(":")) {
        const paramName = part.slice(1);
        if (node.dynamicChild === null) {
          node.dynamicChild = { paramName, node: createNode<R>() };
        }
        node = node.dynamicChild.node;

        if (index === parts.length - 1 && node.route === null) {
          node.route = route;
        }
        continue;
      }

      let child = node.staticChildren.get(part);
      if (!child) {
        child = createNode<R>();
        node.staticChildren.set(part, child);
      }
      node = child;

      if (index === parts.length - 1 && node.route === null) {
        node.route = route;
      }
    }
  }

  return root;
}

export function trieMatch<R>(
  root: TrieNode<R>,
  urlParts: string[],
): { route: R; params: Record<string, string | string[]> } | null {
  const result = match(root, urlParts, 0, []);
  if (result) {
    decodeMatchedParams(result.params);
  }
  return result;
}

function match<R>(
  node: TrieNode<R>,
  urlParts: string[],
  index: number,
  entries: Array<[string, string | string[]]>,
): { route: R; params: Record<string, string | string[]> } | null {
  if (index === urlParts.length) {
    if (node.route !== null) {
      return { route: node.route, params: buildParams(entries) };
    }

    if (node.optionalCatchAllChild !== null) {
      return {
        route: node.optionalCatchAllChild.route,
        params: buildParams(entries),
      };
    }

    return null;
  }

  const segment = urlParts[index];

  const staticChild = node.staticChildren.get(segment);
  if (staticChild) {
    const result = match(staticChild, urlParts, index + 1, entries);
    if (result !== null) {
      return result;
    }
  }

  if (node.dynamicChild !== null) {
    entries.push([node.dynamicChild.paramName, segment]);
    const result = match(node.dynamicChild.node, urlParts, index + 1, entries);
    if (result !== null) {
      return result;
    }
    entries.pop();
  }

  if (node.catchAllChild !== null) {
    const params = buildParams(entries);
    params[node.catchAllChild.paramName] = urlParts.slice(index);
    return { route: node.catchAllChild.route, params };
  }

  if (node.optionalCatchAllChild !== null) {
    const params = buildParams(entries);
    params[node.optionalCatchAllChild.paramName] = urlParts.slice(index);
    return { route: node.optionalCatchAllChild.route, params };
  }

  return null;
}
