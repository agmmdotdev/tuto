import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const BUILD = join(ROOT, "fixture", ".next");
const SERVER = join(BUILD, "server");

const appRoutes = readJson("app-path-routes-manifest.json");
const appPaths = readJson("server/app-paths-manifest.json");
const pages = readJson("server/pages-manifest.json");
const routes = readJson("routes-manifest.json");
const actionManifest = readJson("server/server-reference-manifest.json");
const middlewareManifest = readJson("server/middleware-manifest.json");
const homeClientManifest = readClientManifest(
  join(SERVER, "app", "page_client-reference-manifest.js"),
  "/page",
);

const report = {
  buildId: readFileSync(join(BUILD, "BUILD_ID"), "utf8").trim(),
  routes: {
    appPathToRoute: appRoutes,
    appPathToBundle: appPaths,
    pagesPathToBundle: pages,
    static: routes.staticRoutes.map(({ page, regex }) => ({ page, regex })),
    dynamic: routes.dynamicRoutes.map(({ page, regex, routeKeys }) => ({
      page,
      regex,
      routeKeys,
    })),
  },
  serverActions: {
    count: Object.keys(actionManifest.node).length + Object.keys(actionManifest.edge).length,
    node: actionManifest.node,
    edge: actionManifest.edge,
    encryptionKeySha256: sha256(actionManifest.encryptionKey),
  },
  middleware: {
    names: Object.keys(middlewareManifest.middleware),
    sorted: middlewareManifest.sortedMiddleware,
    entries: Object.fromEntries(
      Object.entries(middlewareManifest.middleware).map(([name, value]) => [
        name,
        {
          files: value.files,
          entrypoint: value.entrypoint,
          matchers: value.matchers,
          wasmCount: value.wasm.length,
          assetCount: value.assets.length,
        },
      ]),
    ),
  },
  homeClientReferences: {
    clientModuleCount: Object.keys(homeClientManifest.clientModules).length,
    studentClientModules: Object.keys(homeClientManifest.clientModules)
      .filter((path) => path.includes("/fixture/app/"))
      .map((path) => ({
        path: path.slice(path.indexOf("/fixture/") + 9),
        ...homeClientManifest.clientModules[path],
      })),
    ssrMappingCount: Object.keys(homeClientManifest.ssrModuleMapping).length,
    rscMappingCount: Object.keys(homeClientManifest.rscModuleMapping).length,
  },
  artifact: summarizeTree(BUILD),
  standalone: summarizeTree(join(BUILD, "standalone")),
};

writeFileSync(
  join(ROOT, "build-results.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));

function readJson(path) {
  return JSON.parse(readFileSync(join(BUILD, path), "utf8"));
}
function readClientManifest(path, page) {
  const source = readFileSync(path, "utf8");
  const marker = `globalThis.__RSC_MANIFEST[${JSON.stringify(page)}]=`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing client manifest entry for ${page}`);
  return JSON.parse(source.slice(start + marker.length, -1));
}

function summarizeTree(root) {
  let files = 0;
  let bytes = 0;
  visit(root);
  return { files, bytes, mebibytes: Math.round((bytes / 1024 / 1024) * 100) / 100 };

  function visit(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      const targetMetadata = metadata.isSymbolicLink() ? statSync(path) : metadata;
      if (targetMetadata.isDirectory()) {
        visit(path);
      } else {
        files += 1;
        bytes += targetMetadata.size;
      }
    }
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
