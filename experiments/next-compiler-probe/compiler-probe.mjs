import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = new URL(".", import.meta.url).pathname;
const FIXTURE = join(ROOT, "fixture");
const ACTION_SALT = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const requireNext = createRequire(join(FIXTURE, "package.json"));

const { loadBindings, transform } = requireNext("next/dist/build/swc");
const { getLoaderSWCOptions } = requireNext("next/dist/build/swc/options");
const {
  getAppPageStaticInfo,
  getPagesPageStaticInfo,
  getRSCModuleInformation,
} = requireNext("next/dist/build/analysis/get-page-static-info");
const { findPagesDir } = requireNext("next/dist/lib/find-pages-dir");
const { getAppEntry } = requireNext("next/dist/build/entries");
const { PAGE_TYPES } = requireNext("next/dist/lib/page-types");
const { WEBPACK_LAYERS } = requireNext("next/dist/lib/constants");
const { getRouteRegex } = requireNext("next/dist/shared/lib/router/utils/route-regex");
const { getRouteMatcher } = requireNext("next/dist/shared/lib/router/utils/route-matcher");
const { normalizePagePath } = requireNext(
  "next/dist/shared/lib/page-path/normalize-page-path",
);

const report = {
  environment: {
    node: process.version,
    next: requireNext("next/package.json").version,
    platform: `${process.platform}-${process.arch}`,
  },
  timings: {},
  transforms: {},
  analysis: {},
  routing: {},
  entries: {},
};

const bindingStartedAt = performance.now();
await loadBindings();
report.timings.loadBindingsMs = elapsed(bindingStartedAt);

const cases = [
  {
    name: "server-component",
    filename: "app/virtual-server-page.tsx",
    layer: WEBPACK_LAYERS.reactServerComponents,
    isServer: true,
    serverComponents: true,
    source: `
      export default async function Page() {
        const value: string = await Promise.resolve("server-component");
        return <h1>{value}</h1>;
      }
    `,
  },
  {
    name: "client-component-seen-from-rsc",
    filename: "app/virtual-client.tsx",
    layer: WEBPACK_LAYERS.reactServerComponents,
    isServer: true,
    serverComponents: true,
    source: `
      "use client";
      import { useState } from "react";
      export default function Counter() {
        const [count] = useState(0);
        return <button>{count}</button>;
      }
    `,
  },
  {
    name: "client-component-browser",
    filename: "app/virtual-client.tsx",
    layer: WEBPACK_LAYERS.appPagesBrowser,
    isServer: false,
    serverComponents: true,
    source: `
      "use client";
      import { useState } from "react";
      export default function Counter() {
        const [count] = useState(0);
        return <button>{count}</button>;
      }
    `,
  },
  {
    name: "client-imports-server-only-graph-violation",
    filename: "app/invalid-client.tsx",
    layer: WEBPACK_LAYERS.appPagesBrowser,
    isServer: false,
    serverComponents: true,
    source: `
      "use client";
      import "server-only";
      export default function InvalidClient() {
        return <p>Direct SWC does not resolve the forbidden import</p>;
      }
    `,
  },
  {
    name: "server-action-file",
    filename: "app/virtual-actions.ts",
    layer: WEBPACK_LAYERS.reactServerComponents,
    isServer: true,
    serverComponents: true,
    source: `
      "use server";
      export async function createPost(formData: FormData) {
        return formData.get("title");
      }
      export async function deletePost(id: string) {
        return id;
      }
    `,
  },
  {
    name: "inline-server-action",
    filename: "app/virtual-inline/page.tsx",
    layer: WEBPACK_LAYERS.reactServerComponents,
    isServer: true,
    serverComponents: true,
    source: `
      export default async function Page() {
        async function save(formData: FormData) {
          "use server";
          return formData.get("title");
        }
        return <form action={save}><button>Save</button></form>;
      }
    `,
  },
  {
    name: "use-cache-function-and-component",
    filename: "app/virtual-cache.tsx",
    layer: WEBPACK_LAYERS.reactServerComponents,
    isServer: true,
    serverComponents: true,
    isCacheComponents: true,
    useCacheEnabled: true,
    development: false,
    source: `
      import { cacheLife, cacheTag } from "next/cache";
      export async function getPost(id: string) {
        "use cache";
        cacheLife("minutes");
        cacheTag("post-" + id);
        return { id, title: "cached" };
      }
      export async function CachedCard({ id }: { id: string }) {
        "use cache";
        cacheLife({ stale: 30, revalidate: 60, expire: 300 });
        return <article>{(await getPost(id)).title}</article>;
      }
    `,
  },
  {
    name: "fixture-actions-after-addition",
    filename: "app/actions.ts",
    layer: WEBPACK_LAYERS.reactServerComponents,
    isServer: true,
    serverComponents: true,
    development: false,
    source: readFileSync(join(FIXTURE, "app", "actions.ts"), "utf8"),
  },
  {
    name: "fixture-actions-before-addition-simulated",
    filename: "app/actions.ts",
    layer: WEBPACK_LAYERS.reactServerComponents,
    isServer: true,
    serverComponents: true,
    development: false,
    source: `
      "use server";
      import { redirect } from "next/navigation";
      export async function createLesson(formData: FormData) {
        const title = String(formData.get("title") ?? "missing");
        redirect(\`/action-result?title=\${encodeURIComponent(title)}\`);
      }
    `,
  },
  {
    name: "fixture-new-route",
    filename: "app/new-route/page.tsx",
    layer: WEBPACK_LAYERS.reactServerComponents,
    isServer: true,
    serverComponents: true,
    source: readFileSync(join(FIXTURE, "app", "new-route", "page.tsx"), "utf8"),
  },
  {
    name: "app-route-handler",
    filename: "app/api/virtual/route.ts",
    layer: WEBPACK_LAYERS.reactServerComponents,
    isServer: true,
    serverComponents: true,
    source: `
      import { NextResponse } from "next/server";
      export async function GET() {
        return NextResponse.json({ ok: true });
      }
      export async function POST(request: Request) {
        return NextResponse.json(await request.json());
      }
    `,
  },
  {
    name: "pages-api-route",
    filename: "pages/api/virtual.ts",
    layer: WEBPACK_LAYERS.apiNode,
    isServer: true,
    serverComponents: false,
    source: `
      import type { NextApiRequest, NextApiResponse } from "next";
      export default function handler(req: NextApiRequest, res: NextApiResponse) {
        res.status(200).json({ method: req.method });
      }
    `,
  },
  {
    name: "middleware",
    filename: "middleware.ts",
    layer: WEBPACK_LAYERS.middleware,
    isServer: true,
    serverComponents: false,
    source: `
      import { NextResponse } from "next/server";
      export function middleware() {
        return NextResponse.next();
      }
      export const config = { matcher: ["/dashboard/:path*"] };
    `,
  },
  {
    name: "invalid-sync-server-action",
    filename: "app/invalid-actions.ts",
    layer: WEBPACK_LAYERS.reactServerComponents,
    isServer: true,
    serverComponents: true,
    expectError: true,
    source: `
      "use server";
      export function notAsync() {
        return "invalid";
      }
    `,
  },
];

for (const testCase of cases) {
  const startedAt = performance.now();
  try {
    const result = await transform(
      testCase.source,
      loaderOptions(testCase),
    );
    const actionMetadata = parseJsonComment(
      result.code,
      "__next_internal_action_entry_do_not_use__",
    );
    const rscMetadata = getRSCModuleInformation(
      result.code,
      testCase.layer === WEBPACK_LAYERS.reactServerComponents,
    );
    report.transforms[testCase.name] = {
      ok: true,
      expectedError: Boolean(testCase.expectError),
      wallMs: elapsed(startedAt),
      inputBytes: Buffer.byteLength(testCase.source),
      outputBytes: Buffer.byteLength(result.code),
      actionIds: actionMetadata ? Object.keys(actionMetadata) : [],
      actionMetadata,
      rscMetadata,
      registersServerReference: result.code.includes("registerServerReference"),
      validatesServerEntryExports: result.code.includes("ensureServerEntryExports"),
      usesCacheWrapper: result.code.includes("private-next-rsc-cache-wrapper"),
      output: result.code,
    };
  } catch (error) {
    report.transforms[testCase.name] = {
      ok: false,
      expectedError: Boolean(testCase.expectError),
      wallMs: elapsed(startedAt),
      error: String(error?.message ?? error),
    };
  }
}

assert.equal(report.transforms["server-action-file"].ok, true);
assert.equal(report.transforms["server-action-file"].actionIds.length, 2);
assert.equal(report.transforms["inline-server-action"].ok, true);
assert.equal(report.transforms["inline-server-action"].actionIds.length, 1);
assert.equal(report.transforms["use-cache-function-and-component"].ok, true);
assert.equal(
  report.transforms["use-cache-function-and-component"].usesCacheWrapper,
  true,
);
assert.equal(
  report.transforms["use-cache-function-and-component"].actionIds.length,
  2,
);
assert.equal(report.transforms["invalid-sync-server-action"].ok, false);

const config = {
  pageExtensions: ["tsx", "ts", "jsx", "js"],
  experimental: {},
};
const { pagesDir, appDir } = findPagesDir(FIXTURE);
report.analysis.directories = { pagesDir, appDir };
report.analysis.appPage = await getAppPageStaticInfo({
  pageFilePath: join(FIXTURE, "app", "page.tsx"),
  nextConfig: config,
  isDev: true,
  page: "/page",
  pageType: PAGE_TYPES.APP,
});
report.analysis.appRouteHandler = await getAppPageStaticInfo({
  pageFilePath: join(FIXTURE, "app", "api", "hello", "route.ts"),
  nextConfig: config,
  isDev: true,
  page: "/api/hello/route",
  pageType: PAGE_TYPES.APP,
});
report.analysis.pagesApi = await getPagesPageStaticInfo({
  pageFilePath: join(FIXTURE, "pages", "api", "legacy.ts"),
  nextConfig: config,
  isDev: true,
  page: "/api/legacy",
  pageType: PAGE_TYPES.PAGES,
});
report.analysis.middleware = await getPagesPageStaticInfo({
  pageFilePath: join(FIXTURE, "middleware.ts"),
  nextConfig: config,
  isDev: true,
  page: "/middleware",
  pageType: PAGE_TYPES.ROOT,
});

const dynamicRouteRegex = getRouteRegex("/posts/[id]");
const dynamicRouteMatcher = getRouteMatcher(dynamicRouteRegex);
report.routing = {
  normalized: normalizePagePath("/posts/[id]"),
  regexSource: dynamicRouteRegex.re.source,
  groups: dynamicRouteRegex.groups,
  positiveMatch: dynamicRouteMatcher("/posts/compiler-probe"),
  negativeMatch: dynamicRouteMatcher("/posts"),
};

report.entries.dynamicPost = getAppEntry({
  name: "app/posts/[id]/page",
  page: "/posts/[id]/page",
  pagePath: "private-next-app-dir/posts/[id]/page.tsx",
  appDir,
  appPaths: ["/posts/[id]/page"],
  allNormalizedAppPaths: ["/page", "/posts/[id]/page"],
  preferredRegion: undefined,
  pageExtensions: ["tsx", "ts", "jsx", "js"],
  assetPrefix: "",
  rootDir: FIXTURE,
  basePath: "",
  nextConfigOutput: "standalone",
  middlewareConfig: "e30=",
  isGlobalNotFoundEnabled: undefined,
});

writeFileSync(
  join(ROOT, "compiler-results.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));

function loaderOptions(testCase) {
  const filename = join(FIXTURE, testCase.filename);
  const options = getLoaderSWCOptions({
    filename,
    development: testCase.development ?? true,
    isServer: testCase.isServer,
    pagesDir: join(FIXTURE, "pages"),
    appDir: join(FIXTURE, "app"),
    isPageFile: testCase.filename.endsWith("page.tsx"),
    isCacheComponents: testCase.isCacheComponents ?? false,
    hasReactRefresh: !testCase.isServer,
    modularizeImports: undefined,
    optimizeServerReact: false,
    optimizePackageImports: undefined,
    swcPlugins: undefined,
    compilerOptions: {},
    jsConfig: { compilerOptions: {} },
    supportedBrowsers: [],
    swcCacheDir: undefined,
    relativeFilePathFromRoot: testCase.filename,
    serverComponents: testCase.serverComponents,
    serverReferenceHashSalt: ACTION_SALT,
    bundleLayer: testCase.layer,
    esm: true,
    cacheHandlers: {},
    useCacheEnabled: testCase.useCacheEnabled ?? false,
    taintEnabled: false,
    trackDynamicImports: false,
    pageExtensions: ["tsx", "ts", "jsx", "js"],
  });
  return {
    ...options,
    filename,
    sourceFileName: filename,
  };
}

function parseJsonComment(code, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`/\\* ${escaped} (\\{[^\\n]+\\}) \\*/`).exec(code);
  return match ? JSON.parse(match[1]) : undefined;
}

function elapsed(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
