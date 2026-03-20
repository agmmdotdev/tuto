import "server-only";

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EditorTypeLibrary } from "@/lib/ide/types";

async function pathExists(path: string) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string) {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

const declarationExtensions = [
  ".d.ts",
  ".d.mts",
  ".d.cts",
  ".ts",
  ".mts",
  ".cts",
];

function replaceRuntimeExtension(filePath: string) {
  if (typeof filePath !== "string") {
    return "";
  }

  return filePath.replace(/\.(mjs|cjs|js|jsx|ts|tsx)$/i, "");
}

function toTypePackageName(packageName: string) {
  if (packageName.startsWith("@types/")) {
    return packageName;
  }

  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.split("/");
    return `@types/${scope.slice(1)}__${name}`;
  }

  return `@types/${packageName}`;
}

function splitPackageSpecifier(specifier: string) {
  if (typeof specifier !== "string") {
    return {
      packageName: "",
      subpath: "",
    };
  }

  const parts = specifier.split("/");

  if (specifier.startsWith("@")) {
    return {
      packageName: parts.slice(0, 2).join("/"),
      subpath: parts.slice(2).join("/"),
    };
  }

  return {
    packageName: parts[0] ?? specifier,
    subpath: parts.slice(1).join("/"),
  };
}

function resolvePackageDir(nodeModulesDir: string, packageName: string) {
  return resolve(nodeModulesDir, ...packageName.split("/"));
}

async function resolveDeclarationPath(baseDir: string, specifier: string) {
  if (typeof specifier !== "string" || !specifier) {
    return null;
  }

  const normalizedSpecifier = replaceRuntimeExtension(specifier);
  const candidates = new Set<string>([
    resolve(baseDir, normalizedSpecifier),
    ...declarationExtensions.map((extension) =>
      resolve(baseDir, `${normalizedSpecifier}${extension}`),
    ),
    ...declarationExtensions.map((extension) =>
      resolve(baseDir, normalizedSpecifier, `index${extension}`),
    ),
  ]);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function extractRelativeTypeSpecifiers(content: string) {
  const specifiers = new Set<string>();
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/g,
    /import\(["'](\.[^"']+)["']\)/g,
    /<reference\s+path=["'](\.[^"']+)["']\s*\/>/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];

      if (specifier) {
        specifiers.add(specifier);
      }
    }
  }

  return [...specifiers];
}

async function collectDeclarationGraph(
  rootDir: string,
  entryPaths: string[],
): Promise<Array<{ relativePath: string; content: string }>> {
  const queue = [...entryPaths];
  const visited = new Set<string>();
  const files: Array<{ relativePath: string; content: string }> = [];

  while (queue.length > 0) {
    const currentPath = queue.shift();

    if (!currentPath || visited.has(currentPath) || !(await fileExists(currentPath))) {
      continue;
    }

    visited.add(currentPath);
    const content = await readFile(currentPath, "utf8");

    files.push({
      relativePath: currentPath.slice(rootDir.length + 1),
      content,
    });

    for (const specifier of extractRelativeTypeSpecifiers(content)) {
      const dependencyPath = await resolveDeclarationPath(dirname(currentPath), specifier);

      if (dependencyPath?.startsWith(rootDir)) {
        queue.push(dependencyPath);
      }
    }
  }

  return files;
}

async function resolvePackageEntryPaths(
  packageDir: string,
  packageName: string,
  subpath = "",
) {
  const packageJsonPath = resolve(packageDir, "package.json");
  const entryPaths = [packageJsonPath];

  const packageJson = JSON.parse(
    await readFile(packageJsonPath, "utf8"),
  ) as {
    types?: string;
    typings?: string;
    exports?:
      | string
      | Record<
          string,
          string | { types?: string; import?: string; require?: string; default?: string }
        >;
  };
  const exportKey = subpath ? `./${subpath}` : ".";
  const exportValue =
    typeof packageJson.exports === "object" && packageJson.exports
      ? packageJson.exports[exportKey]
      : undefined;
  const exportedTypes =
    typeof exportValue === "string"
      ? exportValue
      : typeof exportValue === "object" && exportValue
        ? exportValue.types
        : undefined;
  const candidates = [
    exportedTypes,
    subpath ? `${subpath}.d.ts` : undefined,
    subpath ? `${subpath}.d.mts` : undefined,
    subpath ? `${subpath}.d.cts` : undefined,
    !subpath ? packageJson.types : undefined,
    !subpath ? packageJson.typings : undefined,
    !subpath ? "index.d.ts" : undefined,
    !subpath ? "index.d.mts" : undefined,
    !subpath ? "index.d.cts" : undefined,
  ].filter((candidate): candidate is string => typeof candidate === "string");

  for (const candidate of candidates) {
    const resolvedEntry = await resolveDeclarationPath(packageDir, candidate);

    if (resolvedEntry) {
      entryPaths.push(resolvedEntry);
      break;
    }
  }

  if (packageName === "react-dom" && !subpath) {
    const clientEntry = await resolveDeclarationPath(packageDir, "client");

    if (clientEntry) {
      entryPaths.push(clientEntry);
    }
  }

  if (packageName === "@types/react-dom" && !subpath) {
    const clientEntry = await resolveDeclarationPath(packageDir, "client");

    if (clientEntry) {
      entryPaths.push(clientEntry);
    }
  }

  return entryPaths;
}

export async function collectTypePackageNames(
  nodeModulesDir: string,
  seedPackageNames: string[],
) {
  const queue = [...seedPackageNames];
  const visited = new Set<string>();
  const resolved = new Set<string>();

  while (queue.length > 0) {
    const packageSpecifier = queue.shift();

    if (
      typeof packageSpecifier !== "string" ||
      !packageSpecifier ||
      visited.has(packageSpecifier)
    ) {
      continue;
    }

    visited.add(packageSpecifier);
    const { packageName } = splitPackageSpecifier(packageSpecifier);

    const packageDir = resolvePackageDir(nodeModulesDir, packageName);

    if (!(await pathExists(resolve(packageDir, "package.json")))) {
      const fallbackTypePackage = toTypePackageName(packageName);

      if (fallbackTypePackage !== packageName) {
        queue.push(fallbackTypePackage);
      }

      continue;
    }

    resolved.add(packageSpecifier);

    const packageJson = JSON.parse(
      await readFile(resolve(packageDir, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      types?: string;
      typings?: string;
    };

    if (
      !packageJson.types &&
      !packageJson.typings &&
      !packageName.startsWith("@types/")
    ) {
      queue.push(toTypePackageName(packageName));
    }

    for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
      queue.push(dependencyName);
    }

    for (const dependencyName of Object.keys(
      packageJson.optionalDependencies ?? {},
    )) {
      queue.push(dependencyName);
    }
  }

  return [...resolved];
}

export async function readTypeLibraryFiles(
  nodeModulesDir: string,
  packageSpecifier: string,
) {
  const { packageName, subpath } = splitPackageSpecifier(packageSpecifier);
  let packageDir = resolvePackageDir(nodeModulesDir, packageName);
  let packageJsonPath = resolve(packageDir, "package.json");
  let canonicalPackageName = packageName;

  if (!(await fileExists(packageJsonPath))) {
    return [];
  }

  let entryPaths = await resolvePackageEntryPaths(packageDir, packageName, subpath);

  if (entryPaths.length <= 1 && !packageName.startsWith("@types/")) {
    const typePackageName = toTypePackageName(packageName);
    const typePackageDir = resolvePackageDir(nodeModulesDir, typePackageName);
    const typePackageJsonPath = resolve(typePackageDir, "package.json");

    if (await fileExists(typePackageJsonPath)) {
      const typeEntryPaths = await resolvePackageEntryPaths(
        typePackageDir,
        typePackageName,
        subpath,
      );

      if (typeEntryPaths.length > 1) {
        packageDir = typePackageDir;
        packageJsonPath = typePackageJsonPath;
        canonicalPackageName = typePackageName;
        entryPaths = typeEntryPaths;
      }
    }
  }

  const files = await collectDeclarationGraph(packageDir, entryPaths);
  const aliasFilePath =
    canonicalPackageName !== packageName || subpath
      ? subpath
        ? `node_modules/${packageName}/${subpath}.d.ts`
        : `node_modules/${packageName}/index.d.ts`
      : null;
  const aliasEntryPath =
    aliasFilePath && entryPaths.length > 1
      ? entryPaths.find((entryPath) => entryPath !== packageJsonPath) ?? null
      : null;
  const aliasLibrary =
    aliasFilePath && aliasEntryPath
      ? [
          {
            filePath: aliasFilePath.replaceAll("\\", "/"),
            content: await readFile(aliasEntryPath, "utf8"),
          },
        ]
      : [];

  return [
    ...aliasLibrary,
    ...files.map(({ content, relativePath }) => ({
      filePath: `node_modules/${canonicalPackageName}/${relativePath.replaceAll("\\", "/")}`,
      content,
    })),
  ] satisfies EditorTypeLibrary[];
}

export async function collectInstalledTypeLibraries(
  nodeModulesDir: string,
  seedPackageNames: string[],
) {
  const packageNames = await collectTypePackageNames(nodeModulesDir, seedPackageNames);
  const libraries = await Promise.all(
    packageNames.map((packageName) => readTypeLibraryFiles(nodeModulesDir, packageName)),
  );

  return libraries.flat();
}
