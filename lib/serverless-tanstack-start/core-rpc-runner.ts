import { randomUUID } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
import type { Loader, OnLoadArgs, OnResolveArgs, PluginBuild } from "esbuild";
import {
  toWorkspaceModuleId,
  transformStartServerFunctions,
} from "./server-functions-transform";

type BuildDiagnosticLevel = "info" | "warning" | "error";

type BuildDiagnostic = {
  id: string;
  level: BuildDiagnosticLevel;
  message: string;
  timestamp: string;
};

type WorkspaceFileInput = {
  path: string;
  content: string;
};

type WorkspaceFileMap = Map<string, string>;

type SerializedFormDataStringEntry = {
  kind: "string";
  value: string;
};

type SerializedFormDataFileEntry = {
  kind: "file";
  name?: string;
  text?: string;
  type?: string;
};

type SerializedFormData = {
  __tutoType: "FormData";
  entries: Array<
    [string, SerializedFormDataStringEntry | SerializedFormDataFileEntry]
  >;
};

type SerializedResponse = {
  __tutoType: "Response";
  body: string;
  headers: Record<string, string>;
  status: number;
  statusText: string;
};

type SerializedRedirectControl = {
  type: "redirect";
  headers: Record<string, string>;
  href?: string;
  options: Record<string, unknown>;
  status: number;
};

type SerializedNotFoundControl = {
  type: "notFound";
  data?: unknown;
  headers?: Record<string, string>;
  routeId?: string;
};

type SerializedRpcControl = SerializedRedirectControl | SerializedNotFoundControl;

type RpcJsonValue =
  | null
  | string
  | number
  | boolean
  | SerializedFormData
  | SerializedResponse
  | RpcJsonValue[]
  | { [key: string]: RpcJsonValue };

type CoreRpcInput = {
  id?: string;
  payload?: RpcJsonValue;
  files?: WorkspaceFileInput[];
};

type ServerActionResult = {
  result?: unknown;
  context?: unknown;
  error?: unknown;
};

type CoreRpcSuccess = {
  success: true;
  result: unknown;
  context: unknown;
  diagnostics: BuildDiagnostic[];
};

type CoreRpcFailure = {
  success: false;
  control?: SerializedRpcControl;
  error: string;
  diagnostics: BuildDiagnostic[];
};

const resultStartMarker = "__TUTO_TANSTACK_START_CORE_RPC_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_RPC_RESULT_END__";
const maxFileCount = 64;
const maxFileSize = 220_000;
const maxTotalSize = 1_250_000;
const absoluteWorkingDirectory = process.cwd();
const globalResultStore = globalThis as typeof globalThis & Record<string, unknown>;

function createDiagnostic(
  level: BuildDiagnosticLevel,
  message: string,
): BuildDiagnostic {
  return {
    id: randomUUID(),
    level,
    message,
    timestamp: new Date().toISOString(),
  };
}

function normalizeWorkspacePath(filePath: string) {
  return filePath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function sanitizeWorkspaceFiles(files: unknown): WorkspaceFileMap {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("At least one file is required.");
  }

  if (files.length > maxFileCount) {
    throw new Error("Too many files for the TanStack Start core RPC runner.");
  }

  const map: WorkspaceFileMap = new Map();
  let totalSize = 0;

  for (const file of files as WorkspaceFileInput[]) {
    const normalizedPath = normalizeWorkspacePath(file.path);

    if (
      !normalizedPath ||
      normalizedPath.includes("..") ||
      normalizedPath.startsWith(".") ||
      path.posix.isAbsolute(normalizedPath)
    ) {
      throw new Error(`Unsupported file path: ${file.path}`);
    }

    if (typeof file.content !== "string") {
      throw new Error(`Unsupported file content for ${normalizedPath}.`);
    }

    if (file.content.length > maxFileSize) {
      throw new Error(`File is too large: ${normalizedPath}`);
    }

    totalSize += file.content.length;

    if (totalSize > maxTotalSize) {
      throw new Error("Workspace snapshot is too large for the TanStack Start core RPC runner.");
    }

    map.set(normalizedPath, file.content);
  }

  return map;
}

function loaderForPath(filePath: string): Loader {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".ts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
      return "js";
    case ".jsx":
      return "jsx";
    case ".json":
      return "json";
    default:
      return "text";
  }
}

function findWorkspaceFile(files: WorkspaceFileMap, candidatePath: string) {
  const normalized = normalizeWorkspacePath(candidatePath);
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".json"];

  if (files.has(normalized)) return normalized;

  for (const extension of extensions) {
    const directPath =
      extension && normalized.endsWith(extension) ? normalized : `${normalized}${extension}`;

    if (files.has(directPath)) return directPath;
  }

  return null;
}

function resolveWorkspaceImport(
  files: WorkspaceFileMap,
  source: string,
  importerPath: string,
) {
  if (!source.startsWith(".")) return null;

  const baseDir = importerPath
    ? path.posix.dirname(importerPath.replaceAll("\\", "/"))
    : "";

  return findWorkspaceFile(files, path.posix.normalize(path.posix.join(baseDir, source)));
}

function isSerializedFormData(value: unknown): value is SerializedFormData {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __tutoType?: unknown }).__tutoType === "FormData" &&
    Array.isArray((value as { entries?: unknown }).entries)
  );
}

function reviveRpcValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;

  if (isSerializedFormData(value)) {
    const formData = new FormData();

    for (const [name, entry] of value.entries) {
      if (entry.kind === "file") {
        const blob = new Blob([entry.text ?? ""], {
          type: entry.type || "application/octet-stream",
        });
        formData.append(name, blob, entry.name || "file");
        continue;
      }

      formData.append(name, entry.value);
    }

    return formData;
  }

  if (Array.isArray(value)) return value.map(reviveRpcValue);

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [key, reviveRpcValue(nestedValue)]),
  );
}

async function serializeRpcValue(value: unknown): Promise<unknown> {
  if (typeof Response !== "undefined" && value instanceof Response) {
    return {
      __tutoType: "Response",
      body: await value.text(),
      headers: Object.fromEntries(value.headers.entries()),
      status: value.status,
      statusText: value.statusText,
    } satisfies SerializedResponse;
  }

  return value;
}

function isRedirectControlValue(value: unknown): value is Response & {
  options: Record<string, unknown>;
} {
  return (
    typeof Response !== "undefined" &&
    value instanceof Response &&
    typeof (value as { options?: unknown }).options === "object" &&
    (value as { options?: unknown }).options !== null
  );
}

function isNotFoundControlValue(value: unknown): value is {
  data?: unknown;
  headers?: HeadersInit;
  isNotFound: true;
  routeId?: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { isNotFound?: unknown }).isNotFound === true
  );
}

function serializeHeaders(headers: HeadersInit | undefined) {
  return Object.fromEntries(new Headers(headers).entries());
}

function serializeRedirectOptions(options: Record<string, unknown>) {
  const serialized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(options)) {
    if (
      typeof value === "undefined" ||
      key === "headers" ||
      key === "throw" ||
      key.startsWith("_")
    ) {
      continue;
    }

    serialized[key] = value;
  }

  if (typeof serialized.reloadDocument === "undefined") {
    serialized.reloadDocument = false;
  }

  return serialized;
}

function serializeRpcControl(value: unknown): SerializedRpcControl | null {
  if (isRedirectControlValue(value)) {
    return {
      type: "redirect",
      href:
        typeof value.options.href === "string"
          ? value.options.href
          : value.headers.get("location") ?? undefined,
      options: serializeRedirectOptions(value.options),
      headers: serializeHeaders(value.headers),
      status: value.status,
    };
  }

  if (isNotFoundControlValue(value)) {
    const headers = serializeHeaders(value.headers);

    return {
      type: "notFound",
      ...(typeof value.data === "undefined" ? {} : { data: value.data }),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(typeof value.routeId === "string" ? { routeId: value.routeId } : {}),
    };
  }

  return null;
}

function createReactStartRpcShim() {
  return `function flattenMiddleware(middlewares = [], seen = new Set()) {
  const flattened = [];
  for (const middleware of middlewares) {
    if (!middleware || seen.has(middleware)) continue;
    seen.add(middleware);
    if (middleware.options?.middleware) {
      flattened.push(...flattenMiddleware(middleware.options.middleware, seen));
    }
    flattened.push(middleware);
  }
  return flattened;
}
function isRedirectValue(value) {
  return typeof Response !== "undefined" && value instanceof Response && !!value.options;
}
async function runServerMiddleware(middlewares, initialState) {
  const stack = flattenMiddleware(middlewares);
  async function dispatch(index, state) {
    if (index >= stack.length) {
      return { data: state.data, context: state.context };
    }
    const middleware = stack[index];
    const options = middleware.options || {};
    let data = state.data;
    if (options.inputValidator) data = await options.inputValidator(data);
    if (!options.server) {
      return dispatch(index + 1, { ...state, data });
    }
    const next = async (nextOptions = {}) => {
      const nextState = {
        ...state,
        data: Object.prototype.hasOwnProperty.call(nextOptions, "data") ? nextOptions.data : data,
        context: { ...state.context, ...(nextOptions.context || {}) },
      };
      return dispatch(index + 1, nextState);
    };
    const result = await options.server({ ...state, data, context: state.context, next });
    if (isRedirectValue(result)) {
      return { error: result, context: state.context };
    }
    if (typeof Response !== "undefined" && result instanceof Response) {
      return { result, context: state.context };
    }
    if (typeof result === "undefined") {
      throw new Error("User middleware returned undefined. You must call next() or return a result in your middlewares.");
    }
    if (Object.prototype.hasOwnProperty.call(result, "error")) {
      return {
        error: result.error,
        context: { ...state.context, ...(result.context || {}) },
      };
    }
    if (Object.prototype.hasOwnProperty.call(result, "result")) {
      return {
        result: result.result,
        context: { ...state.context, ...(result.context || {}) },
      };
    }
    return {
      data: Object.prototype.hasOwnProperty.call(result, "data") ? result.data : data,
      context: { ...state.context, ...(result.context || {}) },
    };
  }
  return dispatch(0, initialState);
}
export function createMiddleware(options = {}, __opts) {
  const resolvedOptions = __opts || options || {};
  return {
    options: resolvedOptions,
    middleware: (middleware) => createMiddleware(undefined, {
      ...resolvedOptions,
      middleware: [...(resolvedOptions.middleware || []), ...middleware],
    }),
    inputValidator: (inputValidator) => createMiddleware(undefined, { ...resolvedOptions, inputValidator }),
    validator: (inputValidator) => createMiddleware(undefined, { ...resolvedOptions, inputValidator }),
    client: (client) => createMiddleware(undefined, { ...resolvedOptions, client }),
    server: (server) => createMiddleware(undefined, { ...resolvedOptions, server }),
  };
}
export function createServerFn(options = {}, __opts) {
  const resolvedOptions = __opts || options || {};
  if (typeof resolvedOptions.method === "undefined") resolvedOptions.method = "GET";
  const builder = (nextOptions = {}) => createServerFn(undefined, { ...resolvedOptions, ...nextOptions });
  builder.middleware = (middleware) => createServerFn(undefined, { ...resolvedOptions, middleware: [...(resolvedOptions.middleware || []), ...middleware] });
  builder.inputValidator = (inputValidator) => createServerFn(undefined, { ...resolvedOptions, inputValidator });
  builder.handler = (extractedFn, serverFn) => {
    const run = async (opts = {}) => {
      try {
        let data = opts.data;
        if (resolvedOptions.inputValidator) data = await resolvedOptions.inputValidator(data);
        const middlewareResult = await runServerMiddleware(resolvedOptions.middleware, {
          ...opts,
          data,
          context: opts.context || {},
          method: resolvedOptions.method,
        });
        if (middlewareResult.error) {
          return { error: middlewareResult.error, context: middlewareResult.context || {} };
        }
        if (Object.prototype.hasOwnProperty.call(middlewareResult, "result")) {
          return { result: middlewareResult.result, context: middlewareResult.context || {} };
        }
        const result = await serverFn({
          ...opts,
          data: middlewareResult.data,
          context: middlewareResult.context,
          method: resolvedOptions.method,
        });
        return { result, context: middlewareResult.context };
      } catch (error) {
        return { error, context: {} };
      }
    };
    return Object.assign(async (opts) => (await run(opts)).result, extractedFn, {
      method: resolvedOptions.method,
      __executeServer: run,
    });
  };
  return builder;
}`;
}

function onResolveWorkspaceModule(
  fileMap: WorkspaceFileMap,
  serverSplits: WorkspaceFileMap,
  args: OnResolveArgs,
) {
  if (serverSplits.has(args.path)) {
    return { path: args.path, namespace: "server-split" };
  }

  const workspaceMatch =
    args.namespace === "server-split" || args.namespace === "workspace"
      ? resolveWorkspaceImport(fileMap, args.path, args.importer)
      : null;

  if (workspaceMatch) return { path: workspaceMatch, namespace: "workspace" };

  return null;
}

async function executeServerFn({ id, payload, files }: CoreRpcInput) {
  if (!id) throw new Error("Server function id is required.");

  const fileMap = sanitizeWorkspaceFiles(files);
  const root = path.join(absoluteWorkingDirectory, ".tmp", "tanstack-start-core");
  const { serverFnsById, serverSplits } = await transformStartServerFunctions(fileMap, {
    root,
  });
  const serverFn = serverFnsById[id];

  if (!serverFn) {
    throw new Error(`Unknown server function id: ${id}`);
  }

  const splitModuleId = toWorkspaceModuleId(root, serverFn.extractedFilename);
  const splitCode = serverSplits.get(splitModuleId);

  if (!splitCode) {
    throw new Error(`Unable to load split module for server function id: ${id}`);
  }

  const resultKey = `__TUTO_RPC_RESULT_${randomUUID().replaceAll("-", "_")}`;
  const payloadKey = `__TUTO_RPC_PAYLOAD_${randomUUID().replaceAll("-", "_")}`;
  globalResultStore[payloadKey] = reviveRpcValue(payload ?? {});

  const entrySource = `
import { ${serverFn.functionName} as action } from ${JSON.stringify(splitModuleId)};

const payload = globalThis[${JSON.stringify(payloadKey)}] || {};
globalThis[${JSON.stringify(resultKey)}] = await action(payload);
`;

  const bundle = await build({
    absWorkingDir: absoluteWorkingDirectory,
    bundle: true,
    charset: "utf8",
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.TSS_SERVER_FN_BASE": '"/api/serverless/tanstack-start/core-rpc?id="',
    },
    entryPoints: ["__tuto_rpc_entry__"],
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "react",
    legalComments: "none",
    logLevel: "silent",
    outfile: "/out/rpc.js",
    platform: "node",
    plugins: [
      {
        name: "tuto-tanstack-start-core-rpc-workspace",
        setup(buildApi: PluginBuild) {
          buildApi.onResolve({ filter: /^__tuto_rpc_entry__$/ }, () => ({
            path: "__tuto_rpc_entry__",
            namespace: "rpc-entry",
          }));
          buildApi.onResolve({ filter: /^@tanstack\/react-start$/ }, () => ({
            path: "@tanstack/react-start",
            namespace: "rpc-shim",
          }));
          buildApi.onResolve({ filter: /^@tanstack\/react-start\/server-rpc$/ }, () => ({
            path: "@tanstack/react-start/server-rpc",
            namespace: "rpc-shim",
          }));
          buildApi.onLoad({ filter: /.*/, namespace: "rpc-entry" }, () => ({
            contents: entrySource,
            loader: "js",
            resolveDir: absoluteWorkingDirectory,
          }));
          buildApi.onLoad({ filter: /.*/, namespace: "rpc-shim" }, (args: OnLoadArgs) => ({
            contents:
              args.path === "@tanstack/react-start/server-rpc"
                ? `export function createServerRpc(meta, fn) { return Object.assign(fn, { serverFnMeta: meta, url: "/api/serverless/tanstack-start/core-rpc?id=" + meta.id }); }`
                : createReactStartRpcShim(),
            loader: "js",
            resolveDir: absoluteWorkingDirectory,
          }));
          buildApi.onResolve({ filter: /.*/ }, (args: OnResolveArgs) =>
            onResolveWorkspaceModule(fileMap, serverSplits, args),
          );
          buildApi.onLoad({ filter: /.*/, namespace: "server-split" }, (args: OnLoadArgs) => ({
            contents: serverSplits.get(args.path),
            loader: "tsx",
            resolveDir: absoluteWorkingDirectory,
          }));
          buildApi.onLoad({ filter: /.*/, namespace: "workspace" }, (args: OnLoadArgs) => ({
            contents: fileMap.get(args.path),
            loader: loaderForPath(args.path),
            resolveDir: absoluteWorkingDirectory,
          }));
        },
      },
    ],
    target: ["node22"],
    treeShaking: true,
    write: false,
  });
  const jsOutput = bundle.outputFiles.find((file) => file.path.endsWith(".js"));

  if (!jsOutput) throw new Error("RPC bundle did not produce JavaScript.");

  try {
    const dataUrl = `data:text/javascript;base64,${Buffer.from(jsOutput.text).toString("base64")}`;
    await import(dataUrl);
    const result = globalResultStore[resultKey] as ServerActionResult | undefined;

    if (result?.error) throw result.error;

    return {
      result: await serializeRpcValue(result?.result),
      context: await serializeRpcValue(result?.context ?? {}),
    };
  } finally {
    delete globalResultStore[resultKey];
    delete globalResultStore[payloadKey];
  }
}

function normalizeError(error: unknown): CoreRpcFailure {
  const control = serializeRpcControl(error);
  if (control) {
    const message =
      control.type === "redirect"
        ? `Redirect to ${control.href ?? control.headers.location ?? "unknown location"}`
        : "Not found";

    return {
      success: false,
      control,
      error: message,
      diagnostics: [createDiagnostic("info", message)],
    };
  }

  const message = error instanceof Error ? error.message : String(error);

  return {
    success: false,
    error: message,
    diagnostics: [createDiagnostic("error", message)],
  };
}

async function readInput(): Promise<CoreRpcInput> {
  let input = "";

  for await (const chunk of process.stdin) input += chunk.toString("utf8");

  return JSON.parse(input) as CoreRpcInput;
}

async function main() {
  let result: CoreRpcSuccess | CoreRpcFailure;

  try {
    const payload = await readInput();
    const value = await executeServerFn(payload);

    result = {
      success: true,
      ...value,
      diagnostics: [createDiagnostic("info", "Server function executed with Start core.")],
    };
  } catch (error) {
    result = normalizeError(error);
  }

  process.stdout.write(
    `\n${resultStartMarker}\n${JSON.stringify(result)}\n${resultEndMarker}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
