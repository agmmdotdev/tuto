import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import type { WorkspaceFile } from "@/lib/ide/types";
import clientKernelManifest from "./client-kernel-manifest.generated.json";
import {
  NEXT_REQUEST_ARTIFACT_VERSION,
  createNextWorkspaceRevision,
  getNextRequestArtifact,
  putNextRequestArtifact,
  type NextClientModule,
  type NextCompiledModule,
  type NextRequestArtifact,
} from "./artifact";
import {
  NEXT_COMPILER_FINGERPRINT,
  NEXT_COMPILER_VERSION,
  canonicalNextWorkspacePath,
  transformNextModule,
} from "./next-compiler-adapter";
import { buildNextRouteManifest } from "./route-manifest";

const sourceExtensions = [".tsx", ".ts", ".jsx", ".js"] as const;
const maxFileCount = 96;
const maxFileBytes = 250_000;
const maxWorkspaceBytes = 2_000_000;
const runtimeRequire = createRequire(path.join(process.cwd(), "package.json"));

type SourceModule = {
  canonicalPath: string;
  content: string;
  path: string;
};

function normalizeFilePath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.startsWith(".") ||
    normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error(`Unsupported Next workspace path: ${filePath}`);
  }
  return normalized;
}

function sanitizeWorkspaceKey(workspaceKey: string) {
  const normalized = workspaceKey.trim().replace(/[^a-zA-Z0-9_-]/g, "");
  if (!normalized) throw new Error("A stable workspace key is required.");
  return normalized.slice(0, 64);
}

function sanitizeActionSalt(actionSalt: string) {
  const normalized = actionSalt.trim();
  if (normalized.length < 32) {
    throw new Error(
      "The Next Server Action hash salt must contain at least 32 characters.",
    );
  }
  return normalized;
}

function sourceModules(files: WorkspaceFile[], workspaceKey: string) {
  if (files.length === 0)
    throw new Error("At least one workspace file is required.");
  if (files.length > maxFileCount)
    throw new Error("The Next workspace has too many files.");
  const modules = new Map<string, SourceModule>();
  let totalBytes = 0;
  for (const file of files) {
    const normalizedPath = normalizeFilePath(file.path);
    if (
      normalizedPath.endsWith(".d.ts") ||
      !sourceExtensions.some((extension) => normalizedPath.endsWith(extension))
    )
      continue;
    const bytes = Buffer.byteLength(file.content);
    if (bytes > maxFileBytes)
      throw new Error(`Workspace file is too large: ${normalizedPath}`);
    totalBytes += bytes;
    if (totalBytes > maxWorkspaceBytes)
      throw new Error("The Next workspace is too large.");
    if (modules.has(normalizedPath))
      throw new Error(`Duplicate workspace file: ${normalizedPath}`);
    modules.set(normalizedPath, {
      canonicalPath: canonicalNextWorkspacePath(workspaceKey, normalizedPath),
      content: file.content,
      path: normalizedPath,
    });
  }
  return modules;
}

function resolveWorkspaceImport(
  importer: string,
  specifier: string,
  modules: Map<string, SourceModule>,
) {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier),
  );
  const candidates = [
    base,
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) =>
      path.posix.join(base, `index${extension}`),
    ),
  ];
  return candidates.find((candidate) => modules.has(candidate)) ?? null;
}

function importSpecifiers(source: string) {
  const specifiers = new Set<string>();
  const staticImport =
    /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImport = /import\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [staticImport, dynamicImport]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) specifiers.add(match[1]);
  }
  return [...specifiers];
}

function compiledDependencies(
  modulePath: string,
  code: string,
  modules: Map<string, SourceModule>,
) {
  const dependencies = new Set<string>();
  const requirePattern = /require\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = requirePattern.exec(code))) {
    const resolved = resolveWorkspaceImport(modulePath, match[1], modules);
    if (resolved) dependencies.add(resolved);
  }
  return [...dependencies].sort();
}

function contentHash(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

function clientModuleId(modulePath: string) {
  return `next-client-${createHash("sha256").update(modulePath).digest("hex").slice(0, 20)}`;
}

function clientClosure(
  clientEntries: string[],
  modules: Map<string, SourceModule>,
) {
  const closure = new Set<string>();
  const queue = [...clientEntries];
  while (queue.length > 0) {
    const modulePath = queue.shift()!;
    if (closure.has(modulePath)) continue;
    closure.add(modulePath);
    const source = modules.get(modulePath)!;
    const isActionModule = /^[\s;]*(?:["']use server["'];?)/.test(
      source.content,
    );
    if (!isActionModule && /["']server-only["']/.test(source.content)) {
      throw new Error(
        `Client Component graph imports a server-only module: ${modulePath}`,
      );
    }
    if (isActionModule) continue;
    for (const specifier of importSpecifiers(source.content)) {
      const resolved = resolveWorkspaceImport(modulePath, specifier, modules);
      if (!resolved && specifier.startsWith(".")) {
        throw new Error(`Unable to resolve ${specifier} from ${modulePath}.`);
      }
      if (resolved) queue.push(resolved);
    }
  }
  return [...closure].sort();
}

async function buildClientBundle(
  clientModules: Record<string, NextClientModule>,
  clientEntries: string[],
) {
  if (clientEntries.length === 0) {
    return { code: "", entryIds: [], hash: contentHash("") };
  }
  const entrySpecifier = "tuto-next-client-entry";
  const modulePrefix = "tuto-next-client-module:";
  const moduleNamespace = "tuto-next-client-module";
  const sharedNamespace = "tuto-next-client-shared";
  const plugin: Plugin = {
    name: "tuto-next-client-artifact",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^tuto-next-client-entry$/ }, () => ({
        namespace: moduleNamespace,
        path: entrySpecifier,
      }));
      buildApi.onResolve({ filter: /^tuto-next-client-module:/ }, (args) => ({
        namespace: moduleNamespace,
        path: args.path.slice(modulePrefix.length),
      }));
      buildApi.onResolve(
        { filter: /^\.?\.?\//, namespace: moduleNamespace },
        (args) => {
          const resolved = resolveWorkspaceImport(
            args.importer,
            args.path,
            new Map(
              Object.values(clientModules).map((module) => [
                module.path,
                {
                  canonicalPath: module.canonicalPath,
                  content: "",
                  path: module.path,
                },
              ]),
            ),
          );
          if (!resolved)
            return {
              errors: [
                {
                  text: `Unable to resolve ${args.path} from ${args.importer}.`,
                },
              ],
            };
          return { namespace: moduleNamespace, path: resolved };
        },
      );
      buildApi.onResolve(
        { filter: /^react(?:\/jsx-(?:dev-)?runtime)?$/ },
        (args) => ({
          namespace: sharedNamespace,
          path: args.path,
        }),
      );
      buildApi.onResolve(
        { filter: /^private-next-rsc-action-client-wrapper$/ },
        (args) => ({
          namespace: sharedNamespace,
          path: args.path,
        }),
      );
      buildApi.onResolve({ filter: /^@swc\/helpers\// }, (args) => ({
        path: runtimeRequire.resolve(args.path),
      }));
      buildApi.onLoad({ filter: /.*/, namespace: moduleNamespace }, (args) => {
        if (args.path === entrySpecifier) {
          const imports = clientEntries
            .map(
              (modulePath, index) =>
                `import * as module${index} from ${JSON.stringify(`${modulePrefix}${modulePath}`)};`,
            )
            .join("\n");
          const registrations = clientEntries
            .map(
              (modulePath, index) =>
                `globalThis.__TUTO_NEXT_CLIENT_MODULES__[${JSON.stringify(clientModules[modulePath].id)}] = module${index};`,
            )
            .join("\n");
          return {
            contents: `${imports}\nglobalThis.__TUTO_NEXT_CLIENT_MODULES__ ||= Object.create(null);\n${registrations}`,
            loader: "js",
          };
        }
        const clientModule = clientModules[args.path];
        if (!clientModule) {
          return { errors: [{ text: `Missing browser module ${args.path}.` }] };
        }
        return { contents: clientModule.code, loader: "js" };
      });
      buildApi.onLoad({ filter: /.*/, namespace: sharedNamespace }, (args) => ({
        contents:
          args.path === "private-next-rsc-action-client-wrapper"
            ? "module.exports = globalThis.__TUTO_NEXT_CLIENT_KERNEL__.actionClient;"
            : `module.exports = globalThis.__TUTO_NEXT_CLIENT_KERNEL__.modules[${JSON.stringify(args.path)}];`,
        loader: "js",
      }));
    },
  };
  const result = await build({
    bundle: true,
    entryPoints: [entrySpecifier],
    format: "iife",
    logLevel: "silent",
    minify: true,
    platform: "browser",
    plugins: [plugin],
    target: "es2022",
    write: false,
  });
  const code = result.outputFiles[0].text;
  return {
    code,
    entryIds: clientEntries.map((modulePath) => clientModules[modulePath].id),
    hash: contentHash(code),
  };
}

export type NextWorkspaceCompileResult = {
  artifact: NextRequestArtifact;
  artifactCache: "hot" | "miss";
};

export async function compileNextRequestWorkspaceWithStatus(
  files: WorkspaceFile[],
  options: {
    serverReferenceHashSalt: string;
    workspaceKey: string;
  },
): Promise<NextWorkspaceCompileResult> {
  const startedAt = performance.now();
  const workspaceKey = sanitizeWorkspaceKey(options.workspaceKey);
  const actionSalt = sanitizeActionSalt(options.serverReferenceHashSalt);
  const modules = sourceModules(files, workspaceKey);
  const router = buildNextRouteManifest(modules.keys());
  const revision = createNextWorkspaceRevision(
    files,
    workspaceKey,
    `${NEXT_COMPILER_FINGERPRINT}:${clientKernelManifest.id}:${createHash("sha256").update(actionSalt).digest("hex")}`,
  );
  const cachedArtifact = getNextRequestArtifact(revision);
  if (cachedArtifact) {
    return { artifact: cachedArtifact, artifactCache: "hot" };
  }

  const serverModules: Record<string, NextCompiledModule> = {};
  const clientEntries: string[] = [];
  const actionManifest: NextRequestArtifact["actionManifest"] = {};
  let serverTransformCacheHits = 0;
  for (const source of modules.values()) {
    const transformed = await transformNextModule({
      actionSalt,
      canonicalPath: source.canonicalPath,
      source: source.content,
      target: "server",
    });
    if (transformed.cacheHit) serverTransformCacheHits++;
    if (transformed.metadata.rscType === "client")
      clientEntries.push(source.path);
    for (const [actionId, exportName] of Object.entries(
      transformed.metadata.actionIds,
    )) {
      actionManifest[actionId] = { exportName, modulePath: source.path };
    }
    serverModules[source.path] = {
      canonicalPath: source.canonicalPath,
      code: transformed.code,
      dependencies: compiledDependencies(
        source.path,
        transformed.code,
        modules,
      ),
      hash: contentHash(transformed.code),
      path: source.path,
    };
  }

  const clientModules: Record<string, NextClientModule> = {};
  let browserTransformCacheHits = 0;
  for (const modulePath of clientClosure(clientEntries, modules)) {
    const source = modules.get(modulePath)!;
    const transformed = await transformNextModule({
      actionSalt,
      canonicalPath: source.canonicalPath,
      source: source.content,
      target: "browser",
    });
    if (transformed.cacheHit) browserTransformCacheHits++;
    clientModules[modulePath] = {
      canonicalPath: source.canonicalPath,
      code: transformed.code,
      dependencies: compiledDependencies(
        source.path,
        transformed.code,
        modules,
      ),
      hash: contentHash(transformed.code),
      id: clientModuleId(source.path),
      path: source.path,
    };
  }

  const clientReferenceManifest = Object.fromEntries(
    clientEntries.sort().map((modulePath) => {
      const source = modules.get(modulePath)!;
      return [
        source.canonicalPath,
        {
          async: false,
          chunks: [],
          id: clientModules[modulePath].id,
          name: "*",
        },
      ];
    }),
  );
  const clientBundle = await buildClientBundle(clientModules, clientEntries);

  const artifact: NextRequestArtifact = {
    actionManifest: Object.fromEntries(Object.entries(actionManifest).sort()),
    buildMetrics: {
      browserTransformCacheHits,
      browserTransforms: Object.keys(clientModules).length,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      serverTransformCacheHits,
      serverTransforms: Object.keys(serverModules).length,
    },
    clientBundle,
    clientModules,
    clientReferenceManifest,
    generation: revision.slice(0, 20),
    kernelId: clientKernelManifest.id,
    nextVersion: NEXT_COMPILER_VERSION,
    revision,
    router,
    serverModules,
    version: NEXT_REQUEST_ARTIFACT_VERSION,
    workspaceKey,
  };
  putNextRequestArtifact(artifact);
  return { artifact, artifactCache: "miss" };
}

export async function compileNextRequestWorkspace(
  files: WorkspaceFile[],
  options: {
    serverReferenceHashSalt: string;
    workspaceKey: string;
  },
): Promise<NextRequestArtifact> {
  return (await compileNextRequestWorkspaceWithStatus(files, options)).artifact;
}
