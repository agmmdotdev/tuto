import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parseAstAsync } from "rolldown/parseAst";
import {
  hasDirective,
  transformDirectiveProxyExport,
} from "@vitejs/plugin-rsc/transforms";

const require = createRequire(import.meta.url);
const {
  importStartCompilerInternals,
} = require("../lib/serverless-tanstack-start/server-functions-transform.generated.cjs");

const outputRoot = path.resolve("lib/serverless-tanstack-start");
const manifestPath = path.join(outputRoot, "kernel-manifest.generated.json");
const clientKernelPath = path.join(outputRoot, "client-kernel.generated.js");
const serverKernelPath = path.join(outputRoot, "server-kernel.generated.mjs");
const rscKernelPath = path.join(outputRoot, "rsc-kernel.generated.mjs");
const clientGlobalKey = "__TUTO_TANSTACK_START_CLIENT_KERNEL__";
const clientServerFnBaseKey = "__TUTO_TANSTACK_START_SERVER_FN_BASE__";
const clientRouterKey = "__TUTO_TANSTACK_START_CLIENT_ROUTER_FACTORY__";
const clientStartInstanceKey = "__TUTO_TANSTACK_START_CLIENT_INSTANCE__";
const clientRscLoaderKey = "__TUTO_TANSTACK_START_RSC_CLIENT_LOADER__";
const serverRscLoaderKey = "__TUTO_TANSTACK_START_RSC_SSR_LOADER__";
const serverGlobalKey = "__TUTO_TANSTACK_START_SERVER_KERNEL__";
const serverHandlerKey = "__TUTO_TANSTACK_START_NATIVE_HANDLER__";
const serverResolverKey = "__TUTO_TANSTACK_START_SERVER_FN_RESOLVER__";
const serverStartInstanceKey = "__TUTO_TANSTACK_START_INSTANCE__";
const serverRouterKey = "__TUTO_TANSTACK_START_ROUTER_FACTORY__";
const serverManifestKey = "__TUTO_TANSTACK_START_MANIFEST__";
const serverFnInternalBase = "/__tuto_server_fn/";
const rscGlobalKey = "__TUTO_TANSTACK_START_RSC_KERNEL__";
const rscHandlerKey = "__TUTO_TANSTACK_START_RSC_HANDLER__";
const rscActionEncryptionKeyGlobalKey =
  "__TUTO_TANSTACK_START_RSC_ACTION_ENCRYPTION_KEY__";
const rscInternalPath = "/__tuto_rsc";
const rscActionInternalPath = "/__tuto_rsc_action";
const staticServerFunctionsSpecifier =
  "@tanstack/start-static-server-functions";
const staticServerFunctionsRuntimePath = path.resolve(
  "lib/serverless-tanstack-start/static-server-functions-runtime.ts",
);

const clientModules = [
  "@tanstack/react-start",
  "@tanstack/react-start/client",
  "@tanstack/react-start/client-rpc",
  "@tanstack/react-start/hydration",
  "@tanstack/react-start/rsc",
  "@tanstack/react-router",
  staticServerFunctionsSpecifier,
  "@vitejs/plugin-rsc/react/browser",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
];
const rscModules = [
  "@tanstack/react-start",
  staticServerFunctionsSpecifier,
  "@tanstack/react-start/rsc",
  "@tanstack/react-start/server",
  "@tanstack/react-start/server-rpc",
  "@tanstack/start-storage-context",
  "@vitejs/plugin-rsc/react/rsc",
  "@vitejs/plugin-rsc/utils/encryption-runtime",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
];
const serverModules = [
  "@tanstack/react-router",
  staticServerFunctionsSpecifier,
  "@tanstack/react-start",
  "@tanstack/react-start/hydration",
  "@tanstack/react-start/rsc",
  "@tanstack/react-start/server",
  "@tanstack/react-start/server-entry",
  "@tanstack/react-start/server-rpc",
  "@tanstack/react-start/ssr-rpc",
  "@tanstack/start-storage-context",
  "@vitejs/plugin-rsc/react/ssr",
  "react",
  "react/jsx-runtime",
  "react-dom/server",
];
const moduleExportOverrides = {
  [staticServerFunctionsSpecifier]: ["staticFunctionMiddleware"],
  "@vitejs/plugin-rsc/react/browser": [
    "callServer",
    "createFromFetch",
    "createFromReadableStream",
    "createServerReference",
    "createTemporaryReferenceSet",
    "encodeReply",
    "findSourceMapURL",
    "setRequireModule",
    "setServerCallback",
  ],
  "@vitejs/plugin-rsc/react/ssr": [
    "callServer",
    "createFromReadableStream",
    "createServerReference",
    "findSourceMapURL",
    "setRequireModule",
  ],
};

function createStaticServerFunctionsPlugin() {
  return {
    name: "tuto-static-server-functions-runtime",
    setup(buildApi) {
      buildApi.onResolve(
        { filter: /^@tanstack\/start-static-server-functions$/ },
        () => ({ path: staticServerFunctionsRuntimePath }),
      );
    },
  };
}

function createStartEnvironmentPlugin(env) {
  let compilerPromise;
  const serverFnsById = {};

  async function resolveCompilerModule(source, importer) {
    if (source.startsWith(".")) {
      return path.resolve(path.dirname(importer ?? process.cwd()), source);
    }

    return require.resolve(source, {
      paths: [path.dirname(importer ?? process.cwd())],
    });
  }

  async function getCompiler() {
    compilerPromise ??= (async () => {
      const { createStartCompiler } = await importStartCompilerInternals();
      let compiler;
      compiler = createStartCompiler({
        env,
        envName: env === "client" ? "client" : "ssr",
        root: process.cwd(),
        framework: "react",
        providerEnvName: "ssr",
        mode: "build",
        getKnownServerFns: () => serverFnsById,
        onServerFnsById: (next) => Object.assign(serverFnsById, next),
        resolveId: resolveCompilerModule,
        loadModule: async (moduleId) => {
          const cleanId = moduleId.split("?")[0];
          if (!path.isAbsolute(cleanId)) return;
          const code = await readFile(cleanId, "utf8");
          compiler.ingestModule({ code, id: cleanId });
        },
      });
      return compiler;
    })();

    return compilerPromise;
  }

  return {
    name: `tuto-start-${env}-kernel-environment`,
    setup(buildApi) {
      buildApi.onLoad(
        {
          filter:
            env === "server"
              ? /node_modules[\\/]@tanstack[\\/](?:react-start-rsc|start-client-core|start-fn-stubs|start-storage-context)[\\/].*\.js$/
              : /node_modules[\\/]@tanstack[\\/](?:start-client-core|start-fn-stubs|start-storage-context)[\\/].*\.js$/,
        },
        async (args) => {
          const code = await readFile(args.path, "utf8");
          if (
            !code.includes("createIsomorphicFn") &&
            !code.includes("createServerOnlyFn") &&
            !code.includes("createClientOnlyFn")
          ) {
            return null;
          }

          const { detectKindsInCode } = await importStartCompilerInternals();
          const compiler = await getCompiler();
          const result = await compiler.compile({
            code,
            id: args.path,
            detectedKinds: detectKindsInCode(code, env),
          });

          return result?.code
            ? {
                contents: result.code,
                loader: "js",
                resolveDir: path.dirname(args.path),
              }
            : null;
        },
      );
    },
  };
}

function createClientEntriesPlugin() {
  return {
    name: "tuto-start-client-kernel-entries",
    setup(buildApi) {
      buildApi.onResolve(
        {
          filter:
            /^#tanstack-(?:router-entry|start-entry|start-plugin-adapters)$/,
        },
        (args) => ({
          path: args.path,
          namespace: "tuto-client-kernel-entry",
        }),
      );
      buildApi.onResolve(
        {
          filter: /^virtual:tanstack-rsc-(?:browser-decode|ssr-decode|hmr)$/,
        },
        (args) => ({
          path: args.path,
          namespace: "tuto-client-rsc-runtime",
        }),
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-client-kernel-entry" },
        (args) => {
          if (args.path === "#tanstack-router-entry") {
            return {
              contents: `
export async function getRouter() {
  const factory = globalThis.${clientRouterKey};
  if (typeof factory !== 'function') {
    throw new Error('The SSR client router factory is not registered.');
  }
  return await factory();
}
`,
              loader: "js",
            };
          }
          if (args.path === "#tanstack-start-plugin-adapters") {
            return {
              contents: `
import { rscSerializationAdapter } from '@tanstack/react-start/rsc/serialization/client';
export const hasPluginAdapters = true;
export const pluginSerializationAdapters = rscSerializationAdapter();
`,
              loader: "js",
              resolveDir: process.cwd(),
            };
          }
          return {
            contents: `
export const startInstance = {
  async getOptions() {
    const instance = globalThis.${clientStartInstanceKey};
    const options = instance && typeof instance.getOptions === 'function'
      ? await instance.getOptions()
      : {};
    return {
      ...options,
      serverFns: {
        ...(options.serverFns ?? {}),
        fetch: (url, init) => globalThis.fetch(url, { ...init, credentials: 'include' }),
      },
    };
  },
};
`,
            loader: "js",
          };
        },
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-client-rsc-runtime" },
        (args) => {
          if (args.path === "virtual:tanstack-rsc-hmr") {
            return {
              contents: "export function setupRscHmr() {}",
              loader: "js",
            };
          }
          return {
            contents: `
import {
  createFromFetch,
  createFromReadableStream,
  encodeReply,
  setServerCallback,
  setRequireModule,
} from '@vitejs/plugin-rsc/react/browser';

setRequireModule({
  load(id) {
    const load = globalThis.${clientRscLoaderKey};
    if (typeof load !== 'function') {
      throw new Error('The RSC client-reference loader is not registered.');
    }
    return load(id);
  },
});

setServerCallback(async (id, args) => {
  const body = await encodeReply(args);
  const headers = {
    accept: 'text/x-component',
    'x-tuto-rsc-action': id,
  };
  if (typeof body === 'string') {
    headers['content-type'] = 'text/plain; charset=utf-8';
  }
  return createFromFetch(globalThis.fetch(${JSON.stringify(
    rscActionInternalPath,
  )}, {
    body,
    credentials: 'include',
    headers,
    method: 'POST',
  }));
});

export { createFromFetch, createFromReadableStream };
`,
            loader: "js",
            resolveDir: process.cwd(),
          };
        },
      );
    },
  };
}

function createRscEntriesPlugin(serverBridgeExports) {
  return {
    name: "tuto-start-rsc-kernel-entries",
    setup(buildApi) {
      buildApi.onResolve(
        { filter: /^virtual:vite-rsc\/encryption-key$/ },
        () => ({
          path: "virtual:vite-rsc/encryption-key",
          namespace: "tuto-rsc-encryption-key",
        }),
      );
      buildApi.onResolve(
        {
          filter:
            /^@tanstack\/(?:start-storage-context|react-start\/server)$/,
        },
        (args) => ({
          path: args.path,
          namespace: "tuto-rsc-storage-context",
        }),
      );
      buildApi.onResolve(
        { filter: /^virtual:tanstack-rsc-runtime$/ },
        () => ({
          path: "virtual:tanstack-rsc-runtime",
          namespace: "tuto-rsc-runtime",
        }),
      );
      buildApi.onResolve(
        { filter: /^virtual:tanstack-rsc-(?:browser|ssr)-decode$/ },
        (args) => ({
          path: args.path,
          namespace: "tuto-rsc-decode-runtime",
        }),
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-rsc-encryption-key" },
        () => ({
          contents: `
export default function getRscActionEncryptionKey() {
  const key = globalThis.${rscActionEncryptionKeyGlobalKey};
  if (typeof key !== 'string') {
    throw new Error('The RSC action encryption key is not initialized.');
  }
  return key;
}
`,
          loader: "js",
        }),
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-rsc-runtime" },
        () => ({
          contents:
            "export { renderToReadableStream } from '@vitejs/plugin-rsc/react/rsc';",
          loader: "js",
          resolveDir: process.cwd(),
        }),
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-rsc-decode-runtime" },
        () => ({
          contents:
            "export { createFromReadableStream } from '@vitejs/plugin-rsc/react/rsc'; export function createFromFetch() { throw new Error('createFromFetch is unavailable in the RSC environment.'); }",
          loader: "js",
          resolveDir: process.cwd(),
        }),
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-rsc-storage-context" },
        (args) => ({
          contents: `
const serverModule = globalThis.${serverGlobalKey}?.modules?.[${JSON.stringify(
            args.path,
          )}];
if (!serverModule) {
  throw new Error('The shared Start server module is not initialized: ${args.path}');
}
${serverBridgeExports[args.path]
  .map((name) => `export const ${name} = serverModule[${JSON.stringify(name)}];`)
  .join("\n")}
`,
          loader: "js",
        }),
      );
    },
  };
}

function createRscDirectivePlugin(clientReferences) {
  return {
    name: "tuto-start-rsc-use-client",
    setup(buildApi) {
      buildApi.onLoad(
        {
          filter:
            /node_modules[\\/]@tanstack[\\/]react-start-rsc[\\/].*\.js$/,
        },
        async (args) => {
          const source = await readFile(args.path, "utf8");
          if (!source.includes("use client")) return null;
          const ast = await parseAstAsync(source);
          if (!hasDirective(ast.body, "use client")) return null;
          const reference = `tanstack-rsc-${createHash("sha256")
            .update(args.path)
            .digest("hex")
            .slice(0, 20)}`;
          clientReferences.set(reference, args.path);
          const transformed = transformDirectiveProxyExport(ast, {
            code: source,
            directive: "use client",
            keep: false,
            runtime: (name) =>
              `$$registerClientReference(() => { throw new Error('TanStack RSC client reference cannot execute in the RSC environment.'); }, ${JSON.stringify(
                reference,
              )}, ${JSON.stringify(name)})`,
          });
          if (!transformed) return null;
          return {
            contents: `import { registerClientReference as $$registerClientReference } from '@vitejs/plugin-rsc/react/rsc';\n${transformed.output.toString()}`,
            loader: "js",
            resolveDir: path.dirname(args.path),
          };
        },
      );
    },
  };
}

function createRscWebpackRuntimePlugin() {
  return {
    name: "tuto-start-rsc-webpack-runtime",
    setup(buildApi) {
      buildApi.onLoad(
        {
          filter:
            /node_modules[\\/]@vitejs[\\/]plugin-rsc[\\/]dist[\\/]vendor[\\/]react-server-dom[\\/].*\.js$/,
        },
        async (args) => {
          const source = await readFile(args.path, "utf8");
          if (!source.includes("__webpack_require__")) return null;
          return {
            contents: source
              .replaceAll("__webpack_require__.u", "({}).u")
              .replaceAll("__webpack_require__", "__vite_rsc_require__"),
            loader: "js",
            resolveDir: path.dirname(args.path),
          };
        },
      );
    },
  };
}

function createServerEntriesPlugin() {
  return {
    name: "tuto-start-server-kernel-entries",
    setup(buildApi) {
      buildApi.onResolve(
        {
          filter:
            /^#tanstack-(?:router-entry|start-entry|start-plugin-adapters)$/,
        },
        (args) => ({
          path: args.path,
          namespace: "tuto-server-kernel-entry",
        }),
      );
      buildApi.onResolve({ filter: /^tanstack-start-manifest:v$/ }, () => ({
        path: "tanstack-start-manifest:v",
        namespace: "tuto-server-kernel-entry",
      }));
      buildApi.onResolve(
        { filter: /^virtual:tanstack-rsc-(?:browser|ssr)-decode$/ },
        (args) => ({
          path: args.path,
          namespace: "tuto-server-rsc-decode",
        }),
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-server-kernel-entry" },
        (args) => {
          if (args.path === "#tanstack-router-entry") {
            return {
              contents: `
export async function getRouter() {
  const factory = globalThis.${serverRouterKey};
  if (typeof factory !== 'function') {
    throw new Error('This revision does not export getRouter from src/router.');
  }
  return await factory();
}
`,
              loader: "js",
            };
          }
          if (args.path === "#tanstack-start-plugin-adapters") {
            return {
              contents: `
import { rscSerializationAdapter } from '@tanstack/react-start/rsc/serialization/server';
export const hasPluginAdapters = true;
export const pluginSerializationAdapters = rscSerializationAdapter();
`,
              loader: "js",
              resolveDir: process.cwd(),
            };
          }
          if (args.path === "tanstack-start-manifest:v") {
            return {
              contents: `
export function tsrStartManifest() {
  return globalThis.${serverManifestKey} ?? { routes: {} };
}
`,
              loader: "js",
            };
          }
          return {
            contents: `
import { createCsrfMiddleware } from '@tanstack/react-start';

const defaultCsrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === 'serverFn',
});

export const startInstance = {
  async getOptions() {
    const instance = globalThis.${serverStartInstanceKey};
    if (instance && typeof instance.getOptions === 'function') {
      return await instance.getOptions();
    }
    return { requestMiddleware: [defaultCsrfMiddleware] };
  },
};
`,
            loader: "js",
            resolveDir: process.cwd(),
          };
        },
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-server-rsc-decode" },
        () => ({
          contents: `
import { createFromReadableStream, setRequireModule } from '@vitejs/plugin-rsc/react/ssr';
let onClientReference;
setRequireModule({
  async load(id) {
    const load = globalThis.${serverRscLoaderKey};
    if (typeof load !== 'function') {
      throw new Error('The RSC SSR client-reference loader is not registered.');
    }
    const reference = await load(id);
    const module = reference.module;
    const deps = reference.deps ?? { css: [], js: [] };
    onClientReference?.({ id, deps, runtime: 'tuto' });
    return new Proxy(module, {
      get(target, property, receiver) {
        onClientReference?.({ id, deps, runtime: 'tuto' });
        return Reflect.get(target, property, receiver);
      },
    });
  },
});
export function setOnClientReference(callback) {
  onClientReference = callback;
}
export { createFromReadableStream };
export function createFromFetch() {
  throw new Error('createFromFetch is unavailable during Start SSR.');
}
`,
          loader: "js",
          resolveDir: process.cwd(),
        }),
      );
    },
  };
}

function createServerResolverPlugin() {
  return {
    name: "tuto-start-server-kernel-resolver",
    setup(buildApi) {
      buildApi.onResolve(
        { filter: /^#tanstack-start-server-fn-resolver$/ },
        () => ({
          path: "tuto-server-fn-resolver",
          namespace: "tuto-server-kernel-resolver",
        }),
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-server-kernel-resolver" },
        () => ({
          contents: `
export async function getServerFnById(id) {
  const resolver = globalThis.${serverResolverKey};
  if (typeof resolver !== 'function') {
    throw new Error('The student server-function resolver is not registered.');
  }
  return resolver(id);
}
`,
          loader: "js",
        }),
      );
    },
  };
}

async function moduleExports(specifiers) {
  return Object.fromEntries(
    await Promise.all(
      specifiers.map(async (specifier) => {
        const overriddenExports = moduleExportOverrides[specifier];
        if (overriddenExports) return [specifier, overriddenExports];
        const namespace = await import(specifier);
        return [specifier, Object.keys(namespace).sort()];
      }),
    ),
  );
}

function moduleImports(specifiers) {
  return specifiers
    .map(
      (specifier, index) =>
        `import * as module${index} from ${JSON.stringify(specifier)};`,
    )
    .join("\n");
}

function moduleMap(specifiers) {
  return specifiers
    .map((specifier, index) => `${JSON.stringify(specifier)}: module${index}`)
    .join(",\n");
}

function frameworkRscClientReferenceEntries(clientReferences) {
  return [...clientReferences.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reference, filePath], index) => ({
      filePath,
      importName: `frameworkRscClientReference${index}`,
      moduleKey: `#tanstack-rsc-client-reference/${reference}`,
      reference,
    }));
}

function frameworkRscClientReferenceImports(entries) {
  return entries
    .map(
      ({ filePath, importName }) =>
        `import * as ${importName} from ${JSON.stringify(filePath)};`,
    )
    .join("\n");
}

function frameworkRscClientReferenceModuleMap(entries) {
  return entries
    .map(
      ({ importName, moduleKey }) =>
        `${JSON.stringify(moduleKey)}: ${importName}`,
    )
    .join(",\n");
}

function packageVersion(packageName) {
  return require(`${packageName}/package.json`).version;
}

export async function buildTanstackStartKernels() {
  const packages = {
    "@tanstack/react-router": packageVersion("@tanstack/react-router"),
    "@tanstack/react-start": packageVersion("@tanstack/react-start"),
    "@tanstack/react-start-rsc": packageVersion(
      "@tanstack/react-start-rsc",
    ),
    "@tanstack/start-plugin-core": packageVersion(
      "@tanstack/start-plugin-core",
    ),
    "@tanstack/start-server-core": packageVersion(
      "@tanstack/start-server-core",
    ),
    react: packageVersion("react"),
    "react-dom": packageVersion("react-dom"),
    "@vitejs/plugin-rsc": packageVersion("@vitejs/plugin-rsc"),
  };
  const id = createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .update(
      JSON.stringify({ clientModules, packages, rscModules, serverModules }),
    )
    .digest("hex")
    .slice(0, 20);
  const [clientExports, serverExports] = await Promise.all([
    moduleExports(clientModules),
    moduleExports(serverModules),
  ]);
  const rscEntry = `
import {
  createClientOnlyFn,
  createIsomorphicFn,
  createMiddleware,
  createServerFn,
  createServerOnlyFn,
} from '@tanstack/react-start';
import * as rscStart from '@tanstack/react-start/rsc';
import * as rscStaticServerFunctions from '@tanstack/start-static-server-functions';
import * as rscStartServer from '@tanstack/react-start/server';
import * as rscServerRpc from '@tanstack/react-start/server-rpc';
import * as rscStorageContext from '@tanstack/start-storage-context';
import * as rscRuntime from '@vitejs/plugin-rsc/react/rsc';
import * as rscActionEncryption from '@vitejs/plugin-rsc/utils/encryption-runtime';
import * as rscReact from 'react';
import * as rscJsxRuntime from 'react/jsx-runtime';
import * as rscJsxDevRuntime from 'react/jsx-dev-runtime';
globalThis.${rscGlobalKey} = Object.freeze({
  id: ${JSON.stringify(id)},
  modules: Object.freeze({
    '@tanstack/react-start': Object.freeze({
      createClientOnlyFn,
      createIsomorphicFn,
      createMiddleware,
      createServerFn,
      createServerOnlyFn,
    }),
    '@tanstack/react-start/rsc': rscStart,
    '@tanstack/start-static-server-functions': rscStaticServerFunctions,
    '@tanstack/react-start/server': rscStartServer,
    '@tanstack/react-start/server-rpc': rscServerRpc,
    '@tanstack/start-storage-context': rscStorageContext,
    '@vitejs/plugin-rsc/react/rsc': rscRuntime,
    '@vitejs/plugin-rsc/utils/encryption-runtime': rscActionEncryption,
    'react': rscReact,
    'react/jsx-runtime': rscJsxRuntime,
    'react/jsx-dev-runtime': rscJsxDevRuntime,
  }),
});`;

  const frameworkRscClientReferences = new Map();
  const rscBuild = await build({
    absWorkingDir: process.cwd(),
    bundle: true,
    charset: "utf8",
    conditions: ["react-server", "module", "import", "default"],
    define: {
      "import.meta.env.DEV": "false",
      "import.meta.env.__vite_rsc_build__": "true",
      "process.env.NODE_ENV": '"production"',
    },
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    minify: true,
    outfile: rscKernelPath,
    platform: "node",
    plugins: [
      createStaticServerFunctionsPlugin(),
      createRscEntriesPlugin({
        "@tanstack/react-start/server":
          serverExports["@tanstack/react-start/server"],
        "@tanstack/start-storage-context":
          serverExports["@tanstack/start-storage-context"],
      }),
      createRscDirectivePlugin(frameworkRscClientReferences),
      createRscWebpackRuntimePlugin(),
    ],
    stdin: {
      contents: rscEntry,
      loader: "js",
      resolveDir: process.cwd(),
      sourcefile: "tuto-tanstack-start-rsc-kernel.js",
    },
    target: ["node22"],
    write: false,
  });
  const frameworkRscEntries = frameworkRscClientReferenceEntries(
    frameworkRscClientReferences,
  );
  const frameworkRscImports =
    frameworkRscClientReferenceImports(frameworkRscEntries);
  const frameworkRscModuleMap =
    frameworkRscClientReferenceModuleMap(frameworkRscEntries);
  const clientEntry = `${moduleImports(clientModules)}
${frameworkRscImports}
globalThis.${clientGlobalKey} = Object.freeze({
  id: ${JSON.stringify(id)},
  modules: Object.freeze({
    ${moduleMap(clientModules)},
    ${frameworkRscModuleMap}
  }),
});`;
  const serverEntry = `${moduleImports(serverModules)}
${frameworkRscImports}
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';

const modules = Object.freeze({
  ${moduleMap(serverModules)},
  ${frameworkRscModuleMap}
});
globalThis.${serverGlobalKey} = Object.freeze({
  id: ${JSON.stringify(id)},
  modules,
});
const startHandler = createStartHandler(defaultStreamHandler);
globalThis.${serverHandlerKey} = (request, requestOptions = {}) =>
  startHandler(request, requestOptions);`;

  const [clientBuild, serverBuild] = await Promise.all([
    build({
      absWorkingDir: process.cwd(),
      bundle: true,
      charset: "utf8",
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.TSS_INLINE_CSS_ENABLED": "undefined",
        "process.env.TSS_ROUTER_BASEPATH": "undefined",
        "process.env.TSS_SERVER_FN_BASE": `globalThis.${clientServerFnBaseKey}`,
      },
      format: "iife",
      legalComments: "none",
      logLevel: "silent",
      minify: true,
      outfile: clientKernelPath,
      platform: "browser",
      plugins: [
        createStaticServerFunctionsPlugin(),
        createClientEntriesPlugin(),
        createRscWebpackRuntimePlugin(),
        createStartEnvironmentPlugin("client"),
      ],
      stdin: {
        contents: clientEntry,
        loader: "js",
        resolveDir: process.cwd(),
        sourcefile: "tuto-tanstack-start-client-kernel.js",
      },
      target: ["es2022"],
      write: false,
    }),
    build({
      absWorkingDir: process.cwd(),
      banner: {
        js: "import { createRequire as __tutoCreateRequire } from 'node:module'; const require = __tutoCreateRequire(import.meta.url);",
      },
      bundle: true,
      charset: "utf8",
      define: {
        "process.env.NODE_ENV": '"production"',
        // Start only honors X-TSS_SHELL in a prerender-aware server build.
        // Without that private request header, the normal SSR path is unchanged.
        "process.env.TSS_PRERENDERING": '"true"',
        "process.env.TSS_SERVER_FN_BASE": JSON.stringify(serverFnInternalBase),
        "process.env.TSS_SHELL": '"false"',
      },
      format: "esm",
      legalComments: "none",
      logLevel: "silent",
      minify: true,
      outfile: serverKernelPath,
      platform: "node",
      plugins: [
        createStaticServerFunctionsPlugin(),
        createServerResolverPlugin(),
        createServerEntriesPlugin(),
        createRscWebpackRuntimePlugin(),
        createStartEnvironmentPlugin("server"),
      ],
      stdin: {
        contents: serverEntry,
        loader: "js",
        resolveDir: process.cwd(),
        sourcefile: "tuto-tanstack-start-server-kernel.js",
      },
      target: ["node22"],
      write: false,
    }),
  ]);
  const clientCode = clientBuild.outputFiles[0].text;
  const rscCode = rscBuild.outputFiles[0].text;
  const serverCode = serverBuild.outputFiles[0].text;
  const previousServerKernel = globalThis[serverGlobalKey];
  globalThis[serverGlobalKey] = {
    modules: {
      "@tanstack/react-start/server": await import(
        "@tanstack/react-start/server"
      ),
      "@tanstack/start-storage-context": await import(
        "@tanstack/start-storage-context"
      ),
    },
  };
  try {
    await import(
      `data:text/javascript;base64,${Buffer.from(rscCode).toString("base64")}#${id}`
    );
  } catch (error) {
    throw new Error(
      `Unable to inspect the generated RSC kernel: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const rscKernel = globalThis[rscGlobalKey];
  const rscExports = Object.fromEntries(
    rscModules.map((specifier) => [
      specifier,
      Object.keys(rscKernel.modules[specifier]).sort(),
    ]),
  );
  delete globalThis[rscGlobalKey];
  if (previousServerKernel === undefined) delete globalThis[serverGlobalKey];
  else globalThis[serverGlobalKey] = previousServerKernel;
  if (clientCode.includes("process.env.")) {
    throw new Error(
      "The TanStack Start client kernel contains an unresolved process.env reference.",
    );
  }
  const manifest = {
    id,
    client: {
      bytes: Buffer.byteLength(clientCode),
      exports: clientExports,
      file: path.basename(clientKernelPath),
      globalKey: clientGlobalKey,
      rscLoaderKey: clientRscLoaderKey,
      modules: clientModules,
      routerKey: clientRouterKey,
      serverFnBaseKey: clientServerFnBaseKey,
      startInstanceKey: clientStartInstanceKey,
      url: `/api/serverless/tanstack-start/kernel/client?v=${id}`,
    },
    packages,
    rsc: {
      actionInternalPath: rscActionInternalPath,
      actionEncryptionKeyGlobalKey: rscActionEncryptionKeyGlobalKey,
      bytes: Buffer.byteLength(rscCode),
      clientReferences: Object.fromEntries(
        frameworkRscEntries.map(({ moduleKey, reference }) => [
          reference,
          moduleKey,
        ]),
      ),
      exports: rscExports,
      file: path.basename(rscKernelPath),
      globalKey: rscGlobalKey,
      handlerKey: rscHandlerKey,
      internalPath: rscInternalPath,
      modules: rscModules,
    },
    server: {
      bytes: Buffer.byteLength(serverCode),
      exports: serverExports,
      file: path.basename(serverKernelPath),
      globalKey: serverGlobalKey,
      handlerKey: serverHandlerKey,
      modules: serverModules,
      resolverKey: serverResolverKey,
      routerKey: serverRouterKey,
      manifestKey: serverManifestKey,
      serverFnBase: serverFnInternalBase,
      rscLoaderKey: serverRscLoaderKey,
      startInstanceKey: serverStartInstanceKey,
    },
  };

  await Promise.all([
    writeFile(clientKernelPath, clientCode, "utf8"),
    writeFile(rscKernelPath, rscCode, "utf8"),
    writeFile(serverKernelPath, serverCode, "utf8"),
    writeFile(
      `${manifestPath}`,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
  ]);

  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = await buildTanstackStartKernels();
  process.stdout.write(
    `Built TanStack Start kernel ${manifest.id} (${manifest.client.bytes} client bytes, ${manifest.server.bytes} server bytes, ${manifest.rsc.bytes} RSC bytes).\n`,
  );
}
