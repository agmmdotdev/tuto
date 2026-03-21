import type { NextConfig } from "next";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const projectRoot = process.cwd();
const isVercel = process.env.VERCEL === "1";

function toProjectGlob(absoluteDirectoryPath: string) {
  const relativePath = relative(projectRoot, absoluteDirectoryPath).replaceAll("\\", "/");
  return `./${relativePath}/**/*`;
}

function findPackageManifestPath(packageName: string) {
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch {
    const entryPath = require.resolve(packageName);
    let currentDirectory = dirname(entryPath);

    while (true) {
      const candidatePath = join(currentDirectory, "package.json");

      if (existsSync(candidatePath)) {
        return candidatePath;
      }

      const parentDirectory = dirname(currentDirectory);

      if (parentDirectory === currentDirectory) {
        throw new Error(`Unable to locate package.json for ${packageName}.`);
      }

      currentDirectory = parentDirectory;
    }
  }
}

function readPackageManifest(packageName: string) {
  const manifestPath = findPackageManifestPath(packageName);
  const packageDirectory = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };

  return {
    manifest,
    packageDirectory,
  };
}

function collectRuntimePackageGlobs(seedPackages: string[]) {
  const visited = new Set<string>();
  const packageGlobs = new Set<string>();
  const queue = [...seedPackages];

  while (queue.length > 0) {
    const packageName = queue.shift();

    if (!packageName || visited.has(packageName)) {
      continue;
    }

    visited.add(packageName);

    try {
      const { manifest, packageDirectory } = readPackageManifest(packageName);
      packageGlobs.add(toProjectGlob(packageDirectory));

      for (const dependencyName of Object.keys({
        ...(manifest.dependencies ?? {}),
        ...(manifest.optionalDependencies ?? {}),
      })) {
        if (!visited.has(dependencyName)) {
          queue.push(dependencyName);
        }
      }
    } catch {
      // Skip packages that are not installed for the current environment.
    }
  }

  return [...packageGlobs].sort();
}

const serverlessCompileTraceGlobs = [
  "./lib/serverless-vite/**/*.cjs",
  "./node_modules/@esbuild/**/*",
  ...collectRuntimePackageGlobs([
    "esbuild",
    "react",
    "react-dom",
    "lucide-react",
    "motion",
  ]),
];

const serverlessExpressRequestTraceGlobs = [
  "./lib/serverless-express/**/*.cjs",
  "./node_modules/@esbuild/**/*",
  ...collectRuntimePackageGlobs([
    "esbuild",
    "express",
  ]),
];

const serverlessNextjsRuntimeRequestTraceGlobs = [
  "./lib/serverless-nextjs-runtime/**/*.cjs",
  ...collectRuntimePackageGlobs([
    "next",
    "react",
    "react-dom",
  ]),
];

const serverlessTypeTraceGlobs = collectRuntimePackageGlobs([
  "react",
  "react-dom",
  "motion",
  "@types/react",
  "@types/react-dom",
]);

const serverlessExpressTypeTraceGlobs = collectRuntimePackageGlobs([
  "express",
  "@types/express",
  "@types/node",
]);

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "127.0.0.1",
    "::1",
  ],
  outputFileTracingIncludes: {
    "/api/serverless/compile": serverlessCompileTraceGlobs,
    "/api/serverless/expressjs/request": serverlessExpressRequestTraceGlobs,
    "/api/serverless/expressjs/types": serverlessExpressTypeTraceGlobs,
    "/api/serverless/types": serverlessTypeTraceGlobs,
    ...(!isVercel
      ? {
          "/api/serverless/nextjs-runtime/request":
            serverlessNextjsRuntimeRequestTraceGlobs,
        }
      : {}),
  },
};

export default nextConfig;
