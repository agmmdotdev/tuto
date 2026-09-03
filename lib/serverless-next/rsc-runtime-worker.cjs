/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const path = require("node:path");
require("./secure-node-compat.cjs");
const React = require("react");
// Next's Cache Components wrapper imports the package-level RSC renderer.
// The outer render must use that same renderer instance; React rejects two
// concurrent server renderers even when their versions are identical.
const rsc = require("react-server-dom-webpack/server.node");
const rscClient = require("react-server-dom-webpack/client.node");
const runtimeClient = rsc.createClientModuleProxy("tuto-next-runtime");
const { NextRequest } = require("next/server");
const {
  autoImplementMethods,
} = require("next/dist/server/route-modules/app-route/helpers/auto-implement-methods");
const {
  appendMutableCookies,
} = require("next/dist/server/web/spec-extension/adapters/request-cookies");
const {
  RequestCookies,
  ResponseCookies,
} = require("next/dist/server/web/spec-extension/cookies");
const { adapter: nextWebAdapter } = require("next/dist/server/web/adapter");
const { splitCookiesString } = require("next/dist/server/web/utils");
const { isHTTPMethod } = require("next/dist/server/web/http");
const {
  getRedirectStatusCodeFromError,
  getRedirectTypeFromError,
  getURLFromRedirectError,
  permanentRedirect,
  redirect,
} = require("next/dist/client/components/redirect");
const {
  isRedirectError,
} = require("next/dist/client/components/redirect-error");
const { notFound } = require("next/dist/client/components/not-found");
const {
  getAccessFallbackHTTPStatus,
  isHTTPAccessFallbackError,
} = require("next/dist/client/components/http-access-fallback/http-access-fallback");
const {
  MiddlewareConfigInputSchema,
} = require("next/dist/build/segment-config/middleware/middleware-config");
const {
  getMiddlewareRouteMatcher,
} = require("next/dist/shared/lib/router/utils/middleware-route-matcher");
const { createMetadataComponents } = require("next/dist/lib/metadata/metadata");
const {
  handleCacheResponse,
  nextCache,
  patchedFetch,
  runWithNextCache,
  useCache,
  withCacheMetrics,
} = require("./cache-runtime.cjs");

const artifacts = new Map();
const moduleRuntimes = new Map();
const maxArtifacts = 16;
let requestQueue = Promise.resolve();

function installArtifact(artifact) {
  const alreadyInstalled = artifacts.has(artifact.generation);
  artifacts.delete(artifact.generation);
  artifacts.set(artifact.generation, artifact);
  if (!alreadyInstalled) {
    moduleRuntimes.set(artifact.generation, evaluateServerModules(artifact));
  }
  while (artifacts.size > maxArtifacts) {
    const oldest = artifacts.keys().next().value;
    artifacts.delete(oldest);
    moduleRuntimes.delete(oldest);
  }
}

function modulesFor(artifact) {
  const modules = moduleRuntimes.get(artifact.generation);
  if (!modules) {
    throw new Error(
      `Next generation ${artifact.generation} has no module runtime.`,
    );
  }
  return modules;
}

function resolveRelativeModule(importer, specifier, modules) {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier),
  );
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    path.posix.join(base, "index.tsx"),
    path.posix.join(base, "index.ts"),
    path.posix.join(base, "index.jsx"),
    path.posix.join(base, "index.js"),
  ];
  return candidates.find((candidate) => Object.hasOwn(modules, candidate));
}

function resolveRelativeStyle(importer, specifier, styles) {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier),
  );
  const candidates = [base, `${base}.css`];
  return candidates.find((candidate) => Object.hasOwn(styles, candidate));
}

function serverModuleMapFor(artifact) {
  return Object.fromEntries(
    Object.entries(artifact.actionManifest).map(([actionId, action]) => [
      actionId,
      {
        async: false,
        chunks: [],
        id: action.modulePath,
        name: action.exportName,
      },
    ]),
  );
}

function clientReferenceManifestFor(artifact) {
  return {
    ...artifact.clientReferenceManifest,
    "tuto-next-runtime": {
      async: false,
      chunks: [],
      id: "tuto-next-runtime",
      name: "*",
    },
  };
}

function bufferReadableStream(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(buffer);
      controller.close();
    },
  });
}

function actionEncryption(artifact) {
  let keyPromise;
  const key = () => {
    keyPromise ??= crypto.subtle.importKey(
      "raw",
      Buffer.from(artifact.actionEncryptionKey, "base64"),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    return keyPromise;
  };
  return {
    async encryptActionBoundArgs(actionId, ...args) {
      try {
        const serialized = await readableStreamBuffer(
          rsc.renderToReadableStream(args, artifact.clientReferenceManifest),
        );
        const iv = crypto.getRandomValues(new Uint8Array(16));
        const plaintext = Buffer.concat([Buffer.from(actionId), serialized]);
        const encrypted = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          await key(),
          plaintext,
        );
        return Buffer.concat([
          Buffer.from(iv),
          Buffer.from(encrypted),
        ]).toString("base64");
      } catch (error) {
        throw new Error("Tuto bound-action encryption failed.", {
          cause: error,
        });
      }
    },
    async decryptActionBoundArgs(actionId, encryptedPromise) {
      const payload = Buffer.from(await encryptedPromise, "base64");
      if (payload.byteLength <= 16) {
        throw new Error("Invalid Server Action payload: too short.");
      }
      const decrypted = Buffer.from(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: payload.subarray(0, 16) },
          await key(),
          payload.subarray(16),
        ),
      );
      const prefix = Buffer.from(actionId);
      if (!decrypted.subarray(0, prefix.byteLength).equals(prefix)) {
        throw new Error("Invalid Server Action payload: failed to decrypt.");
      }
      return rscClient.createFromReadableStream(
        bufferReadableStream(decrypted.subarray(prefix.byteLength)),
        {
          serverConsumerManifest: {
            moduleLoading: null,
            moduleMap: {},
            serverModuleMap: serverModuleMapFor(artifact),
          },
        },
      );
    },
  };
}

function evaluateServerModules(artifact) {
  const evaluated = new Map();
  const evaluating = new Set();
  const encryption = actionEncryption(artifact);
  const memoResult = Symbol("tuto.request-memo-result");
  const useCacheEntries = new Map();
  let requestMemo = null;

  function requestMemoize(callback) {
    function memoized(...args) {
      if (!requestMemo) return callback.apply(this, args);
      let entries = requestMemo.get(memoized);
      if (!entries) {
        entries = new Map();
        requestMemo.set(memoized, entries);
      }
      for (const argument of args) {
        let next = entries.get(argument);
        if (!next) {
          next = new Map();
          entries.set(argument, next);
        }
        entries = next;
      }
      if (entries.has(memoResult)) return entries.get(memoResult);
      const result = callback.apply(this, args);
      entries.set(memoResult, result);
      return result;
    }
    for (const key of Reflect.ownKeys(callback)) {
      if (["arguments", "caller", "length", "name", "prototype"].includes(key)) {
        continue;
      }
      Object.defineProperty(
        memoized,
        key,
        Object.getOwnPropertyDescriptor(callback, key),
      );
    }
    return memoized;
  }

  const runtimeReact = Object.create(React);
  Object.defineProperty(runtimeReact, "cache", {
    configurable: true,
    enumerable: true,
    value: requestMemoize,
  });

  async function run(callback) {
    if (requestMemo) return callback();
    requestMemo = new Map();
    try {
      return await callback();
    } finally {
      requestMemo = null;
    }
  }

  function evaluate(modulePath) {
    if (evaluated.has(modulePath)) return evaluated.get(modulePath).exports;
    if (evaluating.has(modulePath)) {
      throw new Error(`Circular server module dependency at ${modulePath}.`);
    }
    const compiled = artifact.serverModules[modulePath];
    if (!compiled)
      throw new Error(`Missing compiled server module: ${modulePath}.`);
    const loadedModule = { exports: {} };
    evaluated.set(modulePath, loadedModule);
    evaluating.add(modulePath);

    const localRequire = (specifier) => {
      if (specifier === "private-next-rsc-mod-ref-proxy") {
        return { createProxy: rsc.createClientModuleProxy };
      }
      if (specifier === "private-next-rsc-server-reference") {
        return { registerServerReference: rsc.registerServerReference };
      }
      if (specifier === "private-next-rsc-action-validate") {
        return {
          ensureServerEntryExports(actions) {
            for (const action of actions) {
              if (typeof action !== "function") {
                throw new Error(
                  'A "use server" file can only export async functions.',
                );
              }
            }
          },
        };
      }
      if (specifier === "private-next-rsc-action-encryption") {
        return encryption;
      }
      if (specifier === "private-next-rsc-cache-wrapper") {
        return {
          cache(kind, id, boundArgsLength, originalFn, args) {
            let memoizedOriginal = useCacheEntries.get(id);
            if (!memoizedOriginal) {
              memoizedOriginal = requestMemoize(originalFn);
              useCacheEntries.set(id, memoizedOriginal);
            }
            return useCache(kind, id, boundArgsLength, memoizedOriginal, args);
          },
        };
      }
      if (specifier === "next/navigation") {
        return {
          notFound,
          permanentRedirect,
          redirect,
        };
      }
      if (specifier === "next/link") {
        return { __esModule: true, default: runtimeClient.Link };
      }
      if (specifier === "next/cache") return nextCache;
      if (specifier === "next/headers" || specifier === "next/server") {
        return require(specifier);
      }
      if (specifier === "server-only") return {};
      if (specifier.startsWith(".")) {
        const stylePath = resolveRelativeStyle(
          modulePath,
          specifier,
          artifact.styles,
        );
        if (stylePath) return artifact.styles[stylePath].exports;
        const resolved = resolveRelativeModule(
          modulePath,
          specifier,
          artifact.serverModules,
        );
        if (!resolved)
          throw new Error(`Unable to resolve ${specifier} from ${modulePath}.`);
        return evaluate(resolved);
      }
      if (specifier === "react") return runtimeReact;
      if (
        specifier === "react-dom" ||
        specifier === "react/jsx-runtime" ||
        specifier === "react/jsx-dev-runtime" ||
        specifier.startsWith("@swc/helpers/")
      ) {
        return require(specifier);
      }
      throw new Error(
        `Unsupported external server import ${specifier} from ${modulePath}.`,
      );
    };
    try {
      const execute = new Function(
        "exports",
        "require",
        "module",
        "__filename",
        "__dirname",
        "fetch",
        `${compiled.code}\n//# sourceURL=${compiled.canonicalPath}`,
      );
      execute(
        loadedModule.exports,
        localRequire,
        loadedModule,
        compiled.canonicalPath,
        path.posix.dirname(compiled.canonicalPath),
        patchedFetch,
      );
      return loadedModule.exports;
    } finally {
      evaluating.delete(modulePath);
    }
  }

  return { evaluate, run };
}

function matchDefinitions(definitions, requestUrl) {
  for (const route of definitions) {
    const match = new RegExp(route.matcher.source).exec(requestUrl.pathname);
    if (!match) continue;
    const params = {};
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

function matchRoute(artifact, requestUrl) {
  return matchDefinitions(artifact.router.routes, requestUrl);
}

function matchRouteHandler(artifact, requestUrl) {
  return matchDefinitions(artifact.router.handlers, requestUrl);
}

function searchParams(requestUrl) {
  const result = {};
  for (const key of new Set(requestUrl.searchParams.keys())) {
    const values = requestUrl.searchParams.getAll(key);
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
}

function component(modules, modulePath, label) {
  const moduleExports = modules.evaluate(modulePath);
  const Component = moduleExports.default ?? moduleExports;
  if (typeof Component !== "function" && typeof Component !== "object") {
    throw new Error(`${modulePath} must default-export ${label}.`);
  }
  return Component;
}

function routeLoaderTree(modules, route) {
  const tuple = (modulePath) => [
    async () => modules.evaluate(modulePath),
    modulePath,
  ];
  let tree = ["__PAGE__", {}, { page: tuple(route.page) }, null];
  const pageDirectory = path.posix.dirname(route.page);
  const directories = [];
  for (
    let directory = pageDirectory;
    directory === "app" || directory.startsWith("app/");
    directory = path.posix.dirname(directory)
  ) {
    directories.unshift(directory);
    if (directory === "app") break;
  }
  const layouts = new Map(
    route.layouts.map((layoutPath) => [
      path.posix.dirname(layoutPath),
      layoutPath,
    ]),
  );
  for (const directory of [...directories].reverse()) {
    const layoutPath = layouts.get(directory);
    tree = [
      directory === "app" ? "" : path.posix.basename(directory),
      { children: tree },
      layoutPath ? { layout: tuple(layoutPath) } : {},
      null,
    ];
  }
  return tree;
}

function withRouteMetadata(modules, route, requestUrl, params, model) {
  const components = createMetadataComponents({
    interpolatedParams: params,
    isRuntimePrefetchable: false,
    metadataContext: {
      isStaticMetadataRouteFile: false,
      trailingSlash: false,
    },
    parsedQuery: searchParams(requestUrl),
    pathname: requestUrl.pathname,
    serveStreamingMetadata: false,
    tree: routeLoaderTree(modules, route),
  });
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(components.Viewport),
    React.createElement(components.Metadata),
    model,
  );
}

function routeStylePaths(artifact, route) {
  const styles = new Set();
  const visited = new Set();
  const queue = [
    ...route.layouts,
    route.page,
    ...route.boundaries.flatMap((boundary) => [
      boundary.loading,
      boundary.error,
      boundary.notFound,
    ]),
  ].filter(Boolean);
  while (queue.length > 0) {
    const modulePath = queue.shift();
    if (visited.has(modulePath)) continue;
    visited.add(modulePath);
    const compiledModule = artifact.serverModules[modulePath];
    if (!compiledModule) continue;
    const dependencies = new Set([
      ...compiledModule.dependencies,
      ...(artifact.clientModules[modulePath]?.dependencies ?? []),
    ]);
    for (const dependency of dependencies) {
      if (artifact.styles[dependency]) styles.add(dependency);
      else if (artifact.serverModules[dependency]) queue.push(dependency);
    }
  }
  return [...styles];
}

function wrapRootLayout(artifact, modules, model, params) {
  if (!artifact.router.rootLayout) {
    return React.createElement(
      "html",
      null,
      React.createElement("body", null, model),
    );
  }
  const Layout = component(
    modules,
    artifact.router.rootLayout,
    "a layout component",
  );
  return React.createElement(
    Layout,
    { params: Promise.resolve(params) },
    model,
  );
}

function createRouteModel(
  artifact,
  modules,
  requestUrl,
  matched = matchRoute(artifact, requestUrl),
) {
  if (!matched) {
    const model = artifact.router.rootNotFound
      ? React.createElement(
          component(
            modules,
            artifact.router.rootNotFound,
            "a not-found component",
          ),
        )
      : React.createElement("main", null, "Not Found");
    return {
      model: wrapRootLayout(artifact, modules, model, {}),
      routePattern: null,
      status: 404,
    };
  }

  const { params, route } = matched;
  const Page = component(modules, route.page, "a page component");
  let model = React.createElement(Page, {
    params: Promise.resolve(params),
    searchParams: Promise.resolve(searchParams(requestUrl)),
  });
  const pageDirectory = path.posix.dirname(route.page);
  const directories = [];
  for (
    let directory = pageDirectory;
    directory === "app" || directory.startsWith("app/");
    directory = path.posix.dirname(directory)
  ) {
    directories.unshift(directory);
    if (directory === "app") break;
  }
  const layouts = new Map(
    route.layouts.map((layoutPath) => [
      path.posix.dirname(layoutPath),
      layoutPath,
    ]),
  );
  const boundaries = new Map(
    route.boundaries.map((boundary) => [boundary.directory, boundary]),
  );
  for (const directory of [...directories].reverse()) {
    const boundary = boundaries.get(directory);
    if (boundary?.loading) {
      const Loading = component(
        modules,
        boundary.loading,
        "a loading component",
      );
      model = React.createElement(
        React.Suspense,
        { fallback: React.createElement(Loading) },
        model,
      );
    }
    if (boundary?.error) {
      const ErrorComponent = component(
        modules,
        boundary.error,
        "an error component",
      );
      model = React.createElement(
        runtimeClient.SegmentErrorBoundary,
        { errorComponent: ErrorComponent },
        model,
      );
    }
    const layoutPath = layouts.get(directory);
    if (layoutPath) {
      const Layout = component(modules, layoutPath, "a layout component");
      model = React.createElement(
        Layout,
        { params: Promise.resolve(params) },
        model,
      );
    }
  }
  if (route.layouts.length === 0) {
    model = React.createElement(
      "html",
      null,
      React.createElement("body", null, model),
    );
  }
  model = withRouteMetadata(modules, route, requestUrl, params, model);
  return {
    model,
    routePattern: route.pattern,
    status: 200,
    stylePaths: routeStylePaths(artifact, route),
  };
}

async function readableStreamBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function renderModel(artifact, model) {
  const renderErrors = [];
  const stream = rsc.renderToReadableStream(
    model,
    clientReferenceManifestFor(artifact),
    {
      onError(error) {
        renderErrors.push(error);
      },
    },
  );
  const body = await readableStreamBuffer(stream);
  if (renderErrors.length > 0) {
    const controlFlowError = renderErrors.find(
      (error) => isRedirectError(error) || isHTTPAccessFallbackError(error),
    );
    if (controlFlowError) throw controlFlowError;
    if (renderErrors.length === 1) throw renderErrors[0];
    throw new AggregateError(
      renderErrors,
      "Multiple RSC render errors occurred.",
    );
  }
  return body.toString("base64");
}

function createNotFoundModel(artifact, modules, matched, error) {
  const route = matched?.route;
  const failingPath = error ? failingModulePath(artifact, error) : undefined;
  const failingDirectory = failingPath
    ? path.posix.dirname(failingPath)
    : undefined;
  const excludeSameSegment = failingPath
    ? ["layout", "not-found"].includes(
        path.posix.basename(failingPath).split(".")[0],
      )
    : false;
  const boundary = route?.boundaries
    .filter(
      (candidate) =>
        candidate.notFound &&
        (!failingDirectory ||
          ((failingDirectory === candidate.directory ||
            failingDirectory.startsWith(`${candidate.directory}/`)) &&
            (!excludeSameSegment || candidate.directory !== failingDirectory))),
    )
    .at(-1);
  const modulePath = boundary?.notFound ?? artifact.router.rootNotFound;
  let model = modulePath
    ? React.createElement(
        component(modules, modulePath, "a not-found component"),
      )
    : React.createElement("main", null, "Not Found");
  if (route) {
    const layouts = boundary
      ? route.layouts.filter((layoutPath) => {
          const directory = path.posix.dirname(layoutPath);
          return (
            directory === boundary.directory ||
            boundary.directory.startsWith(`${directory}/`)
          );
        })
      : route.layouts;
    for (const layoutPath of [...layouts].reverse()) {
      const Layout = component(modules, layoutPath, "a layout component");
      model = React.createElement(
        Layout,
        { params: Promise.resolve(matched.params) },
        model,
      );
    }
    if (layouts.length === 0) {
      model = React.createElement(
        "html",
        null,
        React.createElement("body", null, model),
      );
    }
  } else {
    model = wrapRootLayout(artifact, modules, model, {});
  }
  return model;
}

function failingModulePath(artifact, error) {
  const stack = error instanceof Error ? (error.stack ?? error.message) : "";
  return Object.values(artifact.serverModules).find(
    (compiled) =>
      stack.includes(compiled.canonicalPath) || stack.includes(compiled.path),
  )?.path;
}

function errorBoundaryFor(artifact, route, error) {
  const available = route.boundaries.filter((boundary) => boundary.error);
  if (available.length === 0) return null;
  const failingPath = failingModulePath(artifact, error);
  if (!failingPath) return available.at(-1);
  const failingDirectory = path.posix.dirname(failingPath);
  const basename = path.posix.basename(failingPath).split(".")[0];
  const excludeSameSegment = [
    "error",
    "layout",
    "loading",
    "not-found",
  ].includes(basename);
  return available
    .filter(
      (boundary) =>
        (failingDirectory === boundary.directory ||
          failingDirectory.startsWith(`${boundary.directory}/`)) &&
        (!excludeSameSegment || boundary.directory !== failingDirectory),
    )
    .at(-1);
}

function createErrorModel(artifact, modules, matched, error) {
  if (!matched) return null;
  const { params, route } = matched;
  const boundary = errorBoundaryFor(artifact, route, error);
  if (!boundary?.error) return null;
  const ErrorComponent = component(
    modules,
    boundary.error,
    "an error component",
  );
  let model = React.createElement(runtimeClient.ErrorFallback, {
    digest:
      error && typeof error === "object" && "digest" in error
        ? error.digest
        : undefined,
    errorComponent: ErrorComponent,
    message: error instanceof Error ? error.message : String(error),
  });
  const layouts = route.layouts.filter((layoutPath) => {
    const directory = path.posix.dirname(layoutPath);
    return (
      directory === boundary.directory ||
      boundary.directory.startsWith(`${directory}/`)
    );
  });
  for (const layoutPath of [...layouts].reverse()) {
    const Layout = component(modules, layoutPath, "a layout component");
    model = React.createElement(
      Layout,
      { params: Promise.resolve(params) },
      model,
    );
  }
  if (layouts.length === 0) {
    model = React.createElement(
      "html",
      null,
      React.createElement("body", null, model),
    );
  }
  return model;
}

function createLoadingModel(modules, matched) {
  if (!matched) return null;
  const { params, route } = matched;
  const boundary = route.boundaries
    .filter((candidate) => candidate.loading)
    .at(-1);
  if (!boundary?.loading) return null;
  const Loading = component(modules, boundary.loading, "a loading component");
  let model = React.createElement(Loading);
  const layouts = route.layouts.filter((layoutPath) => {
    const directory = path.posix.dirname(layoutPath);
    return (
      directory === boundary.directory ||
      boundary.directory.startsWith(`${directory}/`)
    );
  });
  for (const layoutPath of [...layouts].reverse()) {
    const Layout = component(modules, layoutPath, "a layout component");
    model = React.createElement(
      Layout,
      { params: Promise.resolve(params) },
      model,
    );
  }
  if (layouts.length === 0) {
    model = React.createElement(
      "html",
      null,
      React.createElement("body", null, model),
    );
  }
  return model;
}

async function renderLoadingRoute(artifact, url, headers = []) {
  const modules = modulesFor(artifact);
  const request = new NextRequest(new URL(url, "http://next.local"), {
    headers,
    method: "GET",
  });
  const requestUrl = request.nextUrl;
  const matched = matchRoute(artifact, requestUrl);
  const routePattern = matched?.route.pattern ?? null;
  const loadingModel = createLoadingModel(modules, matched);
  if (!loadingModel) {
    return {
      bodyBase64: "",
      cacheMetrics: emptyCacheMetrics(),
      contentType: "text/plain; charset=utf-8",
      headers: [],
      routePattern,
      status: 204,
      stylePaths: [],
    };
  }
  const { metrics, value: bodyBase64 } = await withCacheMetrics(() =>
    runWithModuleRuntime(modules, () =>
      runWithNextCache(
        artifact,
        requestUrl,
        routePattern,
        "render",
        () => renderModel(artifact, loadingModel),
        request,
      ),
    ),
  );
  return {
    bodyBase64,
    cacheMetrics: metrics,
    contentType: "text/x-component; charset=utf-8",
    headers: [],
    routePattern,
    status: 200,
    stylePaths: matched ? routeStylePaths(artifact, matched.route) : [],
  };
}

async function renderRoute(artifact, url, headers = []) {
  const modules = modulesFor(artifact);
  const request = new NextRequest(new URL(url, "http://next.local"), {
    headers,
    method: "GET",
  });
  const requestUrl = request.nextUrl;
  const matched = matchRoute(artifact, requestUrl);
  const routePattern = matched?.route.pattern ?? null;
  try {
    const { metrics, value } = await withCacheMetrics(() =>
      runWithModuleRuntime(modules, () =>
        runWithNextCache(
          artifact,
          requestUrl,
          routePattern,
          "render",
          async () => {
            const route = createRouteModel(
              artifact,
              modules,
              requestUrl,
              matched,
            );
            return {
              bodyBase64: await renderModel(artifact, route.model),
              routePattern: route.routePattern,
              status: route.status,
              stylePaths: route.stylePaths ?? [],
            };
          },
          request,
        ),
      ),
    );
    return {
      ...value,
      cacheMetrics: metrics,
      contentType: "text/x-component; charset=utf-8",
      headers: [],
    };
  } catch (error) {
    if (isRedirectError(error)) {
      const location = getURLFromRedirectError(error);
      return {
        bodyBase64: "",
        cacheMetrics: emptyCacheMetrics(),
        contentType: "text/plain; charset=utf-8",
        headers: [["location", location]],
        routePattern,
        status: getRedirectStatusCodeFromError(error),
        stylePaths: [],
      };
    }
    if (isHTTPAccessFallbackError(error)) {
      const status = getAccessFallbackHTTPStatus(error);
      const { metrics, value: bodyBase64 } = await withCacheMetrics(() =>
        runWithModuleRuntime(modules, () =>
          runWithNextCache(
            artifact,
            requestUrl,
            routePattern,
            "render",
            () =>
              renderModel(
                artifact,
                createNotFoundModel(artifact, modules, matched, error),
              ),
            request,
          ),
        ),
      );
      return {
        bodyBase64,
        cacheMetrics: metrics,
        contentType: "text/x-component; charset=utf-8",
        headers: [],
        routePattern,
        status,
        stylePaths: matched ? routeStylePaths(artifact, matched.route) : [],
      };
    }
    const errorModel = createErrorModel(artifact, modules, matched, error);
    if (errorModel) {
      const { metrics, value: bodyBase64 } = await withCacheMetrics(() =>
        runWithModuleRuntime(modules, () =>
          runWithNextCache(
            artifact,
            requestUrl,
            routePattern,
            "render",
            () => renderModel(artifact, errorModel),
            request,
          ),
        ),
      );
      return {
        bodyBase64,
        cacheMetrics: metrics,
        contentType: "text/x-component; charset=utf-8",
        headers: [],
        routePattern,
        status: 500,
        stylePaths: matched ? routeStylePaths(artifact, matched.route) : [],
      };
    }
    throw error;
  }
}

function routeHandlerRequest(message) {
  const method = message.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD" || !message.bodyBase64
      ? undefined
      : Buffer.from(message.bodyBase64, "base64");
  return new NextRequest(new URL(message.url, "http://next.local"), {
    body,
    headers: message.headers,
    method,
  });
}

function serializedHeaders(headers) {
  const values = [...headers.entries()].filter(
    ([name]) => name.toLowerCase() !== "set-cookie",
  );
  if (typeof headers.getSetCookie === "function") {
    for (const cookie of headers.getSetCookie()) {
      values.push(["set-cookie", cookie]);
    }
  } else {
    const cookie = headers.get("set-cookie");
    if (cookie) values.push(["set-cookie", cookie]);
  }
  return values;
}

function matcherQuery(requestUrl) {
  const query = {};
  for (const key of new Set(requestUrl.searchParams.keys())) {
    const values = requestUrl.searchParams.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }
  return query;
}

function parsedProxyConfig(moduleExports) {
  if (moduleExports.config === undefined) return true;
  const parsed = MiddlewareConfigInputSchema.safeParse(moduleExports.config);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid Next proxy config: ${details}`);
  }
  return parsed.data;
}

function proxyMatches(moduleExports, requestUrl, headers, compiledMatchers) {
  const config = parsedProxyConfig(moduleExports);
  if (config === true || !config.matcher) return true;
  if (!compiledMatchers) {
    const {
      getMiddlewareMatchers,
    } = require("next/dist/build/analysis/get-page-static-info");
    compiledMatchers = getMiddlewareMatchers(config.matcher, {});
  }
  const requestHeaders = Object.fromEntries(headers.entries());
  requestHeaders.host ??= requestUrl.host;
  return getMiddlewareRouteMatcher(compiledMatchers)(
    requestUrl.pathname,
    { headers: requestHeaders },
    matcherQuery(requestUrl),
  );
}

function mergeProxyCookies(requestHeaders, middlewareCookies) {
  if (!middlewareCookies) return;
  const responseHeaders = new Headers();
  for (const cookie of splitCookiesString(middlewareCookies)) {
    responseHeaders.append("set-cookie", cookie);
  }
  const responseCookies = new ResponseCookies(responseHeaders);
  const requestCookies = new RequestCookies(requestHeaders);
  for (const cookie of responseCookies.getAll()) {
    requestCookies.set(cookie.name, cookie.value);
  }
}

function applyProxyRequestHeaders(incomingHeaders, proxyHeaders) {
  const headers = new Headers(incomingHeaders);
  const override = proxyHeaders.get("x-middleware-override-headers");
  if (override !== null) {
    const keys = new Set(
      override
        .split(",")
        .map((key) => key.trim().toLowerCase())
        .filter(Boolean),
    );
    for (const key of [...headers.keys()]) {
      if (!keys.has(key)) headers.delete(key);
    }
    for (const key of keys) {
      const value = proxyHeaders.get(`x-middleware-request-${key}`);
      if (value === null) headers.delete(key);
      else headers.set(key, value);
    }
  }
  mergeProxyCookies(headers, proxyHeaders.get("x-middleware-set-cookie"));
  for (const [name, value] of proxyHeaders.entries()) {
    if (
      name === "content-length" ||
      name === "set-cookie" ||
      name.startsWith("x-middleware-")
    ) {
      continue;
    }
    headers.set(name, value);
  }
  return headers;
}

function publicProxyHeaders(proxyHeaders) {
  const headers = new Headers();
  for (const [name, value] of serializedHeaders(proxyHeaders)) {
    if (name === "content-length" || name.startsWith("x-middleware-")) {
      continue;
    }
    headers.append(name, value);
  }
  return headers;
}

function base64BodyStream(value) {
  if (!value) return undefined;
  const bytes = Buffer.from(value, "base64");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function invokeProxy(artifact, message) {
  const proxy = artifact.router.proxy;
  const incomingHeaders = new Headers(message.headers);
  if (!proxy) {
    return {
      bodyBase64: "",
      headers: [],
      proxyMatched: false,
      proxyOutcome: "next",
      requestHeaders: [...incomingHeaders.entries()],
      status: 200,
      statusText: "",
      url: message.url,
    };
  }
  const modules = modulesFor(artifact);
  return runWithModuleRuntime(modules, async () => {
    const moduleExports = modules.evaluate(proxy.modulePath);
    const requestUrl = new URL(message.url, "http://next.local");
    if (
      !proxyMatches(
        moduleExports,
        requestUrl,
        incomingHeaders,
        message.proxyMatchers,
      )
    ) {
      return {
        bodyBase64: "",
        headers: [],
        proxyMatched: false,
        proxyOutcome: "next",
        requestHeaders: [...incomingHeaders.entries()],
        status: 200,
        statusText: "",
        url: `${requestUrl.pathname}${requestUrl.search}`,
      };
    }
    const handler =
      moduleExports.proxy ?? moduleExports.middleware ?? moduleExports.default;
    if (typeof handler !== "function") {
      throw new Error(
        `${proxy.modulePath} must export a default, proxy, or middleware function.`,
      );
    }
    const controller = new AbortController();
    const result = await nextWebAdapter({
      bypassNextUrl: false,
      handler: async (request, event) => handler(request, event),
      page: `/${proxy.kind}`,
      request: {
        body: base64BodyStream(message.bodyBase64),
        headers: Object.fromEntries(incomingHeaders.entries()),
        method: message.method,
        signal: controller.signal,
        url: requestUrl.toString(),
      },
    });
    await result.waitUntil;
    const response = result.response;
    const rewrite = response.headers.get("x-middleware-rewrite");
    const location = response.headers.get("location");
    const isNext = response.headers.get("x-middleware-next") === "1";
    const outcome = rewrite
      ? "rewrite"
      : location
        ? "redirect"
        : isNext
          ? "next"
          : "response";
    let nextUrl = `${requestUrl.pathname}${requestUrl.search}`;
    if (rewrite) {
      const destination = new URL(rewrite, requestUrl);
      if (destination.origin !== requestUrl.origin) {
        throw new Error(
          `External proxy rewrites are not supported in this checkpoint: ${destination.origin}`,
        );
      }
      nextUrl = `${destination.pathname}${destination.search}`;
    }
    const requestHeaders = applyProxyRequestHeaders(
      incomingHeaders,
      response.headers,
    );
    const headers = publicProxyHeaders(response.headers);
    const body =
      outcome === "response" && response.body
        ? await readableStreamBuffer(response.body)
        : Buffer.alloc(0);
    return {
      bodyBase64: body.toString("base64"),
      headers: serializedHeaders(headers),
      proxyMatched: true,
      proxyOutcome: outcome,
      requestHeaders: [...requestHeaders.entries()],
      status: response.status,
      statusText: response.statusText,
      url: nextUrl,
    };
  });
}

async function invokeRouteHandler(artifact, message) {
  const modules = modulesFor(artifact);
  const requestedMethod = message.method.toUpperCase();
  if (!isHTTPMethod(requestedMethod)) {
    return {
      bodyBase64: "",
      cacheMetrics: {
        hits: 0,
        misses: 0,
        revalidations: 0,
        staleHits: 0,
        writes: 0,
      },
      headers: [],
      routePattern: null,
      status: 400,
      statusText: "Bad Request",
    };
  }
  const request = routeHandlerRequest(message);
  const requestUrl = request.nextUrl;
  const matched = matchRouteHandler(artifact, requestUrl);
  if (!matched) {
    return {
      bodyBase64: Buffer.from("Not Found").toString("base64"),
      cacheMetrics: {
        hits: 0,
        misses: 0,
        revalidations: 0,
        staleHits: 0,
        writes: 0,
      },
      headers: [["content-type", "text/plain; charset=utf-8"]],
      routePattern: null,
      status: 404,
      statusText: "Not Found",
    };
  }
  const { params, route } = matched;
  return runWithModuleRuntime(modules, async () => {
    const moduleExports = modules.evaluate(route.handler);
    const method = request.method.toUpperCase();
    const methods = autoImplementMethods(moduleExports);
    const handler = methods[method];
    const { metrics, value } = await withCacheMetrics(() =>
      runWithNextCache(
        artifact,
        requestUrl,
        route.pattern,
        "action",
        async (requestStore) => {
          const response = await handler(request, {
            params: Promise.resolve(params),
          });
          if (!(response instanceof Response)) {
            const kind =
              response === null
                ? "null"
                : response === undefined
                  ? "undefined"
                  : typeof response;
            throw new Error(
              `No response is returned from route handler '${route.handler}'. Expected a Response object but received '${kind}' (method: ${method}, url: ${requestUrl.pathname}).`,
            );
          }
          const headers = new Headers(response.headers);
          appendMutableCookies(headers, requestStore.mutableCookies);
          const body =
            method === "HEAD" || response.body === null
              ? Buffer.alloc(0)
              : await readableStreamBuffer(response.body);
          return {
            bodyBase64: body.toString("base64"),
            headers: serializedHeaders(headers),
            routePattern: route.pattern,
            status: response.status,
            statusText: response.statusText,
          };
        },
        request,
        "route",
      ),
    );
    return { ...value, cacheMetrics: metrics };
  });
}

async function runWithModuleRuntime(modules, callback) {
  const previousRequire = globalThis.__next_require__;
  const previousWebpackRequire = globalThis.__webpack_require__;
  const previousChunkLoad = globalThis.__webpack_chunk_load__;
  const runtimeRequire = (modulePath) => modules.evaluate(modulePath);
  globalThis.__next_require__ = runtimeRequire;
  globalThis.__webpack_require__ = runtimeRequire;
  globalThis.__webpack_chunk_load__ = async () => {};
  try {
    return await modules.run(callback);
  } finally {
    globalThis.__next_require__ = previousRequire;
    globalThis.__webpack_require__ = previousWebpackRequire;
    globalThis.__webpack_chunk_load__ = previousChunkLoad;
  }
}

function actionBody(message) {
  if (message.body.kind === "string") return message.body.value;
  const formData = new FormData();
  for (const entry of message.body.entries) {
    if (entry.kind === "string") formData.append(entry.name, entry.value);
    else {
      const bytes = Buffer.from(entry.value, "base64");
      formData.append(
        entry.name,
        new File([bytes], entry.filename, { type: entry.contentType }),
      );
    }
  }
  return formData;
}

function emptyCacheMetrics() {
  return {
    hits: 0,
    misses: 0,
    revalidations: 0,
    staleHits: 0,
    writes: 0,
  };
}

function actionControlResult(error, routePattern, headers) {
  if (isRedirectError(error)) {
    const location = getURLFromRedirectError(error);
    const redirectType = getRedirectTypeFromError(error);
    headers.set("location", location);
    headers.set("x-action-redirect", `${location};${redirectType}`);
    return {
      bodyBase64: "",
      cacheMetrics: emptyCacheMetrics(),
      contentType: "text/plain; charset=utf-8",
      headers: serializedHeaders(headers),
      routePattern,
      status: 303,
      stylePaths: [],
    };
  }
  if (isHTTPAccessFallbackError(error)) {
    const status = getAccessFallbackHTTPStatus(error);
    return {
      bodyBase64: Buffer.from(
        status === 404 ? "Not Found" : "Request failed",
      ).toString("base64"),
      cacheMetrics: emptyCacheMetrics(),
      contentType: "text/plain; charset=utf-8",
      headers: serializedHeaders(headers),
      routePattern,
      status,
      stylePaths: [],
    };
  }
  return null;
}

async function invokeAction(artifact, message) {
  const reference = artifact.actionManifest[message.actionId];
  if (!reference) {
    throw new Error(
      `Server Action ${message.actionId} does not belong to generation ${artifact.generation}.`,
    );
  }
  if (reference.kind !== "action") {
    throw new Error(
      `Server reference ${message.actionId} is an internal Cache Component, not an invokable Server Action.`,
    );
  }
  const modules = modulesFor(artifact);
  return runWithModuleRuntime(modules, async () => {
    const serverModuleMap = serverModuleMapFor(artifact);
    const requestUrl = new URL(message.url, "http://next.local");
    const request = new NextRequest(requestUrl, {
      headers: message.headers ?? [],
      method: "POST",
    });
    const matched = matchRoute(artifact, requestUrl);
    const routePattern = matched?.route.pattern ?? null;
    const actionResponseHeaders = new Headers();
    try {
      const { metrics, value } = await withCacheMetrics(async () => {
        const actionResult = await runWithNextCache(
          artifact,
          requestUrl,
          routePattern,
          "action",
          async (requestStore) => {
            const args = await rsc.decodeReply(
              actionBody(message),
              serverModuleMap,
            );
            const moduleExports = modules.evaluate(reference.modulePath);
            const action = moduleExports[reference.exportName];
            if (typeof action !== "function") {
              throw new Error(
                `Server Action export ${reference.exportName} is missing from ${reference.modulePath}.`,
              );
            }
            try {
              return await action(...args);
            } finally {
              appendMutableCookies(
                actionResponseHeaders,
                requestStore.mutableCookies,
              );
            }
          },
          request,
        );
        const renderHeaders = new Headers(request.headers);
        mergeProxyCookies(
          renderHeaders,
          actionResponseHeaders.get("set-cookie"),
        );
        const renderRequest = new NextRequest(requestUrl, {
          headers: renderHeaders,
          method: "POST",
        });
        return runWithNextCache(
          artifact,
          requestUrl,
          routePattern,
          "render",
          async () => {
            const route = createRouteModel(
              artifact,
              modules,
              requestUrl,
              matched,
            );
            return {
              bodyBase64: await renderModel(artifact, {
                actionResult,
                root: route.model,
              }),
              routePattern: route.routePattern,
              status: route.status,
              stylePaths: route.stylePaths ?? [],
            };
          },
          renderRequest,
        );
      });
      return {
        ...value,
        cacheMetrics: metrics,
        contentType: "text/x-component; charset=utf-8",
        headers: serializedHeaders(actionResponseHeaders),
      };
    } catch (error) {
      const control = actionControlResult(
        error,
        routePattern,
        actionResponseHeaders,
      );
      if (control) return control;
      throw error;
    }
  });
}

async function invokeProgressiveAction(artifact, message) {
  const modules = modulesFor(artifact);
  return runWithModuleRuntime(modules, async () => {
    const serverModuleMap = serverModuleMapFor(artifact);
    const formData = actionBody(message);
    const requestUrl = new URL(message.url, "http://next.local");
    const request = new NextRequest(requestUrl, {
      headers: message.headers ?? [],
      method: "POST",
    });
    const matched = matchRoute(artifact, requestUrl);
    const routePattern = matched?.route.pattern ?? null;
    const actionResponseHeaders = new Headers();
    try {
      const { metrics, value } = await withCacheMetrics(async () => {
        const { formState } = await runWithNextCache(
          artifact,
          requestUrl,
          routePattern,
          "action",
          async (requestStore) => {
            const action = await rsc.decodeAction(formData, serverModuleMap);
            if (typeof action !== "function") {
              throw new Error(
                "The progressive form does not contain a valid Server Action reference.",
              );
            }
            let actionResult;
            try {
              actionResult = await action();
            } finally {
              appendMutableCookies(
                actionResponseHeaders,
                requestStore.mutableCookies,
              );
            }
            return {
              actionResult,
              formState: await rsc.decodeFormState(
                actionResult,
                formData,
                serverModuleMap,
              ),
            };
          },
          request,
        );
        const renderHeaders = new Headers(request.headers);
        mergeProxyCookies(
          renderHeaders,
          actionResponseHeaders.get("set-cookie"),
        );
        const renderRequest = new NextRequest(requestUrl, {
          headers: renderHeaders,
          method: "POST",
        });
        const rendered = await runWithNextCache(
          artifact,
          requestUrl,
          routePattern,
          "render",
          async () => {
            const route = createRouteModel(
              artifact,
              modules,
              requestUrl,
              matched,
            );
            return {
              bodyBase64: await renderModel(artifact, route.model),
              routePattern: route.routePattern,
              status: route.status,
              stylePaths: route.stylePaths ?? [],
            };
          },
          renderRequest,
        );
        return { ...rendered, formState };
      });
      return {
        ...value,
        cacheMetrics: metrics,
        contentType: "text/x-component; charset=utf-8",
        headers: serializedHeaders(actionResponseHeaders),
      };
    } catch (error) {
      const control = actionControlResult(
        error,
        routePattern,
        actionResponseHeaders,
      );
      if (control) return control;
      throw error;
    }
  });
}

async function handleMessage(message) {
  if (message.type === "install") {
    installArtifact(message.artifact);
    return {};
  }
  const artifact = artifacts.get(message.generation);
  if (!artifact) {
    throw new Error(`Next generation ${message.generation} is not installed.`);
  }
  if (message.type === "render") {
    return renderRoute(artifact, message.url, message.headers);
  }
  if (message.type === "loading") {
    return renderLoadingRoute(artifact, message.url, message.headers);
  }
  if (message.type === "proxy-config") {
    if (!artifact.router.proxy) return { proxyConfig: null };
    const moduleExports = modulesFor(artifact).evaluate(
      artifact.router.proxy.modulePath,
    );
    const config = parsedProxyConfig(moduleExports);
    return { proxyConfig: config === true ? null : config };
  }
  if (message.type === "action") return invokeAction(artifact, message);
  if (message.type === "progressive-action") {
    return invokeProgressiveAction(artifact, message);
  }
  if (message.type === "route-handler") {
    return invokeRouteHandler(artifact, message);
  }
  if (message.type === "proxy") return invokeProxy(artifact, message);
  throw new Error(`Unknown Next RSC worker message: ${message.type}.`);
}

module.exports = { handleMessage };

if (process.connected) {
  process.on("message", (message) => {
    if (handleCacheResponse(message)) return;
    if (
      !message ||
      typeof message !== "object" ||
      typeof message.id !== "string"
    )
      return;
    requestQueue = requestQueue.then(async () => {
      try {
        process.send?.({
          ...(await handleMessage(message)),
          id: message.id,
          ok: true,
        });
      } catch (error) {
        process.send?.({
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
          id: message.id,
          ok: false,
        });
      }
    });
  });
}
