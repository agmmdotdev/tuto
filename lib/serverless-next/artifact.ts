import { createHash } from "node:crypto";
import type { WorkspaceFile } from "@/lib/ide/types";

export const NEXT_REQUEST_ARTIFACT_VERSION = 10 as const;

export type NextCompiledModule = {
  canonicalPath: string;
  code: string;
  dependencies: string[];
  hash: string;
  path: string;
};

export type NextClientModule = NextCompiledModule & {
  id: string;
};

export type NextClientReference = {
  async: boolean;
  chunks: string[];
  id: string;
  name: string;
};

export type NextCompiledStyle = {
  css: string;
  exports: Record<string, string>;
  hash: string;
  kind: "global" | "module";
  path: string;
};

export type NextStaticAsset = {
  bodyBase64: string;
  contentType: string;
  etag: string;
  hash: string;
  path: string;
};

export type NextServerActionReference = {
  exportName: string;
  kind: "action" | "cache";
  modulePath: string;
};

export type NextRouteParam = {
  kind: "catchall" | "dynamic" | "optional-catchall";
  name: string;
};

export type NextRouteMatcher = {
  params: NextRouteParam[];
  source: string;
};

export type NextRouteDefinition = {
  boundaries: Array<{
    directory: string;
    error?: string;
    loading?: string;
    notFound?: string;
  }>;
  error?: string;
  layouts: string[];
  loading?: string;
  matcher: NextRouteMatcher;
  notFound?: string;
  page: string;
  pattern: string;
  templates: string[];
};

export type NextParallelRouteDefinition = {
  default?: NextRouteDefinition;
  name: string;
  ownerDirectory: string;
  routes: NextRouteDefinition[];
  slotDirectory: string;
};

export type NextInterceptionDefinition = {
  interceptedMatcher: NextRouteMatcher;
  interceptedPattern: string;
  interceptingMatcher: NextRouteMatcher;
  interceptingPattern: string;
  ownerDirectory: string;
  route: NextRouteDefinition;
  slotDirectory: string;
  slotName: string;
};

export type NextRouteHandlerDefinition = {
  handler: string;
  matcher: NextRouteMatcher;
  pattern: string;
};

export type NextProxyDefinition = {
  kind: "middleware" | "proxy";
  modulePath: string;
};

export type NextRouteManifest = {
  handlers: NextRouteHandlerDefinition[];
  interceptions: NextInterceptionDefinition[];
  parallelRoutes: NextParallelRouteDefinition[];
  proxy?: NextProxyDefinition;
  rootGlobalError?: string;
  rootLayout?: string;
  rootNotFound?: string;
  routes: NextRouteDefinition[];
};

export type NextRequestArtifact = {
  actionEncryptionKey: string;
  actionManifest: Record<string, NextServerActionReference>;
  buildMetrics: {
    browserTransformCacheHits: number;
    browserTransforms: number;
    durationMs: number;
    serverTransformCacheHits: number;
    serverTransforms: number;
  };
  clientBundle: {
    code: string;
    entryIds: string[];
    hash: string;
  };
  clientModules: Record<string, NextClientModule>;
  clientReferenceManifest: Record<string, NextClientReference>;
  generation: string;
  kernelId: string;
  nextVersion: string;
  revision: string;
  router: NextRouteManifest;
  serverModules: Record<string, NextCompiledModule>;
  staticAssets: Record<string, NextStaticAsset>;
  styles: Record<string, NextCompiledStyle>;
  version: typeof NEXT_REQUEST_ARTIFACT_VERSION;
  workspaceKey: string;
};

export type NextArtifactDiff = {
  actionManifestChanged: boolean;
  clientBundleChanged: boolean;
  clientManifestChanged: boolean;
  changedClientModules: string[];
  changedServerModules: string[];
  removedClientModules: string[];
  removedServerModules: string[];
  removedStaticAssets: string[];
  removedStyles: string[];
  routeManifestChanged: boolean;
  staticAssetsChanged: string[];
  stylesChanged: string[];
};

const artifactCacheKey = Symbol.for("tuto.serverless-next.artifacts.v1");
const maxArtifacts = 32;

function artifactCache() {
  const globals = globalThis as typeof globalThis & {
    [artifactCacheKey]?: Map<string, NextRequestArtifact>;
  };
  globals[artifactCacheKey] ??= new Map();
  return globals[artifactCacheKey];
}

export function createNextWorkspaceRevision(
  files: WorkspaceFile[],
  workspaceKey: string,
  compilerFingerprint: string,
) {
  const hash = createHash("sha256");
  hash.update(`${NEXT_REQUEST_ARTIFACT_VERSION}\0${compilerFingerprint}\0`);
  hash.update(workspaceKey);
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    hash.update("\0");
    hash.update(file.path.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(file.language);
    hash.update("\0");
    hash.update(file.content);
  }
  return hash.digest("hex");
}

export function putNextRequestArtifact(artifact: NextRequestArtifact) {
  const cache = artifactCache();
  cache.delete(artifact.revision);
  cache.set(artifact.revision, artifact);
  while (cache.size > maxArtifacts) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function getNextRequestArtifact(revision: string) {
  const cache = artifactCache();
  const artifact = cache.get(revision);
  if (!artifact) return null;
  cache.delete(revision);
  cache.set(revision, artifact);
  return artifact;
}

export function diffNextRequestArtifacts(
  before: NextRequestArtifact,
  after: NextRequestArtifact,
): NextArtifactDiff {
  const changed = <T extends { hash: string }>(
    previous: Record<string, T>,
    next: Record<string, T>,
  ) =>
    Object.keys(next)
      .filter((path) => previous[path]?.hash !== next[path]?.hash)
      .sort();
  const removed = <T>(previous: Record<string, T>, next: Record<string, T>) =>
    Object.keys(previous)
      .filter((path) => !(path in next))
      .sort();

  return {
    actionManifestChanged:
      JSON.stringify(before.actionManifest) !==
      JSON.stringify(after.actionManifest),
    clientBundleChanged: before.clientBundle.hash !== after.clientBundle.hash,
    clientManifestChanged:
      JSON.stringify(before.clientReferenceManifest) !==
      JSON.stringify(after.clientReferenceManifest),
    changedClientModules: changed(before.clientModules, after.clientModules),
    changedServerModules: changed(before.serverModules, after.serverModules),
    removedClientModules: removed(before.clientModules, after.clientModules),
    removedServerModules: removed(before.serverModules, after.serverModules),
    removedStaticAssets: removed(before.staticAssets, after.staticAssets),
    removedStyles: removed(before.styles, after.styles),
    routeManifestChanged:
      JSON.stringify(before.router) !== JSON.stringify(after.router),
    staticAssetsChanged: changed(before.staticAssets, after.staticAssets),
    stylesChanged: changed(before.styles, after.styles),
  };
}

export function clearNextRequestArtifactsForTests() {
  artifactCache().clear();
}
