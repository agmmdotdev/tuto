import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseAstAsync } from "rolldown/parseAst";
import { transformRscCssExport } from "@vitejs/plugin-rsc/plugin";
import {
  hasDirective,
  transformDirectiveProxyExport,
  transformServerActionServer,
} from "@vitejs/plugin-rsc/transforms";
import type {
  Loader,
  OnLoadArgs,
  OnResolveArgs,
  Plugin,
  PluginBuild,
} from "esbuild";
import { Scanner } from "@tailwindcss/oxide";
import type { ChangedContent, SourceEntry } from "@tailwindcss/oxide";
import { compile as compileTailwind } from "tailwindcss";
import kernelManifest from "./kernel-manifest.generated.json";
import { createTanstackStartRouteFetch } from "./client-route-fetch";
import {
  toWorkspaceModuleId,
  transformStartServerFunctions,
  type StartServerFunctionsTransform,
} from "./server-functions-transform";

type BuildDiagnosticLevel = "info" | "warn" | "error";

type BuildDiagnostic = {
  id: string;
  level: BuildDiagnosticLevel;
  message: string;
  timestamp: string;
  filePath?: string;
  line?: number;
  column?: number;
};

type WorkspaceFileInput = {
  path: string;
  content: string;
};

type WorkspaceFileMap = Map<string, string>;

type WorkspaceEnvironment = {
  client: Record<string, string | boolean>;
  server: Record<string, string>;
};

type ImportProtectionEnvironment = "client" | "server";

type ImportProtectionBehavior = "error" | "mock";
type ImportProtectionMockAccess = "error" | "warn" | "off";
type ImportProtectionLogMode = "once" | "always";
type ImportProtectionEnvironmentRules = {
  specifiers: string[];
  files: string[];
  excludeFiles: string[];
};
type ImportProtectionPolicy = {
  enabled: boolean;
  behavior: ImportProtectionBehavior;
  mockAccess: ImportProtectionMockAccess;
  log: ImportProtectionLogMode;
  include: string[];
  exclude: string[];
  ignoreImporters: string[];
  client: ImportProtectionEnvironmentRules;
  server: ImportProtectionEnvironmentRules;
};
type ImportProtectionRun = {
  diagnostics: BuildDiagnostic[];
  policy: ImportProtectionPolicy;
  seenViolations: Set<string>;
};

type HtmlEntryPoint = {
  html: string;
  entryPath: string;
};

type TailwindRoot =
  | "none"
  | null
  | {
      base: string;
      pattern: string;
      negated?: boolean;
    };

type CompiledTailwindCss = {
  root: TailwindRoot;
  sources: SourceEntry[];
  features: number;
  build(candidates: string[]): string;
};

type TailwindCompileOptions = NonNullable<
  Parameters<typeof compileTailwind>[1]
>;
type TailwindLoadModule = NonNullable<TailwindCompileOptions["loadModule"]>;
type TailwindLoadStylesheet = NonNullable<
  TailwindCompileOptions["loadStylesheet"]
>;
type TailwindModuleResult = Awaited<ReturnType<TailwindLoadModule>>;
type TailwindStylesheetResult = Awaited<ReturnType<TailwindLoadStylesheet>>;
type RouteManifestEntry = {
  css?: string[];
  preloads: string[];
};
type RscClientReferenceDeps = {
  css: string[];
  js: string[];
};
type RscCssResource = {
  assetName: string;
  href: string;
};
type RscCssResourceBuild = {
  chunks: Record<string, string>;
  resourcesByImporter: Record<string, RscCssResource[]>;
  usedAssets: Set<string>;
};
type ServerlessPreviewResult = {
  buildMetrics: {
    clientFrameworkInputs: number;
    clientRevisionBytes: number;
    serverFrameworkInputs: number;
    serverRevisionBytes: number;
    sharedClientKernelBytes: number;
    sharedServerKernelBytes: number;
  };
  success: boolean;
  html: string;
  kernelId: string;
  diagnostics: BuildDiagnostic[];
  durationMs: number;
  revision: string;
  routeManifest: Record<string, RouteManifestEntry>;
  rpcToken: string;
  ssrClientBundle: string;
  ssrClientChunks: Record<string, string>;
  ssrCss: string;
  ssrCssChunks: Record<string, string>;
  serverBundle: string;
  serverChunks: Record<string, string>;
  serverFnIds: string[];
};

type CompilePayload = {
  files?: WorkspaceFileInput[];
  revision?: string;
};

type EsbuildErrorEntry = {
  text?: string;
  message?: string;
  location?: {
    file?: string;
    line?: number;
    column?: number;
  };
};

type EsbuildError = {
  errors?: EsbuildErrorEntry[];
  message?: string;
  stack?: string;
};

const require = createRequire(__filename);
const picomatch = require("picomatch") as (
  pattern: string,
  options?: { dot?: boolean },
) => (value: string) => boolean;
const path = nodePath.posix;
const absoluteWorkingDirectory = process.cwd();
const resultStartMarker = "__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_END__";
const virtualWorkspaceRoot = "/__tuto_tanstack_start_core__";
const maxFileCount = 64;
const maxFileSize = 220_000;
const maxTotalSize = 1_250_000;
const environmentFileNames = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
] as const;
const environmentFileNameSet = new Set<string>(environmentFileNames);
const importProtectionConfigFile = "tanstack-start.config.json";
const serverOnlyMarker = "@tanstack/react-start/server-only";
const clientOnlyMarker = "@tanstack/react-start/client-only";
const defaultImportProtectionRules = {
  client: {
    specifiers: ["@tanstack/react-start/server"],
    files: ["**/*.server.*"],
    excludeFiles: ["**/node_modules/**"],
  },
  server: {
    specifiers: [],
    files: ["**/*.client.*"],
    excludeFiles: ["**/node_modules/**"],
  },
} satisfies Record<
  ImportProtectionEnvironment,
  ImportProtectionEnvironmentRules
>;
let activeImportProtectionRun: ImportProtectionRun | undefined;
const tailwindSourceExtensions = new Set([
  "astro",
  "css",
  "cts",
  "html",
  "js",
  "jsx",
  "md",
  "mdx",
  "mts",
  "svelte",
  "ts",
  "tsx",
  "txt",
  "vue",
]);
const tailwindDirectivePattern =
  /@(?:reference|theme|variant|custom-variant|source|utility|plugin|config|apply|tailwind)\b/;
const tailwindImportPattern =
  /@import\s+["']tailwindcss(?:\/(?:index|preflight|theme|utilities)(?:\.css)?)?["']/;
const previewBridgeScript = `<script>
(() => {
  const previewSource = "tuto-serverless-preview-log";
  const toText = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const send = (level, args) => window.parent?.postMessage({
    source: previewSource,
    level,
    message: args.map(toText).join(" "),
    timestamp: new Date().toISOString(),
  }, "*");
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level];
    console[level] = (...args) => {
      send(level, args);
      return original.apply(console, args);
    };
  }
  window.addEventListener("error", (event) => send("error", [event.message]));
  window.addEventListener("unhandledrejection", (event) => send("error", [event.reason]));
})();
</script>`;

function createDiagnostic(
  level: BuildDiagnosticLevel,
  message: string,
  details: Partial<BuildDiagnostic> = {},
): BuildDiagnostic {
  return {
    id: randomUUID(),
    level,
    message,
    timestamp: new Date().toISOString(),
    ...details,
  };
}

function normalizeWorkspacePath(filePath: string) {
  return filePath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function toVirtualWorkspacePath(filePath: string) {
  return path.join(virtualWorkspaceRoot, normalizeWorkspacePath(filePath));
}

function fromVirtualWorkspacePath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");

  return normalized.startsWith(`${virtualWorkspaceRoot}/`)
    ? normalized.slice(virtualWorkspaceRoot.length + 1)
    : null;
}

function sanitizeWorkspaceFiles(files: unknown): WorkspaceFileMap {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("At least one file is required.");
  }

  if (files.length > maxFileCount) {
    throw new Error("Too many files for the TanStack Start core preview.");
  }

  const map: WorkspaceFileMap = new Map();
  let totalSize = 0;

  for (const file of files as WorkspaceFileInput[]) {
    const normalizedPath = normalizeWorkspacePath(file.path);

    if (
      !normalizedPath ||
      normalizedPath.includes("..") ||
      (normalizedPath.startsWith(".") &&
        !environmentFileNameSet.has(normalizedPath)) ||
      path.isAbsolute(normalizedPath)
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
      throw new Error(
        "Workspace snapshot is too large for the TanStack Start core preview.",
      );
    }

    map.set(normalizedPath, file.content);
  }

  return map;
}

function parseEnvironmentFile(
  source: string,
  environment: Record<string, string>,
) {
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match?.[1]) continue;
    let value = match[2] ?? "";
    const quote = value[0];
    if (
      (quote === '"' || quote === "'" || quote === "`") &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replaceAll("\\n", "\n")
          .replaceAll("\\r", "\r")
          .replaceAll("\\t", "\t")
          .replaceAll('\\"', '"')
          .replaceAll("\\\\", "\\");
      }
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    value = value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_full, braced: string | undefined, plain: string | undefined) =>
        environment[braced ?? plain ?? ""] ?? "",
    );
    environment[match[1]] = value;
  }
}

function readWorkspaceEnvironment(files: WorkspaceFileMap): WorkspaceEnvironment {
  const server: Record<string, string> = Object.create(null);
  for (const fileName of environmentFileNames) {
    const source = files.get(fileName);
    if (source !== undefined) parseEnvironmentFile(source, server);
  }
  const client: Record<string, string | boolean> = {
    BASE_URL: "/",
    DEV: false,
    MODE: "production",
    PROD: true,
    SSR: false,
  };
  for (const [key, value] of Object.entries(server)) {
    if (key.startsWith("VITE_")) client[key] = value;
  }
  return { client, server };
}

function serverEnvironmentDefine(
  environment: WorkspaceEnvironment,
  overrides: Record<string, string> = {},
) {
  return JSON.stringify({
    ...environment.server,
    NODE_ENV: "production",
    ...overrides,
  });
}

function importMetaEnvironmentDefine(
  environment: WorkspaceEnvironment,
  ssr: boolean,
  overrides: Record<string, string | boolean> = {},
) {
  return JSON.stringify({ ...environment.client, SSR: ssr, ...overrides });
}

function importProtectionObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[import-protection] ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function importProtectionStringArray(
  value: unknown,
  fallback: string[],
  label: string,
) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(
      `[import-protection] ${label} must be an array of glob strings.`,
    );
  }
  return [...new Set(value as string[])];
}

function readImportProtectionPolicy(files: WorkspaceFileMap) {
  const defaults = (): ImportProtectionPolicy => ({
    enabled: true,
    behavior: "error",
    mockAccess: "error",
    log: "once",
    include: [],
    exclude: [],
    ignoreImporters: [],
    client: {
      specifiers: [...defaultImportProtectionRules.client.specifiers],
      files: [...defaultImportProtectionRules.client.files],
      excludeFiles: [...defaultImportProtectionRules.client.excludeFiles],
    },
    server: {
      specifiers: [...defaultImportProtectionRules.server.specifiers],
      files: [...defaultImportProtectionRules.server.files],
      excludeFiles: [...defaultImportProtectionRules.server.excludeFiles],
    },
  });
  const source = files.get(importProtectionConfigFile);
  if (source === undefined) return defaults();

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `[import-protection] ${importProtectionConfigFile} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const config = importProtectionObject(parsed, importProtectionConfigFile);
  const mode = config.mode ?? "build";
  if (mode !== "build" && mode !== "development") {
    throw new Error(
      `[import-protection] ${importProtectionConfigFile} mode must be "build" or "development".`,
    );
  }
  const rawOptions = config.importProtection;
  if (rawOptions === undefined) return defaults();
  const options = importProtectionObject(
    rawOptions,
    `${importProtectionConfigFile} importProtection`,
  );
  const policy = defaults();

  if (options.enabled !== undefined && typeof options.enabled !== "boolean") {
    throw new Error("[import-protection] enabled must be a boolean.");
  }
  policy.enabled = options.enabled !== false;

  const behavior = options.behavior;
  if (typeof behavior === "string") {
    if (behavior !== "error" && behavior !== "mock") {
      throw new Error(
        '[import-protection] behavior must be "error", "mock", or a mode object.',
      );
    }
    policy.behavior = behavior;
  } else if (behavior !== undefined) {
    const modes = importProtectionObject(behavior, "behavior");
    const selected = mode === "development" ? modes.dev : modes.build;
    if (
      selected !== undefined &&
      selected !== "error" &&
      selected !== "mock"
    ) {
      throw new Error(
        `[import-protection] behavior.${mode === "development" ? "dev" : "build"} must be "error" or "mock".`,
      );
    }
    policy.behavior =
      (selected as ImportProtectionBehavior | undefined) ??
      (mode === "development" ? "mock" : "error");
  } else if (mode === "development") {
    policy.behavior = "mock";
  }

  if (
    options.mockAccess !== undefined &&
    options.mockAccess !== "error" &&
    options.mockAccess !== "warn" &&
    options.mockAccess !== "off"
  ) {
    throw new Error(
      '[import-protection] mockAccess must be "error", "warn", or "off".',
    );
  }
  policy.mockAccess =
    (options.mockAccess as ImportProtectionMockAccess | undefined) ?? "error";
  if (
    options.log !== undefined &&
    options.log !== "once" &&
    options.log !== "always"
  ) {
    throw new Error('[import-protection] log must be "once" or "always".');
  }
  policy.log =
    (options.log as ImportProtectionLogMode | undefined) ?? "once";
  policy.include = importProtectionStringArray(
    options.include,
    [],
    "include",
  );
  policy.exclude = importProtectionStringArray(
    options.exclude,
    [],
    "exclude",
  );
  policy.ignoreImporters = importProtectionStringArray(
    options.ignoreImporters,
    [],
    "ignoreImporters",
  );

  for (const environment of ["client", "server"] as const) {
    const rawRules = options[environment];
    if (rawRules === undefined) continue;
    const rules = importProtectionObject(rawRules, environment);
    const defaultRules = defaultImportProtectionRules[environment];
    const specifiers = importProtectionStringArray(
      rules.specifiers,
      defaultRules.specifiers,
      `${environment}.specifiers`,
    );
    policy[environment] = {
      specifiers:
        environment === "client"
          ? [...new Set([...defaultRules.specifiers, ...specifiers])]
          : specifiers,
      files: importProtectionStringArray(
        rules.files,
        defaultRules.files,
        `${environment}.files`,
      ),
      excludeFiles: importProtectionStringArray(
        rules.excludeFiles,
        defaultRules.excludeFiles,
        `${environment}.excludeFiles`,
      ),
    };
  }
  return policy;
}

const importProtectionGlobCache = new Map<string, (value: string) => boolean>();

function matchesImportProtectionPattern(value: string, pattern: string) {
  let matcher = importProtectionGlobCache.get(pattern);
  if (!matcher) {
    matcher = picomatch(pattern, { dot: true });
    importProtectionGlobCache.set(pattern, matcher);
  }
  return matcher(value);
}

function firstImportProtectionMatch(value: string, patterns: string[]) {
  return patterns.find((pattern) =>
    matchesImportProtectionPattern(value, pattern),
  );
}

function importProtectionWorkspacePath(filePath: string) {
  const cleanPath = filePath.split(/[?#]/, 1)[0]?.replaceAll("\\", "/") ?? "";
  return fromVirtualWorkspacePath(cleanPath) ?? cleanPath.replace(/^\/+/, "");
}

function shouldCheckImportProtectionImporter(
  importer: string,
  policy: ImportProtectionPolicy,
) {
  const relativePath = importProtectionWorkspacePath(importer);
  if (
    firstImportProtectionMatch(relativePath, policy.exclude) ||
    firstImportProtectionMatch(relativePath, policy.ignoreImporters)
  ) {
    return false;
  }
  if (policy.include.length > 0) {
    return Boolean(firstImportProtectionMatch(relativePath, policy.include));
  }
  return relativePath === "src" || relativePath.startsWith("src/");
}

function workspaceMarkerRestrictions(files: WorkspaceFileMap) {
  const serverOnly = new Set<string>();
  const clientOnly = new Set<string>();
  for (const [filePath, source] of files) {
    if (loaderForPath(filePath) === "css") continue;
    const hasServerMarker = new RegExp(
      `\\bimport\\s*["']${serverOnlyMarker.replaceAll("/", "\\/")}["']`,
    ).test(source);
    const hasClientMarker = new RegExp(
      `\\bimport\\s*["']${clientOnlyMarker.replaceAll("/", "\\/")}["']`,
    ).test(source);
    if (hasServerMarker && hasClientMarker) {
      throw new Error(
        `[import-protection] File "${filePath}" has both server-only and client-only markers. This is not allowed.`,
      );
    }
    if (hasServerMarker) serverOnly.add(filePath.split("?")[0] ?? filePath);
    if (hasClientMarker) clientOnly.add(filePath.split("?")[0] ?? filePath);
  }
  return { clientOnly, serverOnly };
}

function importProtectionError({
  environment,
  importer,
  specifier,
  resolved,
  reason,
}: {
  environment: ImportProtectionEnvironment;
  importer: string;
  specifier: string;
  resolved?: string;
  reason: string;
}) {
  const resolvedLine = resolved ? `\n  Resolved: ${resolved}` : "";
  return new Error(
    `[import-protection] Import denied in ${environment} environment\n\n  ${reason}\n  Importer: ${importer || "entry"}\n  Import: ${JSON.stringify(specifier)}${resolvedLine}`,
  );
}

function createImportProtectionPlugin(
  files: WorkspaceFileMap,
  environment: ImportProtectionEnvironment,
  root?: string,
): Plugin {
  const run = activeImportProtectionRun;
  const policy = run?.policy ?? readImportProtectionPolicy(files);
  const restrictions = policy.enabled
    ? workspaceMarkerRestrictions(files)
    : { clientOnly: new Set<string>(), serverOnly: new Set<string>() };
  const rules = policy[environment];
  const markerNamespace = `tuto-${environment}-environment-marker`;
  const mockNamespace = `tuto-${environment}-import-protection-mock`;
  const mocks = new Map<string, { names: string[]; message: string }>();
  let mockId = 0;

  const importerSource = (importer: string) => {
    const workspacePath = importProtectionWorkspacePath(importer);
    return files.get(workspacePath) ?? "";
  };

  const mockExportNames = (importer: string, specifier: string) => {
    const source = importerSource(importer);
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const names = new Set<string>();
    const declarationPattern = new RegExp(
      `(?:import|export)\\s+([\\s\\S]*?)\\s+from\\s*["']${escaped}["']`,
      "g",
    );
    for (const match of source.matchAll(declarationPattern)) {
      const clause = match[1]?.trim() ?? "";
      if (/^[A-Za-z_$][\w$]*(?:\s*,|$)/.test(clause)) names.add("default");
      const named = clause.match(/\{([\s\S]*?)\}/)?.[1];
      for (const part of named?.split(",") ?? []) {
        const imported = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
        if (imported && /^[A-Za-z_$][\w$]*$/.test(imported)) names.add(imported);
      }
    }
    return [...names];
  };

  const mockModule = (names: string[], message: string) => {
    const namedExports = names
      .filter((name) => name !== "default")
      .map((name) => `export { mock as ${name} };`)
      .join("\n");
    const report =
      policy.mockAccess === "off"
        ? ""
        : `if (!reported) { reported = true; console.${policy.mockAccess}(new Error(message)); }`;
    return `
const message = ${JSON.stringify(message)};
let reported = false;
const report = () => { ${report} };
const mock = new Proxy(function importProtectionMock() { report(); return mock; }, {
  apply() { report(); return mock; },
  construct() { report(); return mock; },
  get(_target, property) {
    report();
    if (property === Symbol.toPrimitive) return () => undefined;
    if (property === "then") return undefined;
    return mock;
  },
});
${namedExports}
export default mock;
`;
  };

  const deny = (details: {
    importer: string;
    specifier: string;
    resolved?: string;
    reason: string;
  }) => {
    const error = importProtectionError({ environment, ...details });
    if (policy.behavior === "error") throw error;
    const key = [
      environment,
      details.importer,
      details.specifier,
      details.resolved ?? "",
    ].join(":");
    if (
      run &&
      (policy.log === "always" || !run.seenViolations.has(key))
    ) {
      run.seenViolations.add(key);
      run.diagnostics.push(createDiagnostic("warn", error.message));
    }
    const id = `mock-${mockId++}`;
    mocks.set(id, {
      names: mockExportNames(details.importer, details.specifier),
      message: error.message,
    });
    return { path: id, namespace: mockNamespace };
  };

  return {
    name: `tuto-tanstack-start-${environment}-import-protection`,
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === serverOnlyMarker || args.path === clientOnlyMarker) {
          if (!policy.enabled) {
            return { path: args.path, namespace: markerNamespace };
          }
          if (!shouldCheckImportProtectionImporter(args.importer, policy)) {
            return { path: args.path, namespace: markerNamespace };
          }
          const denied =
            (environment === "client" && args.path === serverOnlyMarker) ||
            (environment === "server" && args.path === clientOnlyMarker);
          if (denied) {
            return deny({
              importer: args.importer,
              specifier: args.path,
              reason: `Denied by ${args.path.endsWith("server-only") ? "server-only" : "client-only"} marker`,
            });
          }
          return { path: args.path, namespace: markerNamespace };
        }
        if (!policy.enabled) return null;
        if (!shouldCheckImportProtectionImporter(args.importer, policy)) {
          return null;
        }
        const specifierPattern = firstImportProtectionMatch(
          args.path,
          rules.specifiers,
        );
        if (specifierPattern) {
          return deny({
            importer: args.importer,
            specifier: args.path,
            reason: `Denied by specifier pattern: ${specifierPattern}`,
          });
        }

        const rootedModule = root ? toWorkspaceModuleId(root, args.path) : null;
        const resolved =
          (rootedModule && files.has(rootedModule) ? rootedModule : null) ??
          (files.has(args.path) ? args.path : null) ??
          (args.importer
            ? resolveWorkspaceImport(files, args.path, args.importer)
            : null);
        if (!resolved) return null;
        const cleanResolved = resolved.split("?")[0] ?? resolved;
        if (
          firstImportProtectionMatch(cleanResolved, rules.excludeFiles)
        ) {
          return null;
        }
        const deniedByFile = firstImportProtectionMatch(
          cleanResolved,
          rules.files,
        );
        const deniedByMarker =
          environment === "client"
            ? restrictions.serverOnly.has(cleanResolved)
            : restrictions.clientOnly.has(cleanResolved);
        if (deniedByFile || deniedByMarker) {
          return deny({
            importer: args.importer,
            specifier: args.path,
            resolved: cleanResolved,
            reason: deniedByFile
              ? `Denied by file pattern: ${deniedByFile}`
              : `Denied by ${environment === "client" ? "server-only" : "client-only"} marker`,
          });
        }
        return null;
      });
      buildApi.onLoad({ filter: /.*/, namespace: markerNamespace }, () => ({
        contents: "export {};",
        loader: "js",
      }));
      buildApi.onLoad(
        { filter: /.*/, namespace: mockNamespace },
        (args) => {
          const mock = mocks.get(args.path);
          if (!mock) return null;
          return {
            contents: mockModule(mock.names, mock.message),
            loader: "js",
          };
        },
      );
    },
  };
}

function loaderForPath(filePath: string): Loader {
  const extension = path.extname(filePath.split("?")[0]).toLowerCase();

  switch (extension) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".jsx":
      return "jsx";
    case ".css":
      return "css";
    case ".json":
      return "json";
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".svg":
    case ".webp":
    case ".woff":
    case ".woff2":
      return "dataurl";
    default:
      return "file";
  }
}

function findWorkspaceFile(files: WorkspaceFileMap, candidatePath: string) {
  const normalized = normalizeWorkspacePath(candidatePath);
  const extensions = [
    "",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".css",
    ".json",
  ];

  if (files.has(normalized)) return normalized;

  for (const extension of extensions) {
    const directPath =
      extension && normalized.endsWith(extension)
        ? normalized
        : `${normalized}${extension}`;

    if (files.has(directPath)) return directPath;
  }

  for (const extension of extensions.slice(1)) {
    const nestedIndexPath = path.join(normalized, `index${extension}`);

    if (files.has(nestedIndexPath)) return nestedIndexPath;
  }

  return null;
}

function findWorkspaceScriptFile(
  files: WorkspaceFileMap,
  candidatePath: string,
) {
  const match = findWorkspaceFile(files, candidatePath);
  return match && /\.[cm]?[jt]sx?$/.test(match) ? match : null;
}

type WorkspacePathAlias = {
  patternPrefix: string;
  patternSuffix: string;
  targets: string[];
};

type WorkspacePathAliasConfig = {
  aliases: WorkspacePathAlias[];
  baseUrl: string;
};

const workspacePathAliasCache = new WeakMap<
  WorkspaceFileMap,
  WorkspacePathAliasConfig
>();

function readWorkspacePathAliases(
  files: WorkspaceFileMap,
): WorkspacePathAliasConfig {
  const cached = workspacePathAliasCache.get(files);
  if (cached) return cached;
  const configSource = files.get("tsconfig.json") ?? files.get("jsconfig.json");
  if (!configSource) {
    const empty = { aliases: [], baseUrl: "" };
    workspacePathAliasCache.set(files, empty);
    return empty;
  }

  let config: unknown;
  try {
    config = JSON.parse(configSource);
  } catch {
    const empty = { aliases: [], baseUrl: "" };
    workspacePathAliasCache.set(files, empty);
    return empty;
  }
  if (!config || typeof config !== "object") {
    const empty = { aliases: [], baseUrl: "" };
    workspacePathAliasCache.set(files, empty);
    return empty;
  }
  const compilerOptions = (config as Record<string, unknown>).compilerOptions;
  if (!compilerOptions || typeof compilerOptions !== "object") {
    const empty = { aliases: [], baseUrl: "" };
    workspacePathAliasCache.set(files, empty);
    return empty;
  }
  const options = compilerOptions as Record<string, unknown>;
  const baseUrl =
    typeof options.baseUrl === "string"
      ? normalizeWorkspacePath(options.baseUrl).replace(/^\.\/?/, "")
      : "";
  const paths = options.paths;
  if (!paths || typeof paths !== "object") {
    const withoutPaths = { aliases: [], baseUrl };
    workspacePathAliasCache.set(files, withoutPaths);
    return withoutPaths;
  }

  const aliases = Object.entries(paths as Record<string, unknown>)
    .flatMap(([pattern, targets]) => {
      if (!Array.isArray(targets) || !targets.every((target) => typeof target === "string")) {
        return [];
      }
      const wildcard = pattern.indexOf("*");
      return [
        {
          patternPrefix: wildcard === -1 ? pattern : pattern.slice(0, wildcard),
          patternSuffix: wildcard === -1 ? "" : pattern.slice(wildcard + 1),
          targets,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.patternPrefix.length + right.patternSuffix.length -
        (left.patternPrefix.length + left.patternSuffix.length),
    );
  const result = { aliases, baseUrl };
  workspacePathAliasCache.set(files, result);
  return result;
}

function resolveWorkspacePathAlias(files: WorkspaceFileMap, source: string) {
  const { aliases, baseUrl } = readWorkspacePathAliases(files);

  for (const alias of aliases) {
    if (
      !source.startsWith(alias.patternPrefix) ||
      !source.endsWith(alias.patternSuffix)
    ) {
      continue;
    }
    const wildcardValue = source.slice(
      alias.patternPrefix.length,
      source.length - alias.patternSuffix.length,
    );
    for (const target of alias.targets) {
      const candidate = target.includes("*")
        ? target.replaceAll("*", wildcardValue)
        : wildcardValue
          ? null
          : target;
      if (!candidate) continue;
      const normalized = normalizeWorkspacePath(
        path.normalize(path.join(baseUrl, candidate)),
      ).replace(/^\.\/?/, "");
      if (normalized.startsWith("..") || path.isAbsolute(normalized)) continue;
      const match = findWorkspaceFile(files, normalized);
      if (match) return match;
    }
  }
  return null;
}

function resolveWorkspaceImport(
  files: WorkspaceFileMap,
  source: string,
  importerPath: string,
) {
  if (source.startsWith("/")) return findWorkspaceFile(files, source);
  if (!source.startsWith(".")) return resolveWorkspacePathAlias(files, source);

  const baseDir = importerPath ? path.dirname(importerPath) : "";

  return findWorkspaceFile(files, path.normalize(path.join(baseDir, source)));
}

function extractEntryPoint(files: WorkspaceFileMap): HtmlEntryPoint {
  const html = files.get("index.html");

  if (!html) {
    throw new Error("The TanStack Start core preview requires index.html.");
  }

  const scriptMatch = html.match(
    /<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*><\/script>/i,
  );
  const rawEntryPath = scriptMatch?.[1] ?? "./src/main.tsx";
  const entryPath =
    resolveWorkspaceImport(files, rawEntryPath, "index.html") ??
    findWorkspaceFile(files, rawEntryPath);

  if (!entryPath) {
    throw new Error(`Unable to resolve the HTML entry script: ${rawEntryPath}`);
  }

  return { html, entryPath };
}

function looksLikeTailwindCss(contents: string) {
  return (
    tailwindImportPattern.test(contents) ||
    tailwindDirectivePattern.test(contents)
  );
}

function createTailwindScanInputs(files: WorkspaceFileMap): ChangedContent[] {
  return [...files.entries()].flatMap(([filePath, content]) => {
    const extension = path.extname(filePath).slice(1).toLowerCase();

    return tailwindSourceExtensions.has(extension) && content
      ? [{ file: toVirtualWorkspacePath(filePath), content, extension }]
      : [];
  });
}

function createTailwindScannerSources(
  compiledCss: CompiledTailwindCss,
): SourceEntry[] {
  if (compiledCss.root === "none") return [];
  if (compiledCss.root === null) {
    return [
      { base: virtualWorkspaceRoot, pattern: "**/*", negated: false },
      ...compiledCss.sources,
    ];
  }

  return [{ ...compiledCss.root, negated: false }, ...compiledCss.sources];
}

function scanTailwindCandidates(
  compiledCss: CompiledTailwindCss,
  files: WorkspaceFileMap,
) {
  const scanner = new Scanner({
    sources: createTailwindScannerSources(compiledCss),
  });
  const candidates = new Set<string>();

  for (const input of createTailwindScanInputs(files)) {
    for (const match of scanner.getCandidatesWithPositions(input)) {
      candidates.add(match.candidate);
    }
  }

  return [...candidates];
}

function resolveTailwindPackageStylesheet(id: string) {
  const match = id.match(
    /^tailwindcss(?:\/(index|preflight|theme|utilities)(?:\.css)?)?$/,
  );

  if (!match) return null;

  return require.resolve(`tailwindcss/${match[1] ?? "index"}.css`);
}

async function loadTailwindStylesheet(
  files: WorkspaceFileMap,
  id: string,
  base: string,
): Promise<TailwindStylesheetResult> {
  const workspaceFilePath =
    id.startsWith(".") || id.startsWith("/")
      ? (() => {
          if (id.startsWith("/")) return findWorkspaceFile(files, id);
          const workspaceBasePath = base
            ? fromVirtualWorkspacePath(base)
            : null;
          return workspaceBasePath
            ? findWorkspaceFile(
                files,
                path.normalize(path.join(workspaceBasePath, id)),
              )
            : null;
        })()
      : findWorkspaceFile(files, id);

  if (workspaceFilePath) {
    return {
      path: toVirtualWorkspacePath(workspaceFilePath),
      base: path.dirname(toVirtualWorkspacePath(workspaceFilePath)),
      content: files.get(workspaceFilePath) ?? "",
    };
  }

  const diskPath =
    resolveTailwindPackageStylesheet(id) ??
    require.resolve(id, {
      paths: [absoluteWorkingDirectory],
    });

  return {
    path: diskPath,
    base: nodePath.dirname(diskPath),
    content: await readFile(diskPath, "utf8"),
  };
}

async function loadTailwindModule(
  id: string,
  _base: string,
  resourceHint: "plugin" | "config",
): Promise<TailwindModuleResult> {
  if (id.startsWith(".") || id.startsWith("/")) {
    throw new Error(
      `Tailwind ${resourceHint} modules must come from installed packages in the core preview.`,
    );
  }

  const resolvedPath = require.resolve(id, {
    paths: [absoluteWorkingDirectory],
  });
  const loadedModule = await import(pathToFileURL(resolvedPath).href);

  return {
    path: resolvedPath,
    base: nodePath.dirname(resolvedPath),
    module: (loadedModule.default ??
      loadedModule) as TailwindModuleResult["module"],
  };
}

async function compileTailwindCss(
  files: WorkspaceFileMap,
  filePath: string,
  contents: string,
) {
  if (!looksLikeTailwindCss(contents)) return contents;

  const virtualFilePath = toVirtualWorkspacePath(filePath);
  const compiledCss = (await compileTailwind(contents, {
    base: path.dirname(virtualFilePath),
    from: virtualFilePath,
    loadModule: (id: string, base: string, resourceHint: "plugin" | "config") =>
      loadTailwindModule(id, base, resourceHint),
    loadStylesheet: (id: string, base: string) =>
      loadTailwindStylesheet(files, id, base),
    polyfills: 3,
  })) as CompiledTailwindCss;
  let candidates: string[] = [];

  if (compiledCss.root !== "none" && (compiledCss.features & 16) !== 0) {
    candidates = scanTailwindCandidates(compiledCss, files);
  }

  return compiledCss.build(candidates);
}

function createKernelExternalPlugin(
  target: "client" | "rsc" | "server",
): Plugin {
  const targetManifest = kernelManifest[target];
  const modules = new Set<string>(targetManifest.modules);

  return {
    name: `tuto-tanstack-start-${target}-kernel-externals`,
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) =>
        modules.has(args.path)
          ? {
              path: args.path,
              namespace: `tuto-${target}-kernel-external`,
            }
          : null,
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: `tuto-${target}-kernel-external` },
        (args) => {
          const exportNames = (
            targetManifest.exports as Record<string, string[]>
          )[args.path];
          if (!exportNames) {
            throw new Error(
              `Missing ${target} kernel exports for ${args.path}.`,
            );
          }
          const namedExports = exportNames.filter(
            (name) =>
              name !== "default" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name),
          );
          const declarations = namedExports.map(
            (name, index) =>
              `const value${index} = moduleValue[${JSON.stringify(
                name,
              )}]; export { value${index} as ${name} };`,
          );
          const defaultExport = exportNames.includes("default")
            ? "export default moduleValue.default;"
            : "";

          return {
            contents: `
const kernel = globalThis[${JSON.stringify(targetManifest.globalKey)}];
if (!kernel || kernel.id !== ${JSON.stringify(kernelManifest.id)}) {
  throw new Error('TanStack Start ${target} kernel ${kernelManifest.id} is not loaded.');
}
const moduleValue = kernel.modules[${JSON.stringify(args.path)}];
if (!moduleValue) throw new Error('Missing TanStack Start kernel module: ${args.path}');
${declarations.join("\n")}
${defaultExport}
`,
            loader: "js",
          };
        },
      );
    },
  };
}

function rscReferenceKey(filePath: string) {
  return `tuto-rsc-${createHash("sha256")
    .update(filePath)
    .digest("hex")
    .slice(0, 20)}`;
}

function rscServerActionReferenceKey(filePath: string, root: string) {
  const workspaceModuleId = toWorkspaceModuleId(root, filePath).split("?")[0];
  return `tuto-rsc-action-${createHash("sha256")
    .update(workspaceModuleId)
    .digest("hex")
    .slice(0, 20)}`;
}

function rscCssResourceKey(filePath: string) {
  return `tuto-rsc-css-${createHash("sha256")
    .update(filePath)
    .digest("hex")
    .slice(0, 20)}`;
}

type RscAstNode = {
  type?: string;
  start?: number;
  end?: number;
  name?: string;
  value?: unknown;
  computed?: boolean;
  object?: RscAstNode;
  property?: RscAstNode;
  meta?: RscAstNode;
  callee?: RscAstNode;
  arguments?: RscAstNode[];
  source?: RscAstNode;
  [key: string]: unknown;
};

function isCssImportPath(value: unknown): value is string {
  return typeof value === "string" && /\.css(?:\?[^#]*)?(?:#.*)?$/.test(value);
}

function hasDirectCssImport(ast: RscAstNode) {
  const body = Array.isArray(ast.body) ? (ast.body as RscAstNode[]) : [];
  return body.some(
    (node) =>
      (node.type === "ImportDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ExportNamedDeclaration") &&
      isCssImportPath(node.source?.value),
  );
}

function visitRscAst(value: unknown, visitor: (node: RscAstNode) => void) {
  if (Array.isArray(value)) {
    for (const child of value) visitRscAst(child, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;

  const node = value as RscAstNode;
  if (typeof node.type === "string") visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (key !== "loc") visitRscAst(child, visitor);
  }
}

function isRscLoadCssCall(node: RscAstNode) {
  const callee = node.callee;
  const viteRsc = callee?.object;
  const importMeta = viteRsc?.object;
  return (
    node.type === "CallExpression" &&
    callee?.type === "MemberExpression" &&
    callee.computed !== true &&
    callee.property?.name === "loadCss" &&
    viteRsc?.type === "MemberExpression" &&
    viteRsc.computed !== true &&
    viteRsc.property?.name === "viteRsc" &&
    importMeta?.type === "MetaProperty" &&
    importMeta.meta?.name === "import" &&
    importMeta.property?.name === "meta"
  );
}

function resolveRscCssImporter(
  files: WorkspaceFileMap,
  filePath: string,
  argument: RscAstNode | undefined,
) {
  if (!argument) return filePath;
  if (argument.type !== "Literal" || typeof argument.value !== "string") {
    throw new Error(
      `import.meta.viteRsc.loadCss() in ${filePath} requires a static string importer.`,
    );
  }
  const importer =
    findWorkspaceFile(files, argument.value) ??
    resolveWorkspaceImport(files, argument.value, filePath);
  if (!importer) {
    throw new Error(
      `Unable to resolve RSC CSS importer ${argument.value} from ${filePath}.`,
    );
  }
  return importer;
}

async function transformRscCssResources(
  source: string,
  filePath: string,
  files: WorkspaceFileMap,
  resourcesByImporter: Record<string, RscCssResource[]>,
) {
  let output = source;
  let ast = (await parseAstAsync(output, {
    lang: "tsx",
  })) as unknown as RscAstNode;

  if (hasDirectCssImport(ast)) {
    const transformed = await transformRscCssExport({
      ast: ast as unknown as Parameters<
        typeof transformRscCssExport
      >[0]["ast"],
      code: output,
      filter: (_name, meta) =>
        !!(
          (meta.isFunction &&
            meta.declName &&
            /^[A-Z]/.test(meta.declName)) ||
          (meta.defaultExportIdentifierName &&
            /^[A-Z]/.test(meta.defaultExportIdentifierName))
        ),
    });
    if (transformed) output = transformed.output.toString();
  }

  if (!output.includes("import.meta.viteRsc.loadCss")) return output;
  const hasReactBinding = output.includes("__vite_rsc_react__");
  ast = (await parseAstAsync(output, {
    lang: "tsx",
  })) as unknown as RscAstNode;
  const calls: Array<{
    end: number;
    importer: string;
    start: number;
  }> = [];
  visitRscAst(ast, (node) => {
    if (!isRscLoadCssCall(node)) return;
    if (
      typeof node.start !== "number" ||
      typeof node.end !== "number" ||
      (node.arguments?.length ?? 0) > 1
    ) {
      throw new Error(`Invalid import.meta.viteRsc.loadCss() in ${filePath}.`);
    }
    calls.push({
      end: node.end,
      importer: resolveRscCssImporter(files, filePath, node.arguments?.[0]),
      start: node.start,
    });
  });
  if (calls.length === 0) return output;

  const imports = new Map<string, string>();
  for (const call of calls) {
    const resourceKey = rscCssResourceKey(call.importer);
    resourcesByImporter[call.importer] ??= [];
    imports.set(
      resourceKey,
      `import * as __vite_rsc_importer_resources_${resourceKey.replaceAll("-", "_")} from ${JSON.stringify(`virtual:tuto-rsc/css/${resourceKey}`)};`,
    );
  }
  for (const call of calls.sort((left, right) => right.start - left.start)) {
    const resourceKey = rscCssResourceKey(call.importer);
    const identifier = `__vite_rsc_importer_resources_${resourceKey.replaceAll("-", "_")}`;
    output = `${output.slice(0, call.start)}__vite_rsc_react__.createElement(${identifier}.Resources)${output.slice(call.end)}`;
  }
  const reactImport = hasReactBinding
    ? ""
    : `import __vite_rsc_react__ from "react";`;
  return `${reactImport}${[...imports.values()].join("")}${output}`;
}

function createRscCssResourcesModule(resources: RscCssResource[]) {
  return `
import __vite_rsc_react__ from "react";
const resources = ${JSON.stringify(resources.map(({ href }) => href))};
export function Resources() {
  return __vite_rsc_react__.createElement(
    __vite_rsc_react__.Fragment,
    null,
    resources.map((href) => __vite_rsc_react__.createElement("link", {
      "data-rsc-css-href": href,
      href,
      key: "css:" + href,
      precedence: "vite-rsc/importer-resources",
      rel: "stylesheet",
    })),
  );
}
`;
}

async function transformRscServerActionProxy(
  source: string,
  filePath: string,
  root: string,
  environment: "browser" | "ssr",
) {
  if (!source.includes("use server")) return source;
  const ast = await parseAstAsync(source, { lang: "tsx" });
  if (
    !hasDirective(
      ast.body as unknown as Parameters<typeof hasDirective>[0],
      "use server",
    )
  )
    return source;
  const reference = rscServerActionReferenceKey(filePath, root);
  const result = transformDirectiveProxyExport(
    ast as unknown as Parameters<typeof transformDirectiveProxyExport>[0],
    {
      code: source,
      directive: "use server",
      rejectNonAsyncFunction: true,
      runtime: (name) =>
        `$$createServerReference(${JSON.stringify(
          `${reference}#${name}`,
        )}, $$callServer, undefined, undefined, ${JSON.stringify(name)})`,
    },
  );
  if (!result) return source;
  return `import { callServer as $$callServer, createServerReference as $$createServerReference } from '@vitejs/plugin-rsc/react/${environment}';\n${result.output.toString()}`;
}

type RscServerActionReference = {
  exportNames: string[];
  filePath: string;
};

async function transformRscServerActionModules(
  files: WorkspaceFileMap,
  root: string,
) {
  const references: Record<string, RscServerActionReference> = {};
  await Promise.all(
    [...files.entries()].map(async ([filePath, source]) => {
      if (loaderForPath(filePath) === "css" || !source.includes("use server"))
        return;
      const ast = await parseAstAsync(source, { lang: "tsx" });
      const reference = rscServerActionReferenceKey(filePath, root);
      const result = transformServerActionServer(
        source,
        ast as unknown as Parameters<typeof transformServerActionServer>[1],
        {
          decode: (value) =>
            `await $$decryptActionBoundArgs(${value})`,
          encode: (value) => `$$encryptActionBoundArgs(${value})`,
          rejectNonAsyncFunction: true,
          runtime: (value, name) =>
            `$$registerServerReference(${value}, ${JSON.stringify(
              reference,
            )}, ${JSON.stringify(name)})`,
        },
      );
      if (!result.output.hasChanged()) return;
      const exportNames =
        "names" in result ? result.names : result.exportNames;
      if (exportNames.length === 0) return;
      files.set(
        filePath,
        `import { registerServerReference as $$registerServerReference } from '@vitejs/plugin-rsc/react/rsc';
import { decryptActionBoundArgs as $$decryptActionBoundArgs, encryptActionBoundArgs as $$encryptActionBoundArgs } from '@vitejs/plugin-rsc/utils/encryption-runtime';
${result.output.toString()}`,
      );
      references[reference] = { exportNames, filePath };
    }),
  );
  return references;
}

async function isUseClientModule(source: string) {
  if (!source.includes("use client")) return false;
  const ast = await parseAstAsync(source, { lang: "tsx" });
  return hasDirective(
    ast.body as unknown as Parameters<typeof hasDirective>[0],
    "use client",
  );
}

async function collectRscClientReferences(files: WorkspaceFileMap) {
  const references: Record<string, string> = {};
  await Promise.all(
    [...files.entries()].map(async ([filePath, source]) => {
      if (loaderForPath(filePath) === "css") return;
      if (await isUseClientModule(source)) {
        references[rscReferenceKey(filePath)] = filePath;
      }
    }),
  );
  return references;
}

function createRscWorkspacePlugin({
  clientReferences,
  cssResources,
  entrySource,
  files,
  root,
}: {
  clientReferences: Record<string, string>;
  cssResources: RscCssResourceBuild;
  entrySource: string;
  files: WorkspaceFileMap;
  root: string;
}): Plugin {
  const referenceByFile = new Map(
    Object.entries(clientReferences).map(([reference, filePath]) => [
      filePath,
      reference,
    ]),
  );

  return {
    name: "tuto-tanstack-start-rsc-workspace",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^__tuto_rsc_entry__$/ }, () => ({
        path: "__tuto_rsc_entry__",
        namespace: "tuto-rsc-entry",
      }));
      buildApi.onResolve({ filter: /^virtual:tuto-rsc\/css\// }, (args) => ({
        path: args.path,
        namespace: "tuto-rsc-css-resource",
      }));
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        const rootedModule = toWorkspaceModuleId(root, args.path);
        if (files.has(rootedModule)) {
          return { path: rootedModule, namespace: "tuto-rsc-workspace" };
        }
        if (files.has(args.path)) {
          return { path: args.path, namespace: "tuto-rsc-workspace" };
        }
        if (
          args.namespace === "tuto-rsc-entry" ||
          args.namespace === "tuto-rsc-workspace"
        ) {
          const match = resolveWorkspaceImport(files, args.path, args.importer);
          if (match) return { path: match, namespace: "tuto-rsc-workspace" };
        }
        return null;
      });
      buildApi.onLoad({ filter: /.*/, namespace: "tuto-rsc-entry" }, () => ({
        contents: entrySource,
        loader: "js",
        resolveDir: absoluteWorkingDirectory,
      }));
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-rsc-css-resource" },
        (args) => {
          const resourceKey = args.path.slice(
            "virtual:tuto-rsc/css/".length,
          );
          const importer = Object.keys(cssResources.resourcesByImporter).find(
            (filePath) => rscCssResourceKey(filePath) === resourceKey,
          );
          if (!importer) {
            throw new Error(`Unknown RSC CSS resource: ${resourceKey}`);
          }
          const resources = cssResources.resourcesByImporter[importer] ?? [];
          for (const resource of resources) {
            cssResources.usedAssets.add(resource.assetName);
          }
          return {
            contents: createRscCssResourcesModule(resources),
            loader: "js",
            resolveDir: absoluteWorkingDirectory,
          };
        },
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-rsc-workspace" },
        async (args) => {
          const source = files.get(args.path);
          if (typeof source !== "string") return null;
          const loader = loaderForPath(args.path);
          if (loader === "css") return { contents: "", loader: "js" };
          const reference = referenceByFile.get(args.path);
          if (!reference) {
            return {
              contents: await transformRscCssResources(
                source,
                args.path,
                files,
                cssResources.resourcesByImporter,
              ),
              loader,
              resolveDir: absoluteWorkingDirectory,
            };
          }

          const ast = await parseAstAsync(source, { lang: "tsx" });
          const transformed = transformDirectiveProxyExport(
            ast as unknown as Parameters<
              typeof transformDirectiveProxyExport
            >[0],
            {
              code: source,
              directive: "use client",
              keep: false,
              runtime: (name) =>
                `$$registerClientReference(() => { throw new Error(${JSON.stringify(
                  `Client reference ${args.path}#${name} cannot execute in the RSC environment.`,
                )}); }, ${JSON.stringify(reference)}, ${JSON.stringify(name)})`,
            },
          );
          if (!transformed) {
            throw new Error(`Unable to compile RSC client boundary ${args.path}.`);
          }
          return {
            contents: `import { registerClientReference as $$registerClientReference } from '@vitejs/plugin-rsc/react/rsc';\n${transformed.output.toString()}`,
            loader,
            resolveDir: absoluteWorkingDirectory,
          };
        },
      );
    },
  };
}

function createServerWorkspacePlugin({
  entrySource,
  files,
  resolverSource,
  root,
}: {
  entrySource: string;
  files: WorkspaceFileMap;
  resolverSource: string;
  root: string;
}): Plugin {
  return {
    name: "tuto-real-start-server-workspace",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^__tuto_server_entry__$/ }, () => ({
        path: "__tuto_server_entry__",
        namespace: "tuto-server-entry",
      }));
      buildApi.onResolve(
        { filter: /^#tanstack-start-server-fn-resolver$/ },
        () => ({
          path: "#tanstack-start-server-fn-resolver",
          namespace: "tuto-server-resolver",
        }),
      );
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        const rootedModule = toWorkspaceModuleId(root, args.path);
        if (files.has(rootedModule)) {
          return {
            path: rootedModule,
            namespace: "tuto-server-workspace",
          };
        }
        if (files.has(args.path)) {
          return { path: args.path, namespace: "tuto-server-workspace" };
        }
        if (
          args.namespace === "tuto-server-workspace" ||
          args.namespace === "tuto-server-resolver"
        ) {
          const match = resolveWorkspaceImport(files, args.path, args.importer);
          if (match) return { path: match, namespace: "tuto-server-workspace" };
        }
        return null;
      });
      buildApi.onLoad({ filter: /.*/, namespace: "tuto-server-entry" }, () => ({
        contents: entrySource,
        loader: "js",
        resolveDir: absoluteWorkingDirectory,
      }));
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-server-resolver" },
        () => ({
          contents: resolverSource,
          loader: "js",
          resolveDir: absoluteWorkingDirectory,
        }),
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: "tuto-server-workspace" },
        async (args) => {
          const loader = loaderForPath(args.path);
          const source = files.get(args.path);
          const contents =
            loader === "css" || typeof source !== "string"
              ? ""
              : await transformRscServerActionProxy(
                  source,
                  args.path,
                  root,
                  "ssr",
                );
          return {
            // Route modules commonly import their stylesheet. The browser SSR
            // entry compiles that stylesheet separately; the server only needs
            // the module graph and must not try to resolve CSS package imports.
            contents,
            loader,
            resolveDir: absoluteWorkingDirectory,
          };
        },
      );
    },
  };
}

function resolveWorkspaceModule(
  files: WorkspaceFileMap,
  args: OnResolveArgs,
  root?: string,
) {
  const rootedModule = root ? toWorkspaceModuleId(root, args.path) : null;
  if (rootedModule && files.has(rootedModule)) {
    return { path: rootedModule, namespace: "workspace" };
  }

  if (args.kind === "entry-point") {
    const entryMatch = findWorkspaceFile(files, args.path);
    if (entryMatch) return { path: entryMatch, namespace: "workspace" };
  }

  const workspaceMatch =
    args.namespace === "workspace"
      ? resolveWorkspaceImport(files, args.path, args.importer)
      : null;

  if (workspaceMatch) return { path: workspaceMatch, namespace: "workspace" };
  if (args.path.startsWith("node:")) return null;

  return null;
}

function createWorkspacePlugin(
  files: WorkspaceFileMap,
  root?: string,
  rscActionEnvironment?: "browser" | "ssr",
): Plugin {
  return {
    name: "tuto-tanstack-start-core-preview-workspace",
    setup(buildApi: PluginBuild) {
      buildApi.onResolve({ filter: /.*/ }, (args: OnResolveArgs) =>
        resolveWorkspaceModule(files, args, root),
      );

      buildApi.onLoad(
        { filter: /.*/, namespace: "workspace" },
        async (args: OnLoadArgs) => {
          const contents = files.get(args.path);
          if (typeof contents !== "string") return null;

          const loader = loaderForPath(args.path);
          const compiledContents =
            loader !== "css" && root && rscActionEnvironment
              ? await transformRscServerActionProxy(
                  contents,
                  args.path,
                  root,
                  rscActionEnvironment,
                )
              : contents;
          return {
            contents:
              loader === "css"
                ? await compileTailwindCss(files, args.path, contents)
                : compiledContents,
            loader,
            resolveDir: absoluteWorkingDirectory,
          };
        },
      );
    },
  };
}

function injectPreviewAssets({
  html,
  cssText,
  jsText,
}: {
  html: string;
  cssText: string;
  jsText: string;
}) {
  let nextHtml = html.replace(
    /<script\b[^>]*type=["']module["'][^>]*src=["'][^"']+["'][^>]*><\/script>/i,
    "",
  );
  const styles = cssText ? `<style>${cssText}</style>` : "";
  const kernelScript = `<script src="${kernelManifest.client.url}"></script>`;
  const script = `<script type="module">${jsText}</script>`;

  if (nextHtml.includes("</head>")) {
    nextHtml = nextHtml.replace("</head>", () => `${styles}</head>`);
  } else {
    nextHtml = `${styles}${nextHtml}`;
  }

  if (nextHtml.includes("</body>")) {
    return nextHtml.replace(
      "</body>",
      () => `${kernelScript}${script}${previewBridgeScript}</body>`,
    );
  }

  return `${nextHtml}${kernelScript}${script}${previewBridgeScript}`;
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildFailurePreview(diagnostics: BuildDiagnostic[]) {
  const body = diagnostics
    .map(
      (diagnostic) =>
        `<article><strong>${escapeHtml(
          diagnostic.filePath ?? "build",
        )}</strong><pre>${escapeHtml(diagnostic.message)}</pre></article>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8" /><style>body{margin:0;padding:24px;background:#1e1e1e;color:#f5f5f5;font:14px/1.5 Consolas,monospace}article{border-top:1px solid #333;padding:16px}strong{color:#9cdcfe}pre{white-space:pre-wrap}</style></head><body>${body}</body></html>`;
}

function buildSsrPreviewRedirect(revision: string, rpcToken: string) {
  const renderUrl = `/api/serverless/tanstack-start/core-render?revision=${encodeURIComponent(
    revision,
  )}&token=${encodeURIComponent(rpcToken)}&path=%2F`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Loading Start preview</title></head><body><script>location.replace(${JSON.stringify(
    renderUrl,
  )})</script></body></html>`;
}

function isEsbuildError(error: unknown): error is EsbuildError {
  return typeof error === "object" && error !== null;
}

function normalizeBuildError(error: unknown): BuildDiagnostic[] {
  if (
    isEsbuildError(error) &&
    Array.isArray(error.errors) &&
    error.errors.length > 0
  ) {
    return error.errors.map((entry) =>
      createDiagnostic(
        "error",
        entry.text || entry.message || "TanStack core preview failed.",
        {
          filePath: entry.location?.file
            ? normalizeWorkspacePath(entry.location.file)
            : undefined,
          line: entry.location?.line,
          column: entry.location?.column
            ? entry.location.column + 1
            : undefined,
        },
      ),
    );
  }

  const message =
    error instanceof Error
      ? [error.message, error.stack].filter(Boolean).join("\n")
      : String(error);

  return [
    createDiagnostic("error", message || "TanStack core preview failed."),
  ];
}

async function buildNativeServerBundle({
  clientAssetUrl,
  cssAssetUrl,
  environment,
  rscClientReferenceDeps,
  rscClientReferences,
  routeManifest,
  root,
  transform,
}: {
  clientAssetUrl: string;
  cssAssetUrl?: string;
  environment: WorkspaceEnvironment;
  rscClientReferenceDeps: Record<string, RscClientReferenceDeps>;
  rscClientReferences: Record<string, string>;
  routeManifest: Record<string, RouteManifestEntry>;
  root: string;
  transform: StartServerFunctionsTransform;
}) {
  const serverFiles = new Map(transform.serverFiles);
  const startModule = findWorkspaceFile(serverFiles, "src/start");
  const customServerModule = findWorkspaceScriptFile(
    serverFiles,
    "src/server",
  );
  const routerModule = findWorkspaceFile(serverFiles, "src/router");
  if (
    Object.keys(transform.serverFnsById).length === 0 &&
    !routerModule &&
    !customServerModule
  ) {
    return { chunks: {}, code: "", frameworkInputs: 0 };
  }
  for (const [splitId, splitSource] of transform.serverRouteSplits) {
    serverFiles.set(splitId, splitSource);
  }

  const { __root__: rootRouteManifest, ...childRouteManifest } = routeManifest;

  const startInstanceSource = startModule
    ? `import { startInstance } from ${JSON.stringify(startModule)};
globalThis.${kernelManifest.server.startInstanceKey} = startInstance;`
    : `delete globalThis.${kernelManifest.server.startInstanceKey};`;
  const routerSource = routerModule
    ? `import { getRouter } from ${JSON.stringify(routerModule)};
globalThis.${kernelManifest.server.routerKey} = getRouter;
globalThis.${kernelManifest.server.manifestKey} = ${JSON.stringify({
        routes: {
          __root__: {
            css: [
              ...(cssAssetUrl ? [cssAssetUrl] : []),
              ...(rootRouteManifest?.css ?? []),
            ],
            preloads: [
              clientAssetUrl,
              ...(rootRouteManifest?.preloads ?? []),
            ],
            scripts: [
              { attrs: { src: kernelManifest.client.url } },
              { attrs: { src: clientAssetUrl, type: "module" } },
            ],
          },
          ...childRouteManifest,
        },
      })};`
    : `delete globalThis.${kernelManifest.server.routerKey};
delete globalThis.${kernelManifest.server.manifestKey};`;
  const resolverSource = `${startInstanceSource}
${routerSource}
const rscSsrReferences = {
${Object.entries(rscClientReferences)
  .map(
    ([reference, filePath]) =>
      `  ${JSON.stringify(reference)}: () => import(${JSON.stringify(filePath)}),`,
  )
  .join("\n")}
};
const rscSsrReferenceDeps = ${JSON.stringify(rscClientReferenceDeps)};
const frameworkRscSsrReferences = ${JSON.stringify(
    kernelManifest.rsc.clientReferences,
  )};
globalThis.${kernelManifest.server.rscLoaderKey} = async function loadRscSsrClientReference(id) {
  const load = rscSsrReferences[id];
  if (load) {
    return {
      deps: rscSsrReferenceDeps[id] ?? { css: [], js: [] },
      module: await load(),
    };
  }
  const moduleKey = frameworkRscSsrReferences[id];
  const frameworkModule = moduleKey
    ? globalThis.${kernelManifest.server.globalKey}?.modules?.[moduleKey]
    : undefined;
  if (frameworkModule) {
    return { deps: { css: [], js: [] }, module: frameworkModule };
  }
  throw new Error('Unknown RSC SSR client reference: ' + id);
};
if (typeof globalThis.${kernelManifest.server.resolverKey} !== 'function') {
  globalThis.${kernelManifest.server.resolverKey} = async function getServerFnById(id) {
    throw new Error('Unknown server function: ' + id);
  };
}`;
  const customServerEntrySource = customServerModule
    ? `
import customServerEntry from ${JSON.stringify(customServerModule)};
if (!customServerEntry || typeof customServerEntry.fetch !== 'function') {
  throw new Error('src/server must default-export a TanStack Start server entry with fetch().');
}
globalThis.${kernelManifest.server.handlerKey} = (request, requestOptions = {}) =>
  customServerEntry.fetch(request, requestOptions);
`
    : "";
  const entrySource = `${resolverSource}\n${customServerEntrySource}`;
  const result = await build({
    absWorkingDir: absoluteWorkingDirectory,
    bundle: true,
    charset: "utf8",
    define: {
      "import.meta.env": importMetaEnvironmentDefine(environment, true),
      "process.env": serverEnvironmentDefine(environment, {
        TSS_SERVER_FN_BASE: kernelManifest.server.serverFnBase,
      }),
    },
    entryPoints: ["__tuto_server_entry__"],
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "react",
    legalComments: "none",
    logLevel: "silent",
    chunkNames: "chunks/chunk-[hash]",
    entryNames: "entry",
    outdir: "/out",
    platform: "node",
    plugins: [
      createImportProtectionPlugin(serverFiles, "server", root),
      createKernelExternalPlugin("server"),
      createServerWorkspacePlugin({
        entrySource,
        files: serverFiles,
        resolverSource,
        root,
      }),
    ],
    splitting: true,
    target: ["node22"],
    treeShaking: true,
    write: false,
  });
  const output = result.outputFiles.find((file) =>
    file.path.replaceAll("\\", "/").endsWith("/entry.js"),
  );
  if (!output)
    throw new Error("The Start server runtime did not produce JavaScript.");
  return {
    chunks: Object.fromEntries(
      result.outputFiles
        .filter(
          (file) => file.path.endsWith(".js") && file.path !== output.path,
        )
        .map((file) => [relativeOutputName(file.path), file.text]),
    ),
    code: output.text,
    frameworkInputs: 0,
  };
}

function createRscCssGraphBoundaryPlugin({
  clientReferences,
  files,
  root,
}: {
  clientReferences: Record<string, string>;
  files: WorkspaceFileMap;
  root: string;
}): Plugin {
  const clientFiles = new Set(Object.values(clientReferences));
  return {
    name: "tuto-tanstack-start-rsc-css-boundaries",
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return null;
        const rootedModule = toWorkspaceModuleId(root, args.path);
        const workspaceModule = files.has(rootedModule)
          ? rootedModule
          : files.has(args.path)
            ? args.path
            : resolveWorkspaceImport(files, args.path, args.importer);
        return workspaceModule && clientFiles.has(workspaceModule)
          ? { external: true, path: workspaceModule }
          : null;
      });
    },
  };
}

async function collectRscCssImporters(
  files: WorkspaceFileMap,
  clientReferences: Record<string, string>,
) {
  const clientFiles = new Set(Object.values(clientReferences));
  const importers = new Set<string>();
  await Promise.all(
    [...files.entries()].map(async ([filePath, source]) => {
      const loader = loaderForPath(filePath);
      if (
        clientFiles.has(filePath) ||
        !(
          loader === "js" ||
          loader === "jsx" ||
          loader === "ts" ||
          loader === "tsx"
        ) ||
        (!source.includes(".css") &&
          !source.includes("import.meta.viteRsc.loadCss"))
      ) {
        return;
      }
      const ast = (await parseAstAsync(source, {
        lang: "tsx",
      })) as unknown as RscAstNode;
      if (hasDirectCssImport(ast)) importers.add(filePath);
      if (!source.includes("import.meta.viteRsc.loadCss")) return;
      visitRscAst(ast, (node) => {
        if (!isRscLoadCssCall(node) || (node.arguments?.length ?? 0) > 1)
          return;
        try {
          importers.add(
            resolveRscCssImporter(files, filePath, node.arguments?.[0]),
          );
        } catch {
          // Reachable modules are validated again during the real RSC build.
        }
      });
    }),
  );
  return importers;
}

async function buildRscCssResources({
  clientReferences,
  files,
  root,
  styleAssetBase,
}: {
  clientReferences: Record<string, string>;
  files: WorkspaceFileMap;
  root: string;
  styleAssetBase: string;
}): Promise<RscCssResourceBuild> {
  const cssImporters = await collectRscCssImporters(files, clientReferences);
  const entryPoints = Object.fromEntries(
    [...cssImporters]
      .map((filePath) => [rscCssResourceKey(filePath), filePath]),
  );
  if (Object.keys(entryPoints).length === 0) {
    return { chunks: {}, resourcesByImporter: {}, usedAssets: new Set() };
  }

  const result = await build({
    absWorkingDir: absoluteWorkingDirectory,
    bundle: true,
    charset: "utf8",
    entryNames: "rsc-css/[name]-[hash]",
    entryPoints,
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "react",
    legalComments: "none",
    logLevel: "silent",
    metafile: true,
    outdir: "/out",
    packages: "external",
    platform: "node",
    plugins: [
      createRscCssGraphBoundaryPlugin({ clientReferences, files, root }),
      createWorkspacePlugin(files, root),
    ],
    splitting: true,
    target: ["node22"],
    treeShaking: true,
    write: false,
  });
  const cssChunks = Object.fromEntries(
    result.outputFiles
      .filter((file) => file.path.endsWith(".css"))
      .map((file) => [relativeOutputName(file.path), file.text]),
  );
  const resourcesByImporter: Record<string, RscCssResource[]> = {};

  for (const [outputPath, output] of Object.entries(result.metafile.outputs)) {
    if (!output.entryPoint || !outputPath.endsWith(".js")) continue;
    const importer = workspacePathFromMetafileInput(output.entryPoint, files);
    if (!importer) continue;
    const assetName = output.cssBundle
      ? relativeOutputName(output.cssBundle)
      : null;
    resourcesByImporter[importer] = assetName
      ? [
          {
            assetName,
            href: routeStyleUrl(styleAssetBase, assetName),
          },
        ]
      : [];
  }

  return {
    chunks: cssChunks,
    resourcesByImporter,
    usedAssets: new Set(),
  };
}

async function buildRscServerBundle({
  clientReferences,
  environment,
  root,
  styleAssetBase,
  transform,
}: {
  clientReferences: Record<string, string>;
  environment: WorkspaceEnvironment;
  root: string;
  styleAssetBase: string;
  transform: StartServerFunctionsTransform;
}) {
  const files = new Map(transform.serverFiles);
  for (const [splitId, splitSource] of transform.serverRouteSplits) {
    files.set(splitId, splitSource);
  }
  const rscModule = findWorkspaceFile(files, "src/rsc");
  const rscServerActionReferences = await transformRscServerActionModules(
    files,
    root,
  );
  const entries: string[] = [];
  for (const [id, serverFn] of Object.entries(transform.serverFnsById)) {
    const splitModuleId = toWorkspaceModuleId(root, serverFn.extractedFilename);
    const splitSource = transform.serverSplits.get(splitModuleId);
    if (!splitSource) {
      throw new Error(`Missing RSC provider split for function ${id}.`);
    }
    files.set(splitModuleId, splitSource);
    entries.push(
      `${JSON.stringify(id)}: () => import(${JSON.stringify(
        splitModuleId,
      )}).then((module) => module[${JSON.stringify(serverFn.functionName)}]),`,
    );
  }
  const actionEntries = Object.entries(rscServerActionReferences).map(
    ([reference, action]) =>
      `${JSON.stringify(reference)}: () => import(${JSON.stringify(
        action.filePath,
      )}),`,
  );
  if (!rscModule && entries.length === 0 && actionEntries.length === 0)
    return { chunks: {}, code: "", cssChunks: {} };

  const cssResources = await buildRscCssResources({
    clientReferences,
    files,
    root,
    styleAssetBase,
  });

  const hasRscServerActions = actionEntries.length > 0;
  const actionRuntimeSource = hasRscServerActions
    ? `
const rscActionModules = {
${actionEntries.join("\n")}
};
setRequireModule({
  async load(id) {
    const loadModule = rscActionModules[id];
    if (!loadModule) throw new Error('Unknown RSC server-action module: ' + id);
    return loadModule();
  },
});
`
    : "";
  const actionHandlerSource = hasRscServerActions
    ? `
  if (pathname === ${JSON.stringify(
    kernelManifest.rsc.actionInternalPath,
  )}) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed.', {
        headers: { allow: 'POST' },
        status: 405,
      });
    }
    const actionId = request.headers.get('x-tuto-rsc-action');
    const separator = actionId?.lastIndexOf('#') ?? -1;
    if (!actionId || separator <= 0 || separator === actionId.length - 1) {
      return new Response('Invalid RSC server action.', { status: 400 });
    }
    const moduleId = actionId.slice(0, separator);
    const exportName = actionId.slice(separator + 1);
    const loadModule = rscActionModules[moduleId];
    if (!loadModule) return new Response('Unknown RSC server action.', { status: 404 });
    const contentType = request.headers.get('content-type') ?? '';
    const body = contentType.startsWith('multipart/form-data')
      ? await request.formData()
      : await request.text();
    const args = await decodeReply(body);
    if (!Array.isArray(args)) {
      return new Response('Invalid RSC server-action arguments.', { status: 400 });
    }
    const module = await loadModule();
    const action = module[exportName];
    if (typeof action !== 'function') {
      return new Response('Unknown RSC server-action export.', { status: 404 });
    }
    const routerFactory = globalThis.${kernelManifest.server.routerKey};
    const startInstance = globalThis.${kernelManifest.server.startInstanceKey};
    const startOptions = startInstance && typeof startInstance.getOptions === 'function'
      ? await startInstance.getOptions()
      : {};
    return runWithStartContext({
      getRouter: async () => {
        if (typeof routerFactory !== 'function') {
          throw new Error('This revision does not export getRouter from src/router.');
        }
        return routerFactory();
      },
      request,
      startOptions,
      contextAfterGlobalMiddlewares: requestOptions.context ?? {},
      executedRequestMiddlewares: new Set(),
      handlerType: 'serverFn',
    }, () => {
      const stream = renderToReadableStream(action(...args));
      return new Response(stream, {
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/x-component; charset=utf-8',
          'vary': 'accept',
        },
      });
    });
  }
`
    : "";
  const lowLevelRscHandlerSource = rscModule
    ? `
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed.', {
      headers: { allow: 'GET, HEAD' },
      status: 405,
    });
  }
  const stream = renderToReadableStream(
    React.createElement(RscRoot, { requestUrl: request.url }),
  );
  return new Response(request.method === 'HEAD' ? null : stream, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/x-component; charset=utf-8',
      'vary': 'accept',
    },
  });
`
    : "return new Response('RSC endpoint not found.', { status: 404 });";
  const rscHandlerSource =
    rscModule || hasRscServerActions
      ? `
globalThis.${kernelManifest.rsc.handlerKey} = requestHandler(async function handleRsc(request, requestOptions = {}) {
  const pathname = new URL(request.url).pathname;
${actionHandlerSource}
${lowLevelRscHandlerSource}
});
`
      : "";
  const entrySource = `
import React from 'react';
${rscModule ? `import RscRoot from ${JSON.stringify(rscModule)};` : ""}
${rscModule || hasRscServerActions ? "import { renderToReadableStream } from '@tanstack/react-start/rsc';" : ""}
${hasRscServerActions ? "import { decodeReply, setRequireModule } from '@vitejs/plugin-rsc/react/rsc';" : ""}
${hasRscServerActions ? "import { runWithStartContext } from '@tanstack/start-storage-context';" : ""}
${rscModule || hasRscServerActions ? "import { requestHandler } from '@tanstack/react-start/server';" : ""}
const actions = { ${entries.join("\n")} };
globalThis.${kernelManifest.server.resolverKey} = async function getServerFnById(id) {
  const loadAction = actions[id];
  if (!loadAction) throw new Error('Unknown server function: ' + id);
  return loadAction();
};
${actionRuntimeSource}
${rscHandlerSource}
`;
  const result = await build({
    absWorkingDir: absoluteWorkingDirectory,
    bundle: true,
    charset: "utf8",
    conditions: ["react-server", "module", "import", "default"],
    define: {
      "import.meta.env": importMetaEnvironmentDefine(environment, true, {
        __vite_rsc_build__: true,
      }),
      "process.env": serverEnvironmentDefine(environment),
    },
    entryNames: "chunks/rsc-entry",
    entryPoints: ["__tuto_rsc_entry__"],
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "react",
    legalComments: "none",
    logLevel: "silent",
    chunkNames: "chunks/rsc-[hash]",
    outdir: "/out",
    platform: "node",
    plugins: [
      createImportProtectionPlugin(files, "server", root),
      createKernelExternalPlugin("rsc"),
      createRscWorkspacePlugin({
        clientReferences,
        cssResources,
        entrySource,
        files,
        root,
      }),
    ],
    splitting: true,
    target: ["node22"],
    treeShaking: true,
    write: false,
  });
  const entry = result.outputFiles.find((file) =>
    file.path.replaceAll("\\", "/").endsWith("/chunks/rsc-entry.js"),
  );
  if (!entry) throw new Error("The RSC runtime did not produce an entry.");

  return {
    chunks: Object.fromEntries(
      result.outputFiles
        .filter((file) => file.path.endsWith(".js"))
        .map((file) => [relativeOutputName(file.path), file.text]),
    ),
    code: entry.text,
    cssChunks: Object.fromEntries(
      Object.entries(cssResources.chunks).filter(([assetName]) =>
        cssResources.usedAssets.has(assetName),
      ),
    ),
  };
}

function relativeOutputName(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  const outMarker = "/out/";
  const markerIndex = normalized.lastIndexOf(outMarker);

  return markerIndex === -1
    ? path.basename(normalized)
    : normalized.slice(markerIndex + outMarker.length);
}

function routeChunkUrl(chunkAssetBase: string, outputName: string) {
  return `${chunkAssetBase}${encodeURIComponent(outputName)}`;
}

function routeStyleUrl(styleAssetBase: string, outputName: string) {
  return `${styleAssetBase}${encodeURIComponent(outputName)}`;
}

function routeStyleLoader(styleUrl: string) {
  return `
if (typeof document !== "undefined") {
  const styleHref = new URL(${JSON.stringify(styleUrl)}, document.baseURI).href;
  const existingStyle = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .find((link) => link.href === styleHref);
  if (!existingStyle) {
    await new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = styleHref;
      link.addEventListener("load", resolve, { once: true });
      link.addEventListener("error", () => reject(new Error("Unable to load route stylesheet.")), { once: true });
      document.head.append(link);
    });
  }
}
`;
}

function createClientOutputPreloadCollector({
  chunks,
  chunkAssetBase,
  metafile,
}: {
  chunks: Record<string, string>;
  chunkAssetBase: string;
  metafile: NonNullable<Awaited<ReturnType<typeof build>>["metafile"]>;
}) {
  const outputByName = new Map(
    Object.entries(metafile.outputs).map(([outputPath, output]) => [
      relativeOutputName(outputPath),
      output,
    ]),
  );
  const escapedChunkAssetBase = chunkAssetBase.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const staticChunkImportPattern = new RegExp(
    `(?:\\bfrom|\\bimport)\\s*["']${escapedChunkAssetBase}\\/?([^"'\\s;]+)["']`,
    "g",
  );

  function resolveImportedOutputName(currentName: string, importPath: string) {
    if (importPath.startsWith(chunkAssetBase)) {
      return decodeURIComponent(
        importPath.slice(chunkAssetBase.length),
      ).replace(/^\/+/, "");
    }
    const relativeName = path.normalize(
      path.join(path.dirname(currentName), importPath),
    );
    if (outputByName.has(relativeName)) return relativeName;
    const directName = importPath.replace(/^\.\//, "").replace(/^\/+/, "");
    return outputByName.has(directName) ? directName : null;
  }

  function collectPreloads(
    outputName: string,
    seen = new Set<string>(),
  ): string[] {
    if (seen.has(outputName)) return [];
    seen.add(outputName);
    const output = outputByName.get(outputName);
    if (!output) return [];
    const emittedStaticImports = [
      ...(chunks[outputName] ?? "").matchAll(staticChunkImportPattern),
    ]
      .map((match) => decodeURIComponent(match[1] ?? ""))
      .filter((name) => outputByName.has(name));

    return [
      routeChunkUrl(chunkAssetBase, outputName),
      ...emittedStaticImports.flatMap((name) =>
        collectPreloads(name, seen),
      ),
      ...output.imports.flatMap((entry) => {
        if (
          entry.kind === "dynamic-import" ||
          (entry.external && !entry.path.startsWith(chunkAssetBase))
        )
          return [];
        const importedName = resolveImportedOutputName(outputName, entry.path);
        return importedName ? collectPreloads(importedName, seen) : [];
      }),
    ];
  }

  return collectPreloads;
}

function buildClientRouteManifest({
  chunks,
  chunkAssetBase,
  styleAssetBase,
  metafile,
  routeIds,
}: {
  chunks: Record<string, string>;
  chunkAssetBase: string;
  styleAssetBase: string;
  metafile: NonNullable<Awaited<ReturnType<typeof build>>["metafile"]>;
  routeIds: Record<string, string>;
}) {
  const manifest: Record<string, RouteManifestEntry> = {};
  const collectPreloads = createClientOutputPreloadCollector({
    chunks,
    chunkAssetBase,
    metafile,
  });

  for (const [outputPath, output] of Object.entries(metafile.outputs)) {
    if (
      !outputPath.endsWith(".js") ||
      relativeOutputName(outputPath) === "entry.js"
    )
      continue;
    const routePath = Object.keys(routeIds).find((workspacePath) =>
      Object.keys(output.inputs).some((inputPath) =>
        inputPath.includes(`${workspacePath}?tsr-split=`) &&
        // Hydrate virtual modules are dynamic child entries, not route entry
        // dependencies. Preloading them would defeat every deferred strategy.
        !inputPath.includes("tss-hydrate="),
      ),
    );
    if (!routePath) continue;
    const routeId = routeIds[routePath];
    if (!routeId) continue;
    const entry = (manifest[routeId] ??= { preloads: [] });
    for (const preload of collectPreloads(relativeOutputName(outputPath))) {
      if (!entry.preloads.includes(preload)) entry.preloads.push(preload);
    }
    if (output.cssBundle) {
      const cssName = relativeOutputName(output.cssBundle);
      const cssUrl = routeStyleUrl(styleAssetBase, cssName);
      entry.css ??= [];
      if (!entry.css.includes(cssUrl)) entry.css.push(cssUrl);
    }
  }

  return manifest;
}

function buildRscClientReferenceDeps({
  chunks,
  chunkAssetBase,
  clientReferences,
  entryFiles,
  metafile,
  styleAssetBase,
}: {
  chunks: Record<string, string>;
  chunkAssetBase: string;
  clientReferences: Record<string, string>;
  entryFiles: WorkspaceFileMap;
  metafile: NonNullable<Awaited<ReturnType<typeof build>>["metafile"]>;
  styleAssetBase: string;
}) {
  const deps: Record<string, RscClientReferenceDeps> = {};
  const referenceByFile = new Map(
    Object.entries(clientReferences).map(([reference, filePath]) => [
      filePath,
      reference,
    ]),
  );
  const collectPreloads = createClientOutputPreloadCollector({
    chunks,
    chunkAssetBase,
    metafile,
  });

  for (const [outputPath, output] of Object.entries(metafile.outputs)) {
    if (!output.entryPoint || !outputPath.endsWith(".js")) continue;
    const workspacePath = workspacePathFromMetafileInput(
      output.entryPoint,
      entryFiles,
    );
    const reference = workspacePath
      ? referenceByFile.get(workspacePath)
      : undefined;
    if (!reference) continue;
    deps[reference] = {
      css: output.cssBundle
        ? [
            routeStyleUrl(
              styleAssetBase,
              relativeOutputName(output.cssBundle),
            ),
          ]
        : [],
      js: collectPreloads(relativeOutputName(outputPath)),
    };
  }

  return deps;
}

function workspacePathFromMetafileInput(
  inputPath: string,
  files: WorkspaceFileMap,
) {
  const namespaceSeparator = inputPath.indexOf(":");
  const candidate =
    namespaceSeparator === -1
      ? inputPath
      : inputPath.slice(namespaceSeparator + 1);
  return files.has(candidate) ? candidate : null;
}

async function buildStaticClientCss({
  entryFiles,
  entryOutputName,
  metafile,
  root,
}: {
  entryFiles: WorkspaceFileMap;
  entryOutputName: string;
  metafile: NonNullable<Awaited<ReturnType<typeof build>>["metafile"]>;
  root: string;
}) {
  const entryOutput = Object.entries(metafile.outputs).find(
    ([outputPath]) => relativeOutputName(outputPath) === entryOutputName,
  )?.[1];
  const entryPoint = entryOutput?.entryPoint;
  if (!entryPoint) return "";

  const staticInputs = new Set<string>();
  const pending = [entryPoint];
  while (pending.length > 0) {
    const inputPath = pending.pop();
    if (!inputPath || staticInputs.has(inputPath)) continue;
    staticInputs.add(inputPath);
    const input = metafile.inputs[inputPath];
    if (!input) continue;
    for (const imported of input.imports) {
      if (!imported.external && imported.kind !== "dynamic-import") {
        pending.push(imported.path);
      }
    }
  }

  const cssInputs = [...staticInputs]
    .map((inputPath) => workspacePathFromMetafileInput(inputPath, entryFiles))
    .filter((inputPath): inputPath is string => inputPath !== null)
    .filter((inputPath) => loaderForPath(inputPath) === "css");
  if (cssInputs.length === 0) return "";

  const cssEntryPath = "__tuto_ssr_static_css_entry__.js";
  const cssFiles = new Map(entryFiles);
  cssFiles.set(
    cssEntryPath,
    cssInputs
      .map((inputPath) => `import ${JSON.stringify(`./${inputPath}`)};`)
      .join("\n"),
  );
  const result = await build({
    absWorkingDir: absoluteWorkingDirectory,
    bundle: true,
    charset: "utf8",
    entryPoints: [cssEntryPath],
    legalComments: "none",
    logLevel: "silent",
    outdir: "/out/static-css",
    platform: "browser",
    plugins: [createWorkspacePlugin(cssFiles, root)],
    write: false,
  });
  return (
    result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? ""
  );
}

async function buildSsrClientBundle({
  chunkAssetBase,
  environment,
  files,
  root,
  serverRouteBase,
  serverFnBase,
  styleAssetBase,
  routeIds,
  routeSplits,
  rscClientReferences,
}: {
  chunkAssetBase: string;
  environment: WorkspaceEnvironment;
  files: WorkspaceFileMap;
  root: string;
  serverRouteBase: string;
  serverFnBase: string;
  styleAssetBase: string;
  routeIds: Record<string, string>;
  routeSplits: WorkspaceFileMap;
  rscClientReferences: Record<string, string>;
}) {
  const routerModule = findWorkspaceFile(files, "src/router");
  if (!routerModule)
    return {
      chunks: {},
      code: "",
      css: "",
      cssChunks: {},
      frameworkInputs: 0,
      rscClientReferenceDeps: {},
      routeManifest: {},
    };
  const startModule = findWorkspaceFile(files, "src/start");
  const customClientModule = findWorkspaceScriptFile(files, "src/client");
  const entryPath = "__tuto_ssr_client_entry__.tsx";
  const entryFiles = new Map(files);
  for (const [splitId, splitCode] of routeSplits) {
    entryFiles.set(splitId, splitCode);
  }
  entryFiles.set(
    entryPath,
    `import React, { StrictMode, startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { StartClient } from '@tanstack/react-start/client';
import { getRouter } from ${JSON.stringify(`./${routerModule}`)};
${
  startModule
    ? `import { startInstance } from ${JSON.stringify(`./${startModule}`)};`
    : "const startInstance = undefined;"
}

globalThis.${kernelManifest.client.routerKey} = getRouter;
globalThis.${kernelManifest.client.startInstanceKey} = startInstance;
const rscClientReferences = {
${Object.entries(rscClientReferences)
  .map(
    ([reference, filePath]) =>
      `  ${JSON.stringify(reference)}: () => import(${JSON.stringify(
        `./${filePath}`,
      )}),`,
  )
  .join("\n")}
};
const frameworkRscClientReferences = ${JSON.stringify(
    kernelManifest.rsc.clientReferences,
  )};
globalThis.${kernelManifest.client.rscLoaderKey} = async function loadRscClientReference(id) {
  const load = rscClientReferences[id];
  if (load) return load();
  const moduleKey = frameworkRscClientReferences[id];
  const frameworkModule = moduleKey
    ? globalThis.${kernelManifest.client.globalKey}?.modules?.[moduleKey]
    : undefined;
  if (frameworkModule) return frameworkModule;
  throw new Error('Unknown RSC client reference: ' + id);
};

const nativeFetch = globalThis.fetch.bind(globalThis);
const createRouteFetch = ${createTanstackStartRouteFetch.toString()};
globalThis.fetch = createRouteFetch(
  nativeFetch,
  globalThis.location,
  ${JSON.stringify(serverRouteBase)},
);

${
  customClientModule
    ? `await import(${JSON.stringify(`./${customClientModule}`)});`
    : `startTransition(() => {
  hydrateRoot(document, <StrictMode><StartClient /></StrictMode>);
});`
}`,
  );
  const result = await build({
    absWorkingDir: absoluteWorkingDirectory,
    banner: {
      js: `globalThis.${kernelManifest.client.serverFnBaseKey}=${JSON.stringify(
        serverFnBase,
      )};`,
    },
    bundle: true,
    charset: "utf8",
    define: {
      "import.meta.env": importMetaEnvironmentDefine(environment, false),
      "process.env.NODE_ENV": '"production"',
      "process.env.TSS_ROUTER_BASEPATH": '"/"',
      "process.env.TSS_SERVER_FN_BASE": JSON.stringify(serverFnBase),
    },
    entryPoints: [entryPath],
    entryNames: "entry",
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "react",
    legalComments: "none",
    logLevel: "silent",
    outdir: "/out",
    platform: "browser",
    publicPath: chunkAssetBase,
    plugins: [
      createImportProtectionPlugin(entryFiles, "client", root),
      createKernelExternalPlugin("client"),
      createWorkspacePlugin(entryFiles, root, "browser"),
    ],
    target: ["es2022"],
    treeShaking: true,
    metafile: true,
    chunkNames: "chunks/chunk-[hash]",
    splitting: true,
    write: false,
  });
  const jsOutput = result.outputFiles.find((file) =>
    file.path.replaceAll("\\", "/").endsWith("/entry.js"),
  );
  if (!jsOutput)
    throw new Error("The Start SSR client did not produce JavaScript.");
  const outputByName = new Map(
    Object.entries(result.metafile.outputs).map(([outputPath, output]) => [
      relativeOutputName(outputPath),
      output,
    ]),
  );
  const chunks = Object.fromEntries(
    result.outputFiles
      .filter(
        (file) => file.path.endsWith(".js") && file.path !== jsOutput.path,
      )
      .map((file) => {
        const outputName = relativeOutputName(file.path);
        const cssBundle = outputByName.get(outputName)?.cssBundle;
        return [
          outputName,
          cssBundle
            ? `${routeStyleLoader(
                routeStyleUrl(styleAssetBase, relativeOutputName(cssBundle)),
              )}${file.text}`
            : file.text,
        ];
      }),
  );
  const cssChunks = Object.fromEntries(
    result.outputFiles
      .filter((file) =>
        file.path.replaceAll("\\", "/").includes("/chunks/") &&
        file.path.endsWith(".css"),
      )
      .map((file) => [relativeOutputName(file.path), file.text]),
  );
  const css = await buildStaticClientCss({
    entryFiles,
    entryOutputName: "entry.js",
    metafile: result.metafile,
    root,
  });
  const rscClientReferenceDeps = buildRscClientReferenceDeps({
    chunks,
    chunkAssetBase,
    clientReferences: rscClientReferences,
    entryFiles,
    metafile: result.metafile,
    styleAssetBase,
  });
  return {
    chunks,
    code: jsOutput.text,
    css,
    cssChunks,
    frameworkInputs: 0,
    rscClientReferenceDeps,
    routeManifest: buildClientRouteManifest({
      chunks,
      chunkAssetBase,
      styleAssetBase,
      metafile: result.metafile,
      routeIds,
    }),
  };
}

async function compilePreview(
  files: unknown,
  revision: string,
): Promise<ServerlessPreviewResult> {
  const startedAt = Date.now();
  const importProtectionDiagnostics: BuildDiagnostic[] = [];
  const rpcToken = randomBytes(32).toString("base64url");
  const serverFnBase = `/api/serverless/tanstack-start/core-rpc?revision=${encodeURIComponent(
    revision,
  )}&token=${encodeURIComponent(rpcToken)}&id=`;
  const assetBase = `/api/serverless/tanstack-start/core-asset?revision=${encodeURIComponent(
    revision,
  )}&token=${encodeURIComponent(rpcToken)}&kind=`;
  const serverRouteBase = `/api/serverless/tanstack-start/core-route?revision=${encodeURIComponent(
    revision,
  )}&token=${encodeURIComponent(rpcToken)}&path=`;
  const chunkAssetBase = `${assetBase}chunk&name=`;
  const styleAssetBase = `${assetBase}style&name=`;

  try {
    const originalFileMap = sanitizeWorkspaceFiles(files);
    activeImportProtectionRun = {
      diagnostics: importProtectionDiagnostics,
      policy: readImportProtectionPolicy(originalFileMap),
      seenViolations: new Set(),
    };
    const environment = readWorkspaceEnvironment(originalFileMap);
    const root = nodePath.join(
      absoluteWorkingDirectory,
      ".tmp",
      "tanstack-start-core",
    );
    const transform = await transformStartServerFunctions(originalFileMap, {
      root,
    });
    const rscClientReferences =
      await collectRscClientReferences(originalFileMap);
    const transformed = transform.clientFiles;
    const transformedWithRouteSplits = new Map(transformed);
    for (const [splitId, splitCode] of transform.clientRouteSplits) {
      transformedWithRouteSplits.set(splitId, splitCode);
    }
    const serverFnsById = transform.serverFnsById;
    const { entryPath, html } = extractEntryPoint(transformed);
    const result = await build({
      absWorkingDir: absoluteWorkingDirectory,
      banner: {
        js: `globalThis.${kernelManifest.client.serverFnBaseKey}=${JSON.stringify(
          serverFnBase,
        )};globalThis.__TSS_START_OPTIONS__={...(globalThis.__TSS_START_OPTIONS__??{}),serverFns:{...(globalThis.__TSS_START_OPTIONS__?.serverFns??{}),fetch:(url,init)=>globalThis.fetch(url,{...init,credentials:"include"})}};`,
      },
      bundle: true,
      charset: "utf8",
      define: {
        "import.meta.env": importMetaEnvironmentDefine(environment, false),
        "process.env.NODE_ENV": '"production"',
        "process.env.TSS_SERVER_FN_BASE": JSON.stringify(serverFnBase),
      },
      entryPoints: [entryPath],
      format: "esm",
      jsx: "automatic",
      jsxImportSource: "react",
      legalComments: "none",
      logLevel: "silent",
      mainFields: ["browser", "module", "main"],
      minify: true,
      outdir: "/out",
      platform: "browser",
      plugins: [
        createImportProtectionPlugin(
          transformedWithRouteSplits,
          "client",
          root,
        ),
        createKernelExternalPlugin("client"),
        createWorkspacePlugin(transformedWithRouteSplits, root, "browser"),
      ],
      target: ["es2022"],
      treeShaking: true,
      write: false,
    });
    const jsOutput = result.outputFiles.find((file) =>
      file.path.endsWith(".js"),
    );
    const cssOutput = result.outputFiles.find((file) =>
      file.path.endsWith(".css"),
    );

    if (!jsOutput)
      throw new Error("The TanStack core preview did not produce JavaScript.");

    const ssrClientBuild = await buildSsrClientBundle({
      chunkAssetBase,
      environment,
      files: transformed,
      root,
      routeIds: transform.clientRouteIds,
      routeSplits: transform.clientRouteSplits,
      rscClientReferences,
      serverRouteBase,
      serverFnBase,
      styleAssetBase,
    });
    const serverBuild = await buildNativeServerBundle({
      clientAssetUrl: `${assetBase}client`,
      ...(ssrClientBuild.css ? { cssAssetUrl: `${assetBase}style` } : {}),
      environment,
      rscClientReferenceDeps: ssrClientBuild.rscClientReferenceDeps,
      rscClientReferences,
      routeManifest: ssrClientBuild.routeManifest,
      root,
      transform,
    });
    const rscBuild = await buildRscServerBundle({
      clientReferences: rscClientReferences,
      environment,
      root,
      styleAssetBase,
      transform,
    });
    const serverBundle = rscBuild.code
      ? `import ${JSON.stringify("./chunks/rsc-entry.js")};\n${serverBuild.code}`
      : serverBuild.code;
    const serverChunks = {
      ...serverBuild.chunks,
      ...rscBuild.chunks,
    };
    const ssrCssChunks = {
      ...ssrClientBuild.cssChunks,
      ...rscBuild.cssChunks,
    };
    const durationMs = Date.now() - startedAt;
    const buildMetrics = {
      clientFrameworkInputs: 0,
      clientRevisionBytes:
        jsOutput.contents.byteLength +
        Buffer.byteLength(ssrClientBuild.code) +
        Object.values(ssrClientBuild.chunks).reduce(
          (bytes, chunk) => bytes + Buffer.byteLength(chunk),
          0,
        ) +
        Buffer.byteLength(ssrClientBuild.css) +
        Object.values(ssrCssChunks).reduce(
          (bytes, chunk) => bytes + Buffer.byteLength(chunk),
          0,
        ),
      serverFrameworkInputs: serverBuild.frameworkInputs,
      serverRevisionBytes:
        Buffer.byteLength(serverBundle) +
        Object.values(serverChunks).reduce(
          (bytes, chunk) => bytes + Buffer.byteLength(chunk),
          0,
        ),
      sharedClientKernelBytes: kernelManifest.client.bytes,
      sharedServerKernelBytes:
        kernelManifest.server.bytes + kernelManifest.rsc.bytes,
    };

    return {
      buildMetrics,
      success: true,
      html: ssrClientBuild.code
        ? buildSsrPreviewRedirect(revision, rpcToken)
        : injectPreviewAssets({
            html,
            cssText: cssOutput?.text ?? "",
            jsText: jsOutput.text,
          }),
      diagnostics: [
        ...importProtectionDiagnostics,
        createDiagnostic(
          "info",
          `TanStack Start core preview compiled ${Object.keys(serverFnsById).length} server function(s) and ${rscBuild.code ? 1 : 0} RSC entry in ${durationMs}ms. Revision bundles: ${buildMetrics.clientRevisionBytes} client bytes and ${buildMetrics.serverRevisionBytes} server bytes; shared kernel ${kernelManifest.id}.`,
        ),
      ],
      durationMs,
      kernelId: kernelManifest.id,
      revision,
      routeManifest: ssrClientBuild.routeManifest,
      rpcToken,
      ssrClientBundle: ssrClientBuild.code,
      ssrClientChunks: ssrClientBuild.chunks,
      ssrCss: ssrClientBuild.css,
      ssrCssChunks,
      serverBundle,
      serverChunks,
      serverFnIds: Object.keys(serverFnsById),
    };
  } catch (error) {
    const diagnostics = [
      ...importProtectionDiagnostics,
      ...normalizeBuildError(error),
    ];
    return {
      buildMetrics: {
        clientFrameworkInputs: 0,
        clientRevisionBytes: 0,
        serverFrameworkInputs: 0,
        serverRevisionBytes: 0,
        sharedClientKernelBytes: kernelManifest.client.bytes,
        sharedServerKernelBytes:
          kernelManifest.server.bytes + kernelManifest.rsc.bytes,
      },
      success: false,
      html: buildFailurePreview(diagnostics),
      diagnostics,
      durationMs: Date.now() - startedAt,
      kernelId: kernelManifest.id,
      revision,
      routeManifest: {},
      rpcToken,
      ssrClientBundle: "",
      ssrClientChunks: {},
      ssrCss: "",
      ssrCssChunks: {},
      serverBundle: "",
      serverChunks: {},
      serverFnIds: [],
    };
  }
}

async function readInput(): Promise<CompilePayload> {
  let input = "";

  for await (const chunk of process.stdin) input += chunk.toString("utf8");

  return JSON.parse(input) as CompilePayload;
}

async function main() {
  const payload = await readInput();
  if (!payload.revision || !/^[a-f0-9]{64}$/.test(payload.revision)) {
    throw new Error("A valid workspace revision is required.");
  }
  const result = await compilePreview(payload.files ?? [], payload.revision);
  process.stdout.write(
    `\n${resultStartMarker}\n${JSON.stringify(result)}\n${resultEndMarker}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exitCode = 1;
});
