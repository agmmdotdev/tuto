import fs from "node:fs/promises";
import path from "node:path";
import { routePattern, routePatternParts } from "./vendor/vinext-routing/route-pattern";
import { compareRoutes } from "./vendor/vinext-routing/utils";

export type NextLiteRoute = {
  kind: "page";
  pathname: string;
  pattern: string;
  patternParts: string[];
  pageFile: string;
  layoutFiles: string[];
  layoutFile: string | null;
} | {
  kind: "route-handler";
  pathname: string;
  pattern: string;
  patternParts: string[];
  routeFile: string;
  pageFile?: never;
  layoutFiles?: never;
  layoutFile?: never;
};

const pageFileNames = ["page.tsx", "page.ts", "page.jsx", "page.js"];
const layoutFileNames = ["layout.tsx", "layout.ts", "layout.jsx", "layout.js"];
const routeHandlerFileNames = ["route.ts", "route.tsx", "route.js", "route.jsx"];

async function findFirstExistingFile(directory: string, fileNames: readonly string[]) {
  for (const fileName of fileNames) {
    const filePath = path.join(directory, fileName);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) return filePath;
    } catch {
      // Try the next convention.
    }
  }

  return null;
}

function isPageFile(fileName: string) {
  return pageFileNames.includes(fileName);
}

function isRouteHandlerFile(fileName: string) {
  return routeHandlerFileNames.includes(fileName);
}

function isInvisibleAppSegment(segment: string) {
  return (
    (segment.startsWith("(") && segment.endsWith(")")) ||
    segment.startsWith("@") ||
    segment === "_private"
  );
}

function pageDirectoryToPathname(appDir: string, pageDirectory: string) {
  const relativeDirectory = path.relative(appDir, pageDirectory);
  const segments = relativeDirectory
    ? relativeDirectory.split(path.sep).filter((segment) => segment && !isInvisibleAppSegment(segment))
    : [];

  return segments.length > 0 ? `/${segments.join("/")}` : "/";
}

async function findLayoutChain(appDir: string, pageDirectory: string) {
  const relativeDirectory = path.relative(appDir, pageDirectory);
  const segments = relativeDirectory ? relativeDirectory.split(path.sep).filter(Boolean) : [];
  const directories = [appDir];
  let currentDirectory = appDir;

  for (const segment of segments) {
    currentDirectory = path.join(currentDirectory, segment);
    directories.push(currentDirectory);
  }

  const layoutFiles: string[] = [];

  for (const directory of directories) {
    const layoutFile = await findFirstExistingFile(directory, layoutFileNames);
    if (layoutFile) {
      layoutFiles.push(layoutFile);
    }
  }

  return layoutFiles;
}

async function scanRouteFiles(
  appDir: string,
  directory = appDir,
): Promise<Array<{ kind: "page" | "route-handler"; filePath: string }>> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const routeFiles: Array<{ kind: "page" | "route-handler"; filePath: string }> = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      routeFiles.push(...(await scanRouteFiles(appDir, entryPath)));
      continue;
    }

    if (entry.isFile() && isPageFile(entry.name)) {
      routeFiles.push({ kind: "page", filePath: entryPath });
    } else if (entry.isFile() && isRouteHandlerFile(entry.name)) {
      routeFiles.push({ kind: "route-handler", filePath: entryPath });
    }
  }

  return routeFiles;
}

function assertNoPageHandlerConflicts(routes: readonly NextLiteRoute[]) {
  const pagePathnames = new Set(
    routes.filter((route) => route.kind === "page").map((route) => route.pathname),
  );
  const handlerConflict = routes.find(
    (route) => route.kind === "route-handler" && pagePathnames.has(route.pathname),
  );

  if (handlerConflict) {
    throw new Error(
      `next-lite does not support app/page and app/route at the same pathname: ${handlerConflict.pathname}`,
    );
  }
}

export async function discoverNextLiteRoutes(workspaceRoot: string): Promise<NextLiteRoute[]> {
  const appDir = path.join(workspaceRoot, "app");
  const routeFiles = await scanRouteFiles(appDir);

  if (routeFiles.length === 0) {
    throw new Error("next-lite requires at least one app/**/page or app/**/route file.");
  }

  const routes = await Promise.all(
    routeFiles.map(async ({ kind, filePath }) => {
      const pathname = pageDirectoryToPathname(appDir, path.dirname(filePath));

      if (kind === "route-handler") {
        return {
          kind,
          pathname,
          pattern: routePattern(pathname),
          patternParts: routePatternParts(pathname),
          routeFile: filePath,
        };
      }

      const layoutFiles = await findLayoutChain(appDir, path.dirname(filePath));
      return {
        kind: "page" as const,
        pathname,
        pattern: routePattern(pathname),
        patternParts: routePatternParts(pathname),
        pageFile: filePath,
        layoutFiles,
        layoutFile: layoutFiles[0] ?? null,
      };
    }),
  );

  assertNoPageHandlerConflicts(routes);

  return routes.sort(compareRoutes);
}
