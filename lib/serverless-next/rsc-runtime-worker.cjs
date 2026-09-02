/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const path = require("node:path");
const React = require("react");
const rsc = require("next/dist/compiled/react-server-dom-webpack/server.node");
const {
  handleCacheResponse,
  nextCache,
  runWithNextCache,
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

function unsupportedBoundAction() {
  throw new Error(
    "Captured inline Server Action arguments are not supported in this checkpoint. Use a module-level action or an inline action without captured values.",
  );
}

function evaluateServerModules(artifact) {
  const evaluated = new Map();
  const evaluating = new Set();

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
        return {
          decryptActionBoundArgs: unsupportedBoundAction,
          encryptActionBoundArgs: unsupportedBoundAction,
        };
      }
      if (specifier === "next/navigation") {
        return {
          notFound() {
            const error = new Error("NEXT_NOT_FOUND");
            error.code = "TUTO_NEXT_NOT_FOUND";
            throw error;
          },
        };
      }
      if (specifier === "next/cache") return nextCache;
      if (specifier === "server-only") return {};
      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeModule(
          modulePath,
          specifier,
          artifact.serverModules,
        );
        if (!resolved)
          throw new Error(`Unable to resolve ${specifier} from ${modulePath}.`);
        return evaluate(resolved);
      }
      if (
        specifier === "react" ||
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
        compiled.code,
      );
      execute(
        loadedModule.exports,
        localRequire,
        loadedModule,
        compiled.canonicalPath,
        path.posix.dirname(compiled.canonicalPath),
      );
      return loadedModule.exports;
    } finally {
      evaluating.delete(modulePath);
    }
  }

  return { evaluate };
}

function matchRoute(artifact, requestUrl) {
  for (const route of artifact.router.routes) {
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
  if (route.loading) {
    const Loading = component(modules, route.loading, "a loading component");
    model = React.createElement(
      React.Suspense,
      { fallback: React.createElement(Loading) },
      model,
    );
  }
  for (const layoutPath of [...route.layouts].reverse()) {
    const Layout = component(modules, layoutPath, "a layout component");
    model = React.createElement(
      Layout,
      { params: Promise.resolve(params) },
      model,
    );
  }
  if (route.layouts.length === 0) {
    model = React.createElement(
      "html",
      null,
      React.createElement("body", null, model),
    );
  }
  return { model, routePattern: route.pattern, status: 200 };
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
    artifact.clientReferenceManifest,
    {
      onError(error) {
        renderErrors.push(
          error instanceof Error ? error.message : String(error),
        );
      },
    },
  );
  const body = await readableStreamBuffer(stream);
  if (renderErrors.length > 0) throw new Error(renderErrors.join("\n"));
  return body.toString("base64");
}

async function renderRoute(artifact, url) {
  const modules = modulesFor(artifact);
  const requestUrl = new URL(url, "http://next.local");
  const matched = matchRoute(artifact, requestUrl);
  const routePattern = matched?.route.pattern ?? null;
  const { metrics, value } = await withCacheMetrics(() =>
    runWithNextCache(artifact, requestUrl, routePattern, "render", async () => {
      const route = createRouteModel(artifact, modules, requestUrl, matched);
      return {
        bodyBase64: await renderModel(artifact, route.model),
        routePattern: route.routePattern,
        status: route.status,
      };
    }),
  );
  return { ...value, cacheMetrics: metrics };
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

async function invokeAction(artifact, message) {
  const reference = artifact.actionManifest[message.actionId];
  if (!reference) {
    throw new Error(
      `Server Action ${message.actionId} does not belong to generation ${artifact.generation}.`,
    );
  }
  const modules = modulesFor(artifact);
  const previousRequire = globalThis.__next_require__;
  const previousChunkLoad = globalThis.__webpack_chunk_load__;
  globalThis.__next_require__ = (modulePath) => modules.evaluate(modulePath);
  globalThis.__webpack_chunk_load__ = async () => {};
  try {
    const serverModuleMap = Object.fromEntries(
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
    const requestUrl = new URL(message.url, "http://next.local");
    const matched = matchRoute(artifact, requestUrl);
    const routePattern = matched?.route.pattern ?? null;
    const { metrics, value } = await withCacheMetrics(async () => {
      const actionResult = await runWithNextCache(
        artifact,
        requestUrl,
        routePattern,
        "action",
        async () => {
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
          return action(...args);
        },
      );
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
          };
        },
      );
    });
    return { ...value, cacheMetrics: metrics };
  } finally {
    globalThis.__next_require__ = previousRequire;
    globalThis.__webpack_chunk_load__ = previousChunkLoad;
  }
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
  if (message.type === "render") return renderRoute(artifact, message.url);
  if (message.type === "action") return invokeAction(artifact, message);
  throw new Error(`Unknown Next RSC worker message: ${message.type}.`);
}

process.on("message", (message) => {
  if (handleCacheResponse(message)) return;
  if (!message || typeof message !== "object" || typeof message.id !== "string")
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
