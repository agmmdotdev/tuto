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
const serverGlobalKey = "__TUTO_TANSTACK_START_SERVER_KERNEL__";
const serverHandlerKey = "__TUTO_TANSTACK_START_NATIVE_HANDLER__";
const serverResolverKey = "__TUTO_TANSTACK_START_SERVER_FN_RESOLVER__";

const clientModules = [
  "@tanstack/react-start",
  "@tanstack/react-start/client-rpc",
  "@tanstack/react-router",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
];
const serverModules = [
  "@tanstack/react-start",
  "@tanstack/react-start/server-rpc",
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

function createServerHostPlugin(serverFunctionsHandlerPath) {
  return {
    name: "tuto-start-server-kernel-host",
    setup(buildApi) {
      buildApi.onResolve(
        { filter: /^\.\/request-response(?:\.js)?$/ },
        (args) => {
          const importer = path.resolve(
            path.dirname(args.importer),
            "server-functions-handler.js",
          );
          return importer === serverFunctionsHandlerPath
            ? {
                path: "tuto-request-response-host",
                namespace: "tuto-server-kernel-host",
              }
            : null;
        },
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-server-kernel-host" },
        () => ({
          contents:
            "const response = { status: 200, statusText: '' }; export function getResponse() { return response; }",
          loader: "js",
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
  const startServerCoreRoot = path.dirname(
    require.resolve("@tanstack/start-server-core/package.json"),
  );
  const serverFunctionsHandlerPath = path.join(
    startServerCoreRoot,
    "dist",
    "esm",
    "server-functions-handler.js",
  );
  const clientEntry = `${moduleImports(clientModules)}
globalThis.${clientGlobalKey} = Object.freeze({
  id: ${JSON.stringify(id)},
  modules: Object.freeze({ ${moduleMap(clientModules)} }),
});`;
  const serverEntry = `${moduleImports(serverModules)}
import { runWithStartContext } from '@tanstack/start-storage-context';
import { handleServerAction } from ${JSON.stringify(serverFunctionsHandlerPath)};

const modules = Object.freeze({ ${moduleMap(serverModules)} });
globalThis.${serverGlobalKey} = Object.freeze({
  id: ${JSON.stringify(id)},
  modules,
});
globalThis.${serverHandlerKey} = async (request, requestOptions = {}) => {
  const serverFnId = new URL(request.url).searchParams.get('id');
  if (!serverFnId) return new Response('Missing server function id.', { status: 400 });
  return runWithStartContext({
    getRouter: async () => { throw new Error('Router access is unavailable in the CSR tier.'); },
    request,
    startOptions: {},
    contextAfterGlobalMiddlewares: {},
    executedRequestMiddlewares: new Set(),
    handlerType: 'serverFn',
  }, () => handleServerAction({
    request,
    context: requestOptions.context || {},
    serverFnId,
  }));
};`;

  const [clientBuild, serverBuild] = await Promise.all([
    build({
      absWorkingDir: process.cwd(),
      bundle: true,
      charset: "utf8",
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.TSS_SERVER_FN_BASE": `globalThis.${clientServerFnBaseKey}`,
      },
      format: "iife",
      legalComments: "none",
      logLevel: "silent",
      minify: true,
      outfile: clientKernelPath,
      platform: "browser",
      plugins: [createStartEnvironmentPlugin("client")],
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
      bundle: true,
      charset: "utf8",
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.TSS_SERVER_FN_BASE":
          '"/api/serverless/tanstack-start/core-rpc"',
      },
      format: "esm",
      legalComments: "none",
      logLevel: "silent",
      minify: true,
      outfile: serverKernelPath,
      platform: "node",
      plugins: [
        createServerResolverPlugin(),
        createServerHostPlugin(serverFunctionsHandlerPath),
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
  const manifest = {
    id,
    client: {
      bytes: Buffer.byteLength(clientCode),
      exports: clientExports,
      file: path.basename(clientKernelPath),
      globalKey: clientGlobalKey,
      modules: clientModules,
      serverFnBaseKey: clientServerFnBaseKey,
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
