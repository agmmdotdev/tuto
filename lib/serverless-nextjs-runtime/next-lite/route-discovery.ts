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
};

const pageFileNames = ["page.tsx", "page.ts", "page.jsx", "page.js"];
const layoutFileNames = ["layout.tsx", "layout.ts", "layout.jsx", "layout.js"];

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

async function scanPageFiles(appDir: string, directory = appDir): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const pageFiles: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      pageFiles.push(...(await scanPageFiles(appDir, entryPath)));
      continue;
    }

    if (entry.isFile() && isPageFile(entry.name)) {
      pageFiles.push(entryPath);
    }
  }

  return pageFiles;
}

export async function discoverNextLiteRoutes(workspaceRoot: string): Promise<NextLiteRoute[]> {
  const appDir = path.join(workspaceRoot, "app");
  const pageFiles = await scanPageFiles(appDir);

  if (pageFiles.length === 0) {
    throw new Error("next-lite requires at least one app/**/page file.");
  }

  const routes = await Promise.all(
    pageFiles.map(async (pageFile) => {
      const layoutFiles = await findLayoutChain(appDir, path.dirname(pageFile));
      const pathname = pageDirectoryToPathname(appDir, path.dirname(pageFile));
      return {
        kind: "page" as const,
        pathname,
        pattern: routePattern(pathname),
        patternParts: routePatternParts(pathname),
        pageFile,
        layoutFiles,
        layoutFile: layoutFiles[0] ?? null,
      };
    }),
  );

  return routes.sort(compareRoutes);
}
