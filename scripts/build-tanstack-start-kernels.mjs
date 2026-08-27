import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const {
  importStartCompilerInternals,
} = require("../lib/serverless-tanstack-start/server-functions-transform.generated.cjs");

const outputRoot = path.resolve("lib/serverless-tanstack-start");
const manifestPath = path.join(outputRoot, "kernel-manifest.generated.json");
const clientKernelPath = path.join(outputRoot, "client-kernel.generated.js");
const serverKernelPath = path.join(outputRoot, "server-kernel.generated.mjs");
const clientGlobalKey = "__TUTO_TANSTACK_START_CLIENT_KERNEL__";
const clientServerFnBaseKey = "__TUTO_TANSTACK_START_SERVER_FN_BASE__";
const clientRouterKey = "__TUTO_TANSTACK_START_CLIENT_ROUTER_FACTORY__";
const clientStartInstanceKey = "__TUTO_TANSTACK_START_CLIENT_INSTANCE__";
const serverGlobalKey = "__TUTO_TANSTACK_START_SERVER_KERNEL__";
const serverHandlerKey = "__TUTO_TANSTACK_START_NATIVE_HANDLER__";
const serverResolverKey = "__TUTO_TANSTACK_START_SERVER_FN_RESOLVER__";
const serverStartInstanceKey = "__TUTO_TANSTACK_START_INSTANCE__";
const serverRouterKey = "__TUTO_TANSTACK_START_ROUTER_FACTORY__";
const serverManifestKey = "__TUTO_TANSTACK_START_MANIFEST__";
const serverFnInternalBase = "/__tuto_server_fn/";

const clientModules = [
  "@tanstack/react-start",
  "@tanstack/react-start/client",
  "@tanstack/react-start/client-rpc",
  "@tanstack/react-router",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
];
const serverModules = [
  "@tanstack/react-router",
  "@tanstack/react-start",
  "@tanstack/react-start/server",
  "@tanstack/react-start/server-rpc",
  "react",
  "react/jsx-runtime",
  "react-dom/server",
];

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
            /node_modules[\\/]@tanstack[\\/](?:start-client-core|start-fn-stubs|start-storage-context)[\\/].*\.js$/,
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
              contents:
                "export const hasPluginAdapters = false; export const pluginSerializationAdapters = [];",
              loader: "js",
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
              contents:
                "export const hasPluginAdapters = false; export const pluginSerializationAdapters = [];",
              loader: "js",
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

function packageVersion(packageName) {
  return require(`${packageName}/package.json`).version;
}

export async function buildTanstackStartKernels() {
  const packages = {
    "@tanstack/react-router": packageVersion("@tanstack/react-router"),
    "@tanstack/react-start": packageVersion("@tanstack/react-start"),
    "@tanstack/start-plugin-core": packageVersion(
      "@tanstack/start-plugin-core",
    ),
    "@tanstack/start-server-core": packageVersion(
      "@tanstack/start-server-core",
    ),
    react: packageVersion("react"),
    "react-dom": packageVersion("react-dom"),
  };
  const id = createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .update(JSON.stringify({ clientModules, packages, serverModules }))
    .digest("hex")
    .slice(0, 20);
  const [clientExports, serverExports] = await Promise.all([
    moduleExports(clientModules),
    moduleExports(serverModules),
  ]);
  const clientEntry = `${moduleImports(clientModules)}
globalThis.${clientGlobalKey} = Object.freeze({
  id: ${JSON.stringify(id)},
  modules: Object.freeze({ ${moduleMap(clientModules)} }),
});`;
  const serverEntry = `${moduleImports(serverModules)}
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';

const modules = Object.freeze({ ${moduleMap(serverModules)} });
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
        createClientEntriesPlugin(),
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
        "process.env.TSS_SERVER_FN_BASE": JSON.stringify(serverFnInternalBase),
      },
      format: "esm",
      legalComments: "none",
      logLevel: "silent",
      minify: true,
      outfile: serverKernelPath,
      platform: "node",
      plugins: [
        createServerResolverPlugin(),
        createServerEntriesPlugin(),
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
  const serverCode = serverBuild.outputFiles[0].text;
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
      modules: clientModules,
      routerKey: clientRouterKey,
      serverFnBaseKey: clientServerFnBaseKey,
      startInstanceKey: clientStartInstanceKey,
      url: `/api/serverless/tanstack-start/kernel/client?v=${id}`,
    },
    packages,
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
      startInstanceKey: serverStartInstanceKey,
    },
  };

  await Promise.all([
    writeFile(clientKernelPath, clientCode, "utf8"),
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
    `Built TanStack Start kernel ${manifest.id} (${manifest.client.bytes} client bytes, ${manifest.server.bytes} server bytes).\n`,
  );
}
