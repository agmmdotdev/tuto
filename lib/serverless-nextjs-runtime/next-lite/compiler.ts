import fs from "node:fs/promises";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import { discoverNextLiteRoutes, type NextLiteRoute } from "./route-discovery";

export type NextLiteBuildArtifact = {
  entryFile: string;
  routes: NextLiteRoute[];
};

export type NextLiteBuildOptions = {
  outDir: string;
  workspaceRoot: string;
};

function toImportSpecifier(fromDirectory: string, filePath: string) {
  let relativePath = path.relative(fromDirectory, filePath).replaceAll(path.sep, "/");

  if (!relativePath.startsWith(".")) {
    relativePath = `./${relativePath}`;
  }

  return relativePath;
}

function createNextServerShimPlugin(): Plugin {
  const shimPath = path.join(
    process.cwd(),
    "lib/serverless-nextjs-runtime/next-lite/next-server-shim.ts",
  );

  return {
    name: "next-lite-next-server-shim",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^next\/server$/ }, () => ({ path: shimPath }));
    },
  };
}

function generateRuntimeEntries(routes: NextLiteRoute[], entryDirectory: string) {
  const matcherImport = toImportSpecifier(
    entryDirectory,
    path.join(
      process.cwd(),
      "lib/serverless-nextjs-runtime/next-lite/vendor/vinext-routing/route-matching.ts",
    ),
  );
  const routeHandlerPolicyImport = toImportSpecifier(
    entryDirectory,
    path.join(process.cwd(), "lib/serverless-nextjs-runtime/next-lite/route-handler-policy.ts"),
  );
  const imports = routes
    .map((route, index) => {
      if (route.kind === "route-handler") {
        const routeHandlerImport = toImportSpecifier(entryDirectory, route.routeFile);
        return `import * as RouteHandler${index} from ${JSON.stringify(routeHandlerImport)};`;
      }

      const pageImport = toImportSpecifier(entryDirectory, route.pageFile);
      const layoutImports = route.layoutFiles
        .map((layoutFile, layoutIndex) => {
          const layoutImport = toImportSpecifier(entryDirectory, layoutFile);
          return `import Layout${index}_${layoutIndex} from ${JSON.stringify(layoutImport)};`;
        })
        .join("\n");
      return `import Page${index} from ${JSON.stringify(pageImport)};
${layoutImports}`;
    })
    .join("\n");
  const routeEntries = routes
    .map((route, index) =>
      JSON.stringify({
        index,
        kind: route.kind,
        pathname: route.pathname,
        pattern: route.pattern,
        patternParts: route.patternParts,
      }),
    )
    .join(",\n  ");
  const componentEntries = routes
    .map((route, index) => {
      if (route.kind !== "page") return "";

      const layouts =
        route.layoutFiles.length > 0
          ? route.layoutFiles
              .map((_, layoutIndex) => `Layout${index}_${layoutIndex}`)
              .join(", ")
          : "DefaultLayout";
      return `  ${index}: { Page: Page${index}, Layouts: [${layouts}] },`;
    })
    .filter(Boolean)
    .join("\n");
  const routeHandlerEntries = routes
    .map((route, index) => {
      if (route.kind !== "route-handler") return "";
      return `  ${index}: RouteHandler${index},`;
    })
    .filter(Boolean)
    .join("\n");

  return `import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { createRouteTrieCache, matchRouteWithTrie } from ${JSON.stringify(matcherImport)};
import {
  digestResponseToResponse,
  isValidHTTPMethod,
  resolveRouteHandlerMethod,
  resolveRouteHandlerSpecialError,
} from ${JSON.stringify(routeHandlerPolicyImport)};
${imports}

function DefaultLayout({ children }) {
  return React.createElement("html", null, React.createElement("body", null, children));
}

const routes = [
  ${routeEntries}
];
const routeComponents = {
${componentEntries}
};
const routeHandlers = {
${routeHandlerEntries}
};
const routeTrieCache = createRouteTrieCache();

function assertComponent(value, label) {
  if (typeof value !== "function") {
    throw new Error(label + " must default-export a React component.");
  }
}

function composeLayouts(layouts, pageElement) {
  return layouts.reduceRight(
    (children, Layout) => React.createElement(Layout, null, children),
    pageElement,
  );
}

function searchParamsToObject(searchParams) {
  const result = Object.create(null);
  for (const [key, value] of searchParams) {
    const existing = result[key];
    if (existing === undefined) {
      result[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[key] = [existing, value];
    }
  }
  return result;
}

async function runRouteHandler(request, match) {
  const method = request.method.toUpperCase();

  if (!isValidHTTPMethod(method)) {
    return new Response("Bad request", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const handlerModule = routeHandlers[match.route.index];
  const resolved = resolveRouteHandlerMethod(handlerModule, method);

  if (resolved.shouldAutoRespondToOptions) {
    return new Response(null, {
      status: 204,
      headers: { allow: resolved.allowHeaderForOptions },
    });
  }

  if (typeof resolved.handlerFn !== "function") {
    return new Response("Method not allowed", {
      status: 405,
      headers: {
        allow: resolved.allowHeaderForOptions,
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  let response;
  try {
    response = await resolved.handlerFn(request, { params: match.params });
  } catch (error) {
    const specialResponse = digestResponseToResponse(
      resolveRouteHandlerSpecialError(error, request.url),
    );
    if (specialResponse) return specialResponse;
    throw error;
  }

  if (!(response instanceof Response)) {
    throw new Error("app/route handler must return a Response.");
  }

  if (resolved.isAutoHead) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  return response;
}

export async function renderNextLiteRequest(request) {
  const url = new URL(request.url);
  const match = matchRouteWithTrie(url.pathname, routes, routeTrieCache);
  if (!match) {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (match.route.kind === "route-handler") {
    return runRouteHandler(request, match);
  }

  const components = routeComponents[match.route.index];
  const Page = components.Page;
  const Layouts = components.Layouts;

  assertComponent(Page, "app/page");
  for (const [index, Layout] of Layouts.entries()) {
    assertComponent(Layout, "app/layout[" + index + "]");
  }

  const pageProps = {
    params: match.params,
    searchParams: searchParamsToObject(url.searchParams),
  };
  const tree = composeLayouts(Layouts, React.createElement(Page, pageProps));
  const stream = await renderToReadableStream(tree);

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
`;
}

export async function buildNextLiteApp(
  options: NextLiteBuildOptions,
): Promise<NextLiteBuildArtifact> {
  const routes = await discoverNextLiteRoutes(options.workspaceRoot);
  const rootRoute = routes[0];

  if (!rootRoute) {
    throw new Error("next-lite did not discover any routes.");
  }

  await fs.rm(options.outDir, { recursive: true, force: true });
  await fs.mkdir(options.outDir, { recursive: true });

  const sourceEntryFile = path.join(options.outDir, "next-lite-entry.generated.mjs");
  const bundledEntryFile = path.join(options.outDir, "server-entry.mjs");
  await fs.writeFile(sourceEntryFile, generateRuntimeEntries(routes, options.outDir));

  await build({
    entryPoints: [sourceEntryFile],
    outfile: bundledEntryFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    jsx: "automatic",
    logLevel: "silent",
    nodePaths: [path.join(process.cwd(), "node_modules")],
    plugins: [createNextServerShimPlugin()],
  });

  return {
    entryFile: bundledEntryFile,
    routes,
  };
}
