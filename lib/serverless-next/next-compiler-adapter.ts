import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import path from "node:path";

globalThis.AsyncLocalStorage ??= AsyncLocalStorage;

const requireNext = createRequire(path.join(process.cwd(), "package.json"));
const nextPackage = requireNext("next/package.json") as { version: string };
const PINNED_NEXT_VERSION = "16.2.6";

type NextTransformResult = {
  cacheHit: boolean;
  code: string;
  metadata: {
    actionIds: Record<string, string>;
    clientRefs: string[];
    rscType: "client" | "server";
  };
};

type TransformCacheEntry = Omit<NextTransformResult, "cacheHit">;

const transformCacheKey = Symbol.for("tuto.serverless-next.swc-cache.v1");
const maxTransformEntries = 512;

function transformCache() {
  const globals = globalThis as typeof globalThis & {
    [transformCacheKey]?: Map<string, TransformCacheEntry>;
  };
  globals[transformCacheKey] ??= new Map();
  return globals[transformCacheKey];
}

function rememberTransform(key: string, value: TransformCacheEntry) {
  const cache = transformCache();
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxTransformEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function parseActionMetadata(code: string) {
  const match =
    /\/\* __next_internal_action_entry_do_not_use__ (\{[^\n]+\}) \*\//.exec(
      code,
    );
  if (!match) return {};
  const metadata = JSON.parse(match[1]) as Record<
    string,
    string | { name?: string }
  >;
  return Object.fromEntries(
    Object.entries(metadata).map(([id, value]) => {
      const name = typeof value === "string" ? value : value.name;
      if (!name)
        throw new Error(`Next emitted an invalid action name for ${id}.`);
      return [id, name];
    }),
  );
}

function cacheKey(
  target: "browser" | "server",
  source: string,
  canonicalPath: string,
  actionSalt: string,
) {
  return createHash("sha256")
    .update(
      `${PINNED_NEXT_VERSION}\0rsc-cache-components-v3\0${target}\0${canonicalPath}\0${actionSalt}\0${source}`,
    )
    .digest("hex");
}

function nextInternals() {
  if (nextPackage.version !== PINNED_NEXT_VERSION) {
    throw new Error(
      `The request compiler is pinned to Next.js ${PINNED_NEXT_VERSION}, but ${nextPackage.version} is installed.`,
    );
  }
  const swc = requireNext("next/dist/build/swc") as {
    loadBindings(): Promise<unknown>;
    transform(
      source: string,
      options: Record<string, unknown>,
    ): Promise<{ code: string }>;
  };
  const { getLoaderSWCOptions } = requireNext(
    "next/dist/build/swc/options",
  ) as {
    getLoaderSWCOptions(
      options: Record<string, unknown>,
    ): Record<string, unknown>;
  };
  const { getRSCModuleInformation } = requireNext(
    "next/dist/build/analysis/get-page-static-info",
  ) as {
    getRSCModuleInformation(
      code: string,
      isReactServerLayer: boolean,
    ): { clientRefs?: string[]; type?: "client" | "server" };
  };
  const { WEBPACK_LAYERS } = requireNext("next/dist/lib/constants") as {
    WEBPACK_LAYERS: {
      appPagesBrowser: string;
      reactServerComponents: string;
    };
  };
  return { getLoaderSWCOptions, getRSCModuleInformation, swc, WEBPACK_LAYERS };
}

let bindingsPromise: Promise<unknown> | undefined;

async function loadBindings() {
  const { swc } = nextInternals();
  bindingsPromise ??= swc.loadBindings();
  await bindingsPromise;
}

function loaderOptions({
  actionSalt,
  canonicalPath,
  target,
}: {
  actionSalt: string;
  canonicalPath: string;
  target: "browser" | "server";
}) {
  const { getLoaderSWCOptions, WEBPACK_LAYERS } = nextInternals();
  const appDir = "/tuto/next/app";
  const pagesDir = "/tuto/next/pages";
  const isServer = target === "server";
  return getLoaderSWCOptions({
    appDir,
    bundleLayer: isServer
      ? WEBPACK_LAYERS.reactServerComponents
      : WEBPACK_LAYERS.appPagesBrowser,
    cacheHandlers: {},
    compilerOptions: {},
    development: false,
    esm: true,
    filename: canonicalPath,
    hasReactRefresh: false,
    isCacheComponents: true,
    isPageFile: /(?:^|\/)page\.[cm]?[jt]sx?$/.test(canonicalPath),
    isServer,
    jsConfig: { compilerOptions: {} },
    modularizeImports: undefined,
    optimizePackageImports: undefined,
    optimizeServerReact: false,
    pageExtensions: ["tsx", "ts", "jsx", "js"],
    pagesDir,
    relativeFilePathFromRoot: canonicalPath.replace(/^\/+/, ""),
    serverComponents: true,
    serverReferenceHashSalt: actionSalt,
    supportedBrowsers: [],
    swcCacheDir: undefined,
    swcPlugins: undefined,
    taintEnabled: false,
    trackDynamicImports: false,
    useCacheEnabled: true,
  });
}

async function lowerModulesToCommonJs(code: string, filename: string) {
  const { swc } = nextInternals();
  const result = await swc.transform(code, {
    filename,
    jsc: {
      parser: { jsx: false, syntax: "ecmascript" },
      target: "es2022",
    },
    module: { type: "commonjs" },
    sourceFileName: filename,
  });
  return result.code;
}

export async function transformNextModule({
  actionSalt,
  canonicalPath,
  source,
  target,
}: {
  actionSalt: string;
  canonicalPath: string;
  source: string;
  target: "browser" | "server";
}): Promise<NextTransformResult> {
  const key = cacheKey(target, source, canonicalPath, actionSalt);
  const cached = transformCache().get(key);
  if (cached) return { ...cached, cacheHit: true };

  await loadBindings();
  const { getRSCModuleInformation, swc } = nextInternals();
  const transformed = await swc.transform(source, {
    ...loaderOptions({ actionSalt, canonicalPath, target }),
    filename: canonicalPath,
    sourceFileName: canonicalPath,
  });
  const rsc = getRSCModuleInformation(transformed.code, target === "server");
  const isClientProxy = target === "server" && rsc.type === "client";
  const code = isClientProxy
    ? transformed.code
    : await lowerModulesToCommonJs(transformed.code, canonicalPath);
  const value: TransformCacheEntry = {
    code,
    metadata: {
      actionIds: parseActionMetadata(transformed.code),
      clientRefs: [...(rsc.clientRefs ?? [])],
      rscType: rsc.type ?? "server",
    },
  };
  rememberTransform(key, value);
  return { ...value, cacheHit: false };
}

export const NEXT_COMPILER_FINGERPRINT = `next-swc:${PINNED_NEXT_VERSION}:rsc-cache-components-v3`;
export const NEXT_COMPILER_VERSION = PINNED_NEXT_VERSION;

export function canonicalNextWorkspacePath(
  workspaceKey: string,
  filePath: string,
) {
  return path.posix.join("/tuto/workspaces", workspaceKey, filePath);
}

export function clearNextTransformCacheForTests() {
  transformCache().clear();
}
