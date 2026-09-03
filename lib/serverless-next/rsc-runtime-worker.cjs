/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const path = require("node:path");
require("./secure-node-compat.cjs");
const { createOutputStreamRegistry } = require("./stream-runtime.cjs");
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
const outputStreams = createOutputStreamRegistry();

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

function matchRoute(artifact, requestUrl, headers = new Headers()) {
  const nextUrl = headers.get("next-url");
  if (nextUrl) {
    const interceptingUrl = new URL(nextUrl, "http://next.local");
    if (interceptingUrl.origin === "http://next.local") {
      for (const interception of artifact.router.interceptions ?? []) {
        const intercepted = matchDefinitions(
          [
            {
              matcher: interception.interceptedMatcher,
              pattern: interception.interceptedPattern,
            },
          ],
          requestUrl,
        );
        const intercepting = matchDefinitions(
          [
            {
              matcher: interception.interceptingMatcher,
              pattern: interception.interceptingPattern,
            },
          ],
          interceptingUrl,
        );
        if (!intercepted || !intercepting) continue;
        const primary = matchDefinitions(
          artifact.router.routes,
          interceptingUrl,
        );
        if (!primary) continue;
        return {
          ...primary,
          interception: {
            definition: interception,
            params: intercepted.params,
          },
          matchUrl: interceptingUrl,
          routePattern: interception.interceptedPattern,
        };
      }
    }
  }
  const matched = matchDefinitions(artifact.router.routes, requestUrl);
  return matched
    ? {
        ...matched,
        matchUrl: requestUrl,
        routePattern: matched.route.pattern,
      }
    : null;
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
  const templates = new Map(
    (route.templates ?? []).map((templatePath) => [
      path.posix.dirname(templatePath),
      templatePath,
    ]),
  );
  for (const directory of [...directories].reverse()) {
    const layoutPath = layouts.get(directory);
    const templatePath = templates.get(directory);
    tree = [
      directory === "app" ? "" : path.posix.basename(directory),
      { children: tree },
      {
        ...(layoutPath ? { layout: tuple(layoutPath) } : {}),
        ...(templatePath ? { template: tuple(templatePath) } : {}),
      },
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
    ...(route.templates ?? []),
    route.page,
    ...route.boundaries.flatMap((boundary) => [
      boundary.loading,
      boundary.error,
      boundary.notFound,
    ]),
    artifact.router.rootGlobalError,
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

function routeDirectories(route, minimumDirectory) {
  const directories = [];
  for (
    let directory = path.posix.dirname(route.page);
    directory === "app" || directory.startsWith("app/");
    directory = path.posix.dirname(directory)
  ) {
    if (
      !minimumDirectory ||
      directory === minimumDirectory ||
      directory.startsWith(`${minimumDirectory}/`)
    ) {
      directories.unshift(directory);
    }
    if (directory === "app") break;
  }
  return directories;
}

function missingParallelRouteModel(artifact, modules, slot) {
  if (artifact.router.rootNotFound) {
    return React.createElement(
      component(
        modules,
        artifact.router.rootNotFound,
        "a not-found component",
      ),
    );
  }
  return React.createElement(
    "main",
    { "data-tuto-next-missing-slot": slot.name },
    `Not Found: @${slot.name}`,
  );
}

function selectParallelBranch(artifact, matched, requestUrl, slot) {
  const interception =
    matched.interception?.definition.slotDirectory === slot.slotDirectory
      ? matched.interception
      : null;
  const slotMatch = interception
    ? {
        params: interception.params,
        route: interception.definition.route,
      }
    : matchDefinitions(slot.routes, matched.matchUrl);
  const route = slotMatch?.route ?? slot.default;
  return route
    ? {
        pageUrl: interception ? requestUrl : matched.matchUrl,
        params: slotMatch?.params ?? matched.params,
        route,
        slot,
      }
    : null;
}

function branchOverrideModel(modules, override) {
  if (override.kind === "error") {
    const ErrorComponent = component(
      modules,
      override.boundary.error,
      "an error component",
    );
    return React.createElement(runtimeClient.ErrorFallback, {
      digest:
        override.error &&
        typeof override.error === "object" &&
        "digest" in override.error
          ? override.error.digest
          : undefined,
      errorComponent: ErrorComponent,
      message:
        override.error instanceof Error
          ? override.error.message
          : String(override.error),
    });
  }
  const modulePath =
    override.kind === "loading"
      ? override.boundary.loading
      : override.boundary.notFound;
  return React.createElement(
    component(
      modules,
      modulePath,
      override.kind === "loading"
        ? "a loading component"
        : "a not-found component",
    ),
  );
}

function createBranchModel(
  artifact,
  modules,
  route,
  params,
  pageUrl,
  context,
) {
  const override = context.branchOverrides?.get(route.page);
  let model;
  if (override) {
    model = branchOverrideModel(modules, override);
  } else {
    const Page = component(
      modules,
      route.page,
      route.page.includes("/default.")
        ? "a parallel-route default component"
        : "a page component",
    );
    model = React.createElement(Page, {
      params: Promise.resolve(params),
      searchParams: Promise.resolve(searchParams(pageUrl)),
    });
  }
  let missingSlot = false;
  const selectedRoutes = [route];
  const layouts = new Map(
    route.layouts.map((layoutPath) => [
      path.posix.dirname(layoutPath),
      layoutPath,
    ]),
  );
  const templates = new Map(
    (route.templates ?? []).map((templatePath) => [
      path.posix.dirname(templatePath),
      templatePath,
    ]),
  );
  const boundaries = new Map(
    route.boundaries.map((boundary) => [boundary.directory, boundary]),
  );
  for (const directory of [
    ...routeDirectories(route, context.minimumDirectory),
  ].reverse()) {
    const overrideDirectory = override?.boundary.directory;
    if (
      overrideDirectory &&
      directory !== overrideDirectory &&
      directory.startsWith(`${overrideDirectory}/`)
    ) {
      continue;
    }
    const replacesBoundary = overrideDirectory === directory;
    if (!replacesBoundary) {
      const templatePath = templates.get(directory);
      if (templatePath) {
        const Template = component(
          modules,
          templatePath,
          "a template component",
        );
        model = React.createElement(Template, null, model);
      }
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
      if (boundary?.notFound) {
        const NotFound = component(
          modules,
          boundary.notFound,
          "a not-found component",
        );
        model = React.createElement(
          runtimeClient.SegmentNotFoundBoundary,
          { fallback: React.createElement(NotFound) },
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
    }
    const layoutPath = layouts.get(directory);
    if (layoutPath) {
      const slotProps = {};
      if (!context.minimumDirectory) {
        for (const slot of artifact.router.parallelRoutes ?? []) {
          if (slot.ownerDirectory !== directory) continue;
          const selected = selectParallelBranch(
            artifact,
            context.matched,
            context.requestUrl,
            slot,
          );
          if (!selected) {
            missingSlot = true;
            slotProps[slot.name] = missingParallelRouteModel(
              artifact,
              modules,
              slot,
            );
            continue;
          }
          const slotResult = createBranchModel(
            artifact,
            modules,
            selected.route,
            selected.params,
            selected.pageUrl,
            {
              ...context,
              minimumDirectory: slot.slotDirectory,
            },
          );
          slotProps[slot.name] = slotResult.model;
          missingSlot ||= slotResult.missingSlot;
          selectedRoutes.push(...slotResult.selectedRoutes);
        }
      }
      const Layout = component(modules, layoutPath, "a layout component");
      model = React.createElement(
        Layout,
        { params: Promise.resolve(params), ...slotProps },
        model,
      );
    }
  }
  return { missingSlot, model, selectedRoutes };
}

function createRouteModel(
  artifact,
  modules,
  requestUrl,
  matched = matchRoute(artifact, requestUrl),
  branchOverrides = new Map(),
  includeMetadata = true,
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

  const result = createBranchModel(
    artifact,
    modules,
    matched.route,
    matched.params,
    matched.matchUrl,
    { branchOverrides, matched, minimumDirectory: undefined, requestUrl },
  );
  let model = result.model;
  if (matched.route.layouts.length === 0) {
    model = React.createElement(
      "html",
      null,
      React.createElement("body", null, model),
    );
  }
  if (includeMetadata) {
    model = withRouteMetadata(
      modules,
      matched.route,
      matched.matchUrl,
      matched.params,
      model,
    );
  }
  return {
    model,
    routePattern: matched.routePattern,
    status: result.missingSlot ? 404 : 200,
    stylePaths: [
      ...new Set(
        result.selectedRoutes.flatMap((selected) =>
          routeStylePaths(artifact, selected),
        ),
      ),
    ],
  };
}

async function readableStreamBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function modelReadableStream(artifact, model) {
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
  return { renderErrors, stream };
}

function throwRenderErrors(renderErrors, ignoreError = () => false) {
  const activeErrors = renderErrors.filter((error) => !ignoreError(error));
  if (activeErrors.length > 0) {
    const controlFlowError = activeErrors.find(
      (error) => isRedirectError(error) || isHTTPAccessFallbackError(error),
    );
    if (controlFlowError) throw controlFlowError;
    if (activeErrors.length === 1) throw activeErrors[0];
    throw new AggregateError(
      activeErrors,
      "Multiple RSC render errors occurred.",
    );
  }
}

async function renderModel(artifact, model) {
  const { renderErrors, stream } = modelReadableStream(artifact, model);
  const body = await readableStreamBuffer(stream);
  throwRenderErrors(renderErrors);
  return body.toString("base64");
}

function streamModel(artifact, model, finalResult, ignoreError) {
  const { renderErrors, stream } = modelReadableStream(artifact, model);
  const registered = outputStreams.register(stream, {
    onDone() {
      throwRenderErrors(renderErrors, ignoreError);
      return finalResult();
    },
  });
  return {
    completion: registered.completion,
    streamId: registered.id,
  };
}

function failingModulePath(artifact, error) {
  const stack = error instanceof Error ? (error.stack ?? error.message) : "";
  return Object.values(artifact.serverModules).find(
    (compiled) =>
      stack.includes(compiled.canonicalPath) || stack.includes(compiled.path),
  )?.path;
}

function selectedRouteBranches(artifact, matched, requestUrl) {
  if (!matched) return [];
  const branches = [
    {
      minimumDirectory: undefined,
      pageUrl: matched.matchUrl,
      params: matched.params,
      route: matched.route,
      slot: null,
    },
  ];
  const layoutDirectories = new Set(
    matched.route.layouts.map((layoutPath) => path.posix.dirname(layoutPath)),
  );
  for (const slot of artifact.router.parallelRoutes ?? []) {
    if (!layoutDirectories.has(slot.ownerDirectory)) continue;
    const selected = selectParallelBranch(
      artifact,
      matched,
      requestUrl,
      slot,
    );
    if (selected) {
      branches.push({
        ...selected,
        minimumDirectory: slot.slotDirectory,
      });
    }
  }
  return branches;
}

function selectedRouteStylePaths(artifact, matched, requestUrl) {
  return [
    ...new Set(
      selectedRouteBranches(artifact, matched, requestUrl).flatMap((branch) =>
        routeStylePaths(artifact, branch.route),
      ),
    ),
  ];
}

function routeContainsModule(artifact, route, targetPath) {
  const visited = new Set();
  const queue = [
    ...route.layouts,
    ...(route.templates ?? []),
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
    if (modulePath === targetPath) return true;
    visited.add(modulePath);
    const compiledModule = artifact.serverModules[modulePath];
    if (!compiledModule) continue;
    for (const dependency of compiledModule.dependencies) {
      if (artifact.serverModules[dependency]) queue.push(dependency);
    }
  }
  return false;
}

function failingRouteBranch(artifact, matched, requestUrl, error) {
  const branches = selectedRouteBranches(artifact, matched, requestUrl);
  const failingPath = failingModulePath(artifact, error);
  if (!failingPath) return branches[0];
  const directSlot = branches.find(
    (branch) =>
      branch.slot &&
      (failingPath === branch.slot.slotDirectory ||
        failingPath.startsWith(`${branch.slot.slotDirectory}/`)),
  );
  if (directSlot) return directSlot;
  const owners = branches.filter((branch) =>
    routeContainsModule(artifact, branch.route, failingPath),
  );
  return owners.length === 1 ? owners[0] : branches[0];
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

function createGlobalErrorModel(artifact, modules, error) {
  if (!artifact.router.rootGlobalError) return null;
  const GlobalError = component(
    modules,
    artifact.router.rootGlobalError,
    "a global error component",
  );
  return React.createElement(runtimeClient.ErrorFallback, {
    digest:
      error && typeof error === "object" && "digest" in error
        ? error.digest
        : undefined,
    errorComponent: GlobalError,
    message: error instanceof Error ? error.message : String(error),
  });
}

function createErrorModel(artifact, modules, requestUrl, matched, error) {
  if (!matched) return createGlobalErrorModel(artifact, modules, error);
  const branch = failingRouteBranch(artifact, matched, requestUrl, error);
  const boundary = branch
    ? errorBoundaryFor(artifact, branch.route, error)
    : null;
  if (!boundary?.error) {
    return createGlobalErrorModel(artifact, modules, error);
  }
  return createRouteModel(
    artifact,
    modules,
    requestUrl,
    matched,
    new Map([
      [
        branch.route.page,
        { boundary, error, kind: "error" },
      ],
    ]),
    false,
  ).model;
}

function notFoundBoundaryFor(artifact, branch, error) {
  const failingPath = error ? failingModulePath(artifact, error) : undefined;
  const failingDirectory = failingPath
    ? path.posix.dirname(failingPath)
    : undefined;
  const excludeSameSegment = failingPath
    ? ["layout", "not-found"].includes(
        path.posix.basename(failingPath).split(".")[0],
      )
    : false;
  return branch.route.boundaries
    .filter(
      (candidate) =>
        candidate.notFound &&
        (!branch.minimumDirectory ||
          candidate.directory === branch.minimumDirectory ||
          candidate.directory.startsWith(`${branch.minimumDirectory}/`)) &&
        (!failingDirectory ||
          ((failingDirectory === candidate.directory ||
            failingDirectory.startsWith(`${candidate.directory}/`)) &&
            (!excludeSameSegment || candidate.directory !== failingDirectory))),
    )
    .at(-1);
}

function streamCanLocalizeSlotError(artifact, matched, requestUrl, error) {
  if (isRedirectError(error)) return false;
  const branch = failingRouteBranch(artifact, matched, requestUrl, error);
  if (!branch?.slot) return false;
  if (isHTTPAccessFallbackError(error)) {
    return (
      getAccessFallbackHTTPStatus(error) === 404 &&
      Boolean(notFoundBoundaryFor(artifact, branch, error)?.notFound)
    );
  }
  return Boolean(errorBoundaryFor(artifact, branch.route, error)?.error);
}

function createNotFoundModel(artifact, modules, requestUrl, matched, error) {
  const branch = failingRouteBranch(artifact, matched, requestUrl, error);
  const boundary = branch
    ? notFoundBoundaryFor(artifact, branch, error)
    : null;
  if (branch && boundary?.notFound) {
    return createRouteModel(
      artifact,
      modules,
      requestUrl,
      matched,
      new Map([[branch.route.page, { boundary, kind: "not-found" }]]),
      false,
    ).model;
  }
  const model = artifact.router.rootNotFound
    ? React.createElement(
        component(
          modules,
          artifact.router.rootNotFound,
          "a not-found component",
        ),
      )
    : React.createElement("main", null, "Not Found");
  if (failingModulePath(artifact, error) === artifact.router.rootLayout) {
    return React.createElement(
      "html",
      null,
      React.createElement("body", null, model),
    );
  }
  return wrapRootLayout(artifact, modules, model, matched?.params ?? {});
}

function loadingBoundaryFor(branch) {
  return branch.route.boundaries
    .filter(
      (candidate) =>
        candidate.loading &&
        (!branch.minimumDirectory ||
          candidate.directory === branch.minimumDirectory ||
          candidate.directory.startsWith(`${branch.minimumDirectory}/`)),
    )
    .at(-1);
}

function createLoadingRouteModel(artifact, modules, requestUrl, matched) {
  if (!matched) return null;
  const branches = selectedRouteBranches(artifact, matched, requestUrl);
  const preferred = matched.interception
    ? branches.find(
        (branch) =>
          branch.slot?.slotDirectory ===
          matched.interception.definition.slotDirectory,
      )
    : branches[0];
  const boundary = preferred ? loadingBoundaryFor(preferred) : null;
  if (!preferred || !boundary?.loading) return null;
  return createRouteModel(
    artifact,
    modules,
    requestUrl,
    matched,
    new Map([[preferred.route.page, { boundary, kind: "loading" }]]),
    false,
  );
}

async function renderLoadingRoute(artifact, url, headers = []) {
  const modules = modulesFor(artifact);
  const request = new NextRequest(new URL(url, "http://next.local"), {
    headers,
    method: "GET",
  });
  const requestUrl = request.nextUrl;
  const matched = matchRoute(artifact, requestUrl, request.headers);
  const routePattern = matched?.routePattern ?? null;
  const loadingRoute = createLoadingRouteModel(
    artifact,
    modules,
    requestUrl,
    matched,
  );
  if (!loadingRoute) {
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
        () => renderModel(artifact, loadingRoute.model),
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
    stylePaths: loadingRoute.stylePaths ?? [],
  };
}

async function renderRoute(artifact, url, headers = []) {
  const modules = modulesFor(artifact);
  const request = new NextRequest(new URL(url, "http://next.local"), {
    headers,
    method: "GET",
  });
  const requestUrl = request.nextUrl;
  const matched = matchRoute(artifact, requestUrl, request.headers);
  const routePattern = matched?.routePattern ?? null;
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
                createNotFoundModel(
                  artifact,
                  modules,
                  requestUrl,
                  matched,
                  error,
                ),
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
        stylePaths: selectedRouteStylePaths(artifact, matched, requestUrl),
      };
    }
    const errorModel = createErrorModel(
      artifact,
      modules,
      requestUrl,
      matched,
      error,
    );
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
        stylePaths: selectedRouteStylePaths(artifact, matched, requestUrl),
      };
    }
    throw error;
  }
}

async function renderRouteStream(artifact, url, headers = []) {
  const modules = modulesFor(artifact);
  const request = new NextRequest(new URL(url, "http://next.local"), {
    headers,
    method: "GET",
  });
  const requestUrl = request.nextUrl;
  const matched = matchRoute(artifact, requestUrl, request.headers);
  const routePattern = matched?.routePattern ?? null;
  let ready = false;
  let resolveReady;
  let rejectReady;
  const result = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  void withCacheMetrics((metrics) =>
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
          const streamed = streamModel(
            artifact,
            route.model,
            () => ({ cacheMetrics: metrics }),
            (error) =>
              streamCanLocalizeSlotError(
                artifact,
                matched,
                requestUrl,
                error,
              ),
          );
          ready = true;
          resolveReady({
            cacheMetrics: metrics,
            contentType: "text/x-component; charset=utf-8",
            headers: [],
            routePattern: route.routePattern,
            status: route.status,
            streamId: streamed.streamId,
            stylePaths: route.stylePaths ?? [],
          });
          await streamed.completion;
        },
        request,
      ),
    ),
  ).catch((error) => {
    if (!ready) rejectReady(error);
  });

  return result;
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

function bytesReadableStream(bytes) {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function streamedImmediateResult(result) {
  const body = Buffer.from(result.bodyBase64 ?? "", "base64");
  const streamed = outputStreams.register(bytesReadableStream(body), {
    onDone: () => ({ cacheMetrics: result.cacheMetrics }),
  });
  const metadata = { ...result };
  delete metadata.bodyBase64;
  return { ...metadata, streamId: streamed.id };
}

async function invokeRouteHandlerStream(artifact, message) {
  const requestedMethod = message.method.toUpperCase();
  if (!isHTTPMethod(requestedMethod)) {
    return streamedImmediateResult({
      bodyBase64: "",
      cacheMetrics: emptyCacheMetrics(),
      headers: [],
      routePattern: null,
      status: 400,
      statusText: "Bad Request",
    });
  }
  const request = routeHandlerRequest(message);
  const requestUrl = request.nextUrl;
  const matched = matchRouteHandler(artifact, requestUrl);
  if (!matched) {
    return streamedImmediateResult({
      bodyBase64: Buffer.from("Not Found").toString("base64"),
      cacheMetrics: emptyCacheMetrics(),
      headers: [["content-type", "text/plain; charset=utf-8"]],
      routePattern: null,
      status: 404,
      statusText: "Not Found",
    });
  }

  const { params, route } = matched;
  const modules = modulesFor(artifact);
  let ready = false;
  let resolveReady;
  let rejectReady;
  const result = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  void runWithModuleRuntime(modules, async () => {
    const moduleExports = modules.evaluate(route.handler);
    const method = request.method.toUpperCase();
    const methods = autoImplementMethods(moduleExports);
    const handler = methods[method];
    return withCacheMetrics((metrics) =>
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
          const stream =
            method === "HEAD" || response.body === null
              ? bytesReadableStream(Buffer.alloc(0))
              : response.body;
          const streamed = outputStreams.register(stream, {
            onDone: () => ({ cacheMetrics: metrics }),
          });
          ready = true;
          resolveReady({
            cacheMetrics: metrics,
            headers: serializedHeaders(headers),
            routePattern: route.pattern,
            status: response.status,
            statusText: response.statusText,
            streamId: streamed.id,
          });
          await streamed.completion;
        },
        request,
        "route",
      ),
    );
  }).catch((error) => {
    if (!ready) rejectReady(error);
  });

  return result;
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
    const matched = matchRoute(artifact, requestUrl, request.headers);
    const routePattern = matched?.routePattern ?? null;
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
    const matched = matchRoute(artifact, requestUrl, request.headers);
    const routePattern = matched?.routePattern ?? null;
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
  if (message.type === "stream-pull") {
    return outputStreams.pull(message.streamId);
  }
  if (message.type === "stream-cancel") {
    return outputStreams.cancel(message.streamId, message.reason);
  }
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
  if (message.type === "render-stream") {
    return renderRouteStream(artifact, message.url, message.headers);
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
  if (message.type === "route-handler-stream") {
    return invokeRouteHandlerStream(artifact, message);
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
    const respond = async () => {
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
    };
    if (message.type === "stream-pull" || message.type === "stream-cancel") {
      void respond();
    } else {
      requestQueue = requestQueue.then(respond);
    }
  });
}
