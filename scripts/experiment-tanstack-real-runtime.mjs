import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const {
  importStartCompilerInternals,
  transformStartServerFunctions,
  toWorkspaceModuleId,
} = require("../lib/serverless-tanstack-start/server-functions-transform.generated.cjs");

const workspaceRoot = path.join(
  process.cwd(),
  ".tmp",
  "tanstack-real-runtime-experiment",
);
const clientResultKey = "__tutoRealRuntimeResult";
const clientPromiseKey = "__tutoRealRuntimePromise";
const serverHandlerKey = "__tutoRealRuntimeServerHandler";
const debug = (message) => {
  if (process.env.TUTO_EXPERIMENT_DEBUG === "1") {
    process.stderr.write(`[real-runtime] ${message}\n`);
  }
};
const sourceFiles = new Map([
  [
    "src/actions.ts",
    `import { createMiddleware, createServerFn } from '@tanstack/react-start';

const requestContext = createMiddleware({ type: 'function' }).server(
  async ({ next }) => next({ context: { source: 'real-start-middleware' } }),
);

export const greet = createServerFn({ method: 'POST' })
  .middleware([requestContext])
  .inputValidator((data) => ({ name: String(data.name).trim() }))
  .handler(async ({ data, context }) => ({
    message: 'Hello ' + data.name,
    source: context.source,
  }));
`,
  ],
]);

function loaderForPath(filePath) {
  const extension = path.extname(filePath.split("?")[0]).toLowerCase();

  if (extension === ".tsx") return "tsx";
  if (extension === ".ts") return "ts";
  if (extension === ".jsx") return "jsx";
  if (extension === ".json") return "json";
  return "js";
}

function normalizeWorkspacePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function findWorkspaceFile(files, candidatePath) {
  const normalized = normalizeWorkspacePath(candidatePath);
  const queryIndex = normalized.indexOf("?");
  const query = queryIndex === -1 ? "" : normalized.slice(queryIndex);
  const cleanPath =
    queryIndex === -1 ? normalized : normalized.slice(0, queryIndex);
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".json"];

  for (const extension of extensions) {
    const directPath =
      extension && cleanPath.endsWith(extension)
        ? cleanPath
        : `${cleanPath}${extension}`;
    const candidate = `${directPath}${query}`;
    if (files.has(candidate)) return candidate;
  }

  return null;
}

function resolveWorkspaceImport(files, source, importer) {
  if (!source.startsWith(".")) return null;
  const importerPath = importer.split("?")[0];
  const candidate = path.posix.normalize(
    path.posix.join(path.posix.dirname(importerPath), source),
  );
  return findWorkspaceFile(files, candidate);
}

function createStartEnvironmentPlugin(env) {
  let compilerPromise;
  const serverFnsById = {};

  async function resolveCompilerModule(source, importer) {
    if (source.startsWith(".")) {
      return path.resolve(path.dirname(importer), source);
    }

    const parentUrl = importer
      ? pathToFileURL(importer).href
      : pathToFileURL(`${process.cwd()}${path.sep}`).href;
    const resolved = import.meta.resolve(source, parentUrl);
    return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
  }

  async function getCompiler() {
    if (!compilerPromise) {
      compilerPromise = (async () => {
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
    }

    return compilerPromise;
  }

  return {
    name: `tuto-real-start-${env}-environment`,
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

function createStartServerHostPlugin(serverFunctionsHandlerPath) {
  return {
    name: "tuto-real-start-server-host",
    setup(buildApi) {
      buildApi.onResolve(
        { filter: /^\.\/request-response(?:\.js)?$/ },
        (args) => {
          const importer = path.resolve(
            path.dirname(args.importer),
            "server-functions-handler.js",
          );
          if (importer !== serverFunctionsHandlerPath) {
            return null;
          }
          return {
            path: "tuto-request-response-host",
            namespace: "tuto-server-host",
          };
        },
      );
      buildApi.onLoad({ filter: /.*/, namespace: "tuto-server-host" }, () => ({
        contents: `
const response = { status: 200, statusText: '' };
export function getResponse() { return response; }
`,
        loader: "js",
      }));
    },
  };
}

function createWorkspacePlugin({ files, entries = new Map(), resolverSource }) {
  return {
    name: "tuto-real-runtime-workspace",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^__tuto_client_entry__$/ }, () => ({
        path: "__tuto_client_entry__",
        namespace: "tuto-entry",
      }));
      buildApi.onResolve({ filter: /^__tuto_server_entry__$/ }, () => ({
        path: "__tuto_server_entry__",
        namespace: "tuto-entry",
      }));
      buildApi.onResolve(
        { filter: /^#tanstack-start-server-fn-resolver$/ },
        () => ({
          path: "#tanstack-start-server-fn-resolver",
          namespace: "tuto-resolver",
        }),
      );
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point" && entries.has(args.path)) {
          return { path: args.path, namespace: "tuto-entry" };
        }

        if (files.has(args.path)) {
          return { path: args.path, namespace: "tuto-workspace" };
        }

        if (
          args.namespace === "tuto-workspace" ||
          args.namespace === "tuto-resolver" ||
          args.namespace === "tuto-entry"
        ) {
          const match = resolveWorkspaceImport(files, args.path, args.importer);
          if (match) return { path: match, namespace: "tuto-workspace" };
        }

        return null;
      });
      buildApi.onLoad({ filter: /.*/, namespace: "tuto-entry" }, (args) => ({
        contents: entries.get(args.path),
        loader: "js",
        resolveDir: process.cwd(),
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "tuto-resolver" }, () => ({
        contents: resolverSource,
        loader: "js",
        resolveDir: process.cwd(),
      }));
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-workspace" },
        (args) => ({
          contents: files.get(args.path),
          loader: loaderForPath(args.path),
          resolveDir: process.cwd(),
        }),
      );
    },
  };
}

function importOutput(output) {
  const dataUrl = `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
  return import(dataUrl);
}

function hasInput(result, packageName) {
  return Object.keys(result.metafile.inputs).some((input) =>
    input.replaceAll("\\", "/").includes(`/node_modules/${packageName}/`),
  );
}

function hasInputFile(result, packagePath) {
  return Object.keys(result.metafile.inputs).some((input) =>
    input.replaceAll("\\", "/").includes(`/node_modules/${packagePath}`),
  );
}

const transformStartedAt = performance.now();
debug("transforming student server function");
const transform = await transformStartServerFunctions(sourceFiles, {
  root: workspaceRoot,
});
const transformMs = performance.now() - transformStartedAt;
const [serverFnId] = Object.keys(transform.serverFnsById);

assert.ok(
  serverFnId,
  "the Start compiler did not find the experiment server function",
);
const serverFn = transform.serverFnsById[serverFnId];
const splitModuleId = toWorkspaceModuleId(
  workspaceRoot,
  serverFn.extractedFilename,
);
const splitSource = transform.serverSplits.get(splitModuleId);
assert.ok(splitSource, "the Start compiler did not create a server split");

const startServerCoreRoot = path.dirname(
  require.resolve("@tanstack/start-server-core/package.json"),
);
const serverFunctionsHandlerPath = path.join(
  startServerCoreRoot,
  "dist",
  "esm",
  "server-functions-handler.js",
);
const serverFiles = new Map(transform.serverFiles);
serverFiles.set(splitModuleId, splitSource);
const resolverSource = `
import { ${serverFn.functionName} as action } from ${JSON.stringify(splitModuleId)};
export async function getServerFnById(id) {
  if (id !== ${JSON.stringify(serverFnId)}) {
    throw new Error('Unknown server function: ' + id);
  }
  return action;
}
`;
const serverEntry = `
import { runWithStartContext } from '@tanstack/start-storage-context';
import { handleServerAction } from ${JSON.stringify(serverFunctionsHandlerPath)};

globalThis.${serverHandlerKey} = async (request, requestOptions) => {
  const serverFnId = new URL(request.url).pathname.split('/').filter(Boolean).at(-1);
  return runWithStartContext({
    getRouter: async () => { throw new Error('Router access is outside this experiment'); },
    request,
    startOptions: {},
    contextAfterGlobalMiddlewares: {},
    executedRequestMiddlewares: new Set(),
    handlerType: 'serverFn',
  }, () => handleServerAction({
    request,
    context: requestOptions?.context || {},
    serverFnId,
  }));
};
`;

const serverBuildStartedAt = performance.now();
debug("building real Start server runtime");
const serverBuild = await build({
  absWorkingDir: process.cwd(),
  bundle: true,
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.TSS_SERVER_FN_BASE": '"http://tuto.local/server-fn/"',
  },
  entryPoints: ["__tuto_server_entry__"],
  format: "esm",
  logLevel: process.env.TUTO_EXPERIMENT_DEBUG === "1" ? "debug" : "silent",
  metafile: true,
  platform: "node",
  plugins: [
    createStartServerHostPlugin(serverFunctionsHandlerPath),
    createStartEnvironmentPlugin("server"),
    createWorkspacePlugin({
      files: serverFiles,
      entries: new Map([["__tuto_server_entry__", serverEntry]]),
      resolverSource,
    }),
  ],
  target: ["node22"],
  write: false,
});
const serverBuildMs = performance.now() - serverBuildStartedAt;
const serverOutput =
  serverBuild.outputFiles.find((file) => file.path.endsWith(".js")) ??
  serverBuild.outputFiles[0];
assert.ok(serverOutput, "the real Start server build produced no JavaScript");
debug("loading real Start server runtime");
await importOutput(serverOutput.text);

const serverHandler = globalThis[serverHandlerKey];
assert.equal(
  typeof serverHandler,
  "function",
  "the real Start server handler was not installed",
);

const clientFiles = new Map(transform.clientFiles);
const clientEntry = `
import { greet } from './src/actions.ts';
globalThis.${clientPromiseKey} = greet({ data: { name: '  Aung  ' } }).then((value) => {
  globalThis.${clientResultKey} = value;
  return value;
});
`;
const clientBuildStartedAt = performance.now();
debug("building real Start client runtime");
const clientBuild = await build({
  absWorkingDir: process.cwd(),
  bundle: true,
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.TSS_SERVER_FN_BASE": '"http://tuto.local/server-fn/"',
  },
  entryPoints: ["__tuto_client_entry__"],
  format: "esm",
  logLevel: process.env.TUTO_EXPERIMENT_DEBUG === "1" ? "debug" : "silent",
  metafile: true,
  platform: "browser",
  plugins: [
    createStartEnvironmentPlugin("client"),
    createWorkspacePlugin({
      files: clientFiles,
      entries: new Map([["__tuto_client_entry__", clientEntry]]),
      resolverSource: "",
    }),
  ],
  target: ["es2022"],
  write: false,
});
const clientBuildMs = performance.now() - clientBuildStartedAt;
const clientOutput =
  clientBuild.outputFiles.find((file) => file.path.endsWith(".js")) ??
  clientBuild.outputFiles[0];
assert.ok(clientOutput, "the real Start client build produced no JavaScript");

let transportCalls = 0;
globalThis.window = globalThis;
globalThis.window.__TSS_START_OPTIONS__ = {
  serverFns: {
    fetch: async (input, init) => {
      transportCalls += 1;
      return serverHandler(new Request(input, init), { context: {} });
    },
  },
};

const roundTripStartedAt = performance.now();
debug("executing native Start RPC round trip");
await importOutput(clientOutput.text);
await globalThis[clientPromiseKey];
const roundTripMs = performance.now() - roundTripStartedAt;

assert.deepEqual(globalThis[clientResultKey], {
  message: "Hello Aung",
  source: "real-start-middleware",
});
assert.equal(transportCalls, 1);
assert.equal(
  hasInputFile(clientBuild, "@tanstack/react-start/dist/esm/index.js"),
  true,
);
assert.equal(
  hasInputFile(serverBuild, "@tanstack/react-start/dist/esm/server-rpc.js"),
  true,
);
assert.equal(hasInput(clientBuild, "@tanstack/start-client-core"), true);
assert.equal(hasInput(serverBuild, "@tanstack/start-server-core"), true);

const summary = {
  success: true,
  serverFnId,
  result: globalThis[clientResultKey],
  transportCalls,
  officialEntrypoints: {
    client: hasInputFile(
      clientBuild,
      "@tanstack/react-start/dist/esm/index.js",
    ),
    serverRpc: hasInputFile(
      serverBuild,
      "@tanstack/react-start/dist/esm/server-rpc.js",
    ),
  },
  realRuntimeInputs: {
    client: hasInput(clientBuild, "@tanstack/start-client-core"),
    server: hasInput(serverBuild, "@tanstack/start-server-core"),
  },
  timingsMs: {
    transform: Number(transformMs.toFixed(2)),
    clientBuild: Number(clientBuildMs.toFixed(2)),
    serverBuild: Number(serverBuildMs.toFixed(2)),
    roundTrip: Number(roundTripMs.toFixed(2)),
  },
  bundleBytes: {
    client: clientOutput.contents.byteLength,
    server: serverOutput.contents.byteLength,
  },
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

delete globalThis[clientPromiseKey];
delete globalThis[clientResultKey];
delete globalThis[serverHandlerKey];
