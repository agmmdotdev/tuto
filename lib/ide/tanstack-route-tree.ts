import { WorkspaceFile, WorkspaceLanguage } from "@/lib/ide/types";

const routeFilePattern = /^src\/routes\/(.+)\.[cm]?[tj]sx?$/;
const routeTreePath = "src/routeTree.gen.ts";
const routerRegisterPath = "src/tanstack-router-register.d.ts";
const editorShimPath = "src/tanstack-router-editor-shim.tsx";

type RouteEntry = {
  identifier: string;
  importPath: string;
  filePathKey: string;
  fullPath: string;
  id: string;
  path: string;
  parentFullPath: string | null;
};

function languageForPath(filePath: string): WorkspaceLanguage {
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".ts")) return "ts";
  if (filePath.endsWith(".jsx")) return "jsx";
  if (filePath.endsWith(".js")) return "js";
  if (filePath.endsWith(".css")) return "css";
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".html")) return "html";
  return "md";
}

function toIdentifier(stem: string) {
  const words = stem
    .replaceAll("$", " Param ")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  const base = words
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join("");

  return `${base || "Index"}Route`;
}

function joinFullPath(segments: string[]) {
  if (segments.length === 0) return "/";
  return `/${segments.join("/")}`;
}

function routePathFromStem(stem: string) {
  const segments = stem.split(".");

  if (stem === "index") {
    return "/";
  }

  if (segments.at(-1) === "index") {
    return `${joinFullPath(segments.slice(0, -1))}/`;
  }

  return joinFullPath(segments);
}

function parentPathFromFullPath(fullPath: string) {
  if (fullPath === "/") return null;

  const trimmed =
    fullPath.endsWith("/") && fullPath !== "/"
      ? fullPath.slice(0, -1)
      : fullPath;
  const index = trimmed.lastIndexOf("/");

  return index <= 0 ? "/" : trimmed.slice(0, index);
}

function childPath(fullPath: string, parentFullPath: string | null) {
  if (!parentFullPath) return fullPath;
  if (fullPath === "/") return "/";
  if (fullPath.endsWith("/") && parentFullPath === fullPath.slice(0, -1))
    return "/";
  if (parentFullPath === "/") return fullPath;

  return fullPath.slice(parentFullPath.length) || "/";
}

function routeSortKey(route: RouteEntry) {
  return `${route.fullPath === "/" ? "!" : route.fullPath}/${route.filePathKey}`;
}

function collectRoutes(files: WorkspaceFile[]) {
  const routeFiles = files
    .map((file) => {
      const match = file.path.match(routeFilePattern);
      return match ? { file, stem: match[1].replaceAll("\\", "/") } : null;
    })
    .filter(Boolean) as Array<{ file: WorkspaceFile; stem: string }>;
  const rootFile = routeFiles.find((entry) => entry.stem === "__root");

  if (!rootFile) {
    return null;
  }

  return routeFiles
    .filter((entry) => entry.stem !== "__root")
    .map<RouteEntry>((entry) => {
      const fullPath = routePathFromStem(entry.stem);
      const parentFullPath = parentPathFromFullPath(fullPath);

      return {
        identifier: toIdentifier(entry.stem),
        importPath: `./routes/${entry.stem}`,
        filePathKey: fullPath,
        fullPath,
        id: childPath(fullPath, parentFullPath),
        path: childPath(fullPath, parentFullPath),
        parentFullPath,
      };
    })
    .sort((left, right) =>
      routeSortKey(left).localeCompare(routeSortKey(right)),
    );
}

function childMapName(route: RouteEntry) {
  return `${route.identifier}Children`;
}

function routeParamsType(fullPath: string) {
  const params = [...fullPath.matchAll(/\$([^/]+)/g)].map((match) => match[1]);

  if (params.length === 0) {
    return "Record<never, never>";
  }

  return `{ ${params.map((param) => `${param}: string`).join("; ")} }`;
}

function generateTanstackEditorShim(routes: RouteEntry[]) {
  const routeUnion =
    routes.map((route) => `"${route.fullPath}"`).join(" | ") || "string";
  const routePathEntries = routes
    .map(
      (route) => `  "${route.fullPath}": ${routeParamsType(route.fullPath)};`,
    )
    .join("\n");

  return `import * as React from "react";

type RoutePath = ${routeUnion};
type RouteParamsByPath = {
${routePathEntries}
};
type RouteSearchByPath = {
${routes.map((route) => `  "${route.fullPath}": Record<string, unknown>;`).join("\n")}
};
type ParamsFor<TTo> = TTo extends keyof RouteParamsByPath ? RouteParamsByPath[TTo] : Record<string, string>;
type SearchFor<TTo> = TTo extends keyof RouteSearchByPath ? RouteSearchByPath[TTo] : Record<string, unknown>;
type LinkProps<TTo extends RoutePath = RoutePath> = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  to?: TTo;
  href?: string;
  params?: ParamsFor<TTo> | ((current: Record<string, unknown>) => ParamsFor<TTo>);
  search?: SearchFor<TTo> | ((current: Record<string, unknown>) => SearchFor<TTo>);
  activeProps?: Record<string, unknown> | (() => Record<string, unknown>);
  inactiveProps?: Record<string, unknown> | (() => Record<string, unknown>);
  activeOptions?: Record<string, unknown>;
  preload?: "intent" | "render" | "viewport" | boolean;
  resetScroll?: boolean;
  hashScrollIntoView?: boolean | ScrollIntoViewOptions;
  viewTransition?: boolean | Record<string, unknown>;
};
type RouteApi<TPath extends RoutePath> = {
  update(options: unknown): RouteApi<TPath>;
  _addFileChildren(children: unknown): RouteApi<TPath>;
  _addFileTypes<TFileRouteTypes>(): RouteApi<TPath>;
  useLoaderData(): any;
  useSearch(): SearchFor<TPath>;
  useParams(): ParamsFor<TPath>;
};
type FileRouteOptions<TPath extends RoutePath> = {
  component?: React.ComponentType<any> | (() => React.ReactNode);
  loader?: (ctx: { params: ParamsFor<TPath>; context: unknown; location: unknown }) => unknown;
  validateSearch?: (search: Record<string, unknown>) => SearchFor<TPath>;
  beforeLoad?: (ctx: { params: ParamsFor<TPath>; search: SearchFor<TPath> }) => unknown;
  notFoundComponent?: React.ComponentType<any> | (() => React.ReactNode);
  pendingComponent?: React.ComponentType<any> | (() => React.ReactNode);
  errorComponent?: React.ComponentType<any> | (() => React.ReactNode);
};
type NotFoundOptions = {
  data?: unknown;
  headers?: HeadersInit;
  routeId?: string;
  throw?: boolean;
};
type RedirectOptions = {
  href?: string;
  statusCode?: number;
  code?: number;
  headers?: HeadersInit;
  reloadDocument?: boolean;
  throw?: boolean;
  to?: string;
  params?: Record<string, unknown>;
  search?: Record<string, unknown>;
  replace?: boolean;
};
type RedirectResult = Response & {
  options: RedirectOptions;
};

export const Link = React.forwardRef<HTMLAnchorElement, LinkProps<any>>(function Link(props, ref) {
  return React.createElement("a", { ...props, ref, href: props.href ?? props.to ?? "#" });
}) as <const TTo extends RoutePath>(props: LinkProps<TTo> & { ref?: React.Ref<HTMLAnchorElement> }) => React.ReactElement;
export const Outlet = () => null;
export const RouterProvider = (_props: { router: unknown }) => null;
export function createFileRoute<const TPath extends RoutePath>(_path: TPath) {
  return (_options: FileRouteOptions<TPath>) => ({
    update: () => ({} as RouteApi<TPath>),
    _addFileChildren: () => ({} as RouteApi<TPath>),
    _addFileTypes: () => ({} as RouteApi<TPath>),
    useLoaderData: () => undefined as any,
    useSearch: () => ({}) as SearchFor<TPath>,
    useParams: () => ({}) as ParamsFor<TPath>,
  }) as RouteApi<TPath>;
}
export function createRootRoute(_options: Record<string, unknown>) {
  return {
    update: () => ({} as RouteApi<"/">),
    _addFileChildren: () => ({} as RouteApi<"/">),
    _addFileTypes: () => ({} as RouteApi<"/">),
    useLoaderData: () => undefined as any,
    useSearch: () => ({}) as SearchFor<"/">,
    useParams: () => ({}) as ParamsFor<"/">,
  } as RouteApi<"/">;
}
export function createRouter(options: Record<string, unknown>) {
  return options;
}
export function createMemoryHistory(options: Record<string, unknown>) {
  return options;
}
export function useRouterState<TSelected>(opts: { select: (state: { location: { pathname: string } }) => TSelected }): TSelected;
export function useRouterState(): { location: { pathname: string } };
export function useRouterState<TSelected>(opts?: { select?: (state: { location: { pathname: string } }) => TSelected }) {
  const state = { location: { pathname: "/" } };
  return opts?.select ? opts.select(state) : state;
}
export function notFound(_options: NotFoundOptions = {}): Error {
  return new Error("Not found");
}
export function redirect(options: RedirectOptions): RedirectResult {
  const response = new Response(null, {
    status: options.statusCode ?? options.code ?? 307,
    headers: options.headers,
  }) as RedirectResult;
  response.options = options;
  return response;
}
type ServerFnContext<TData = any, TContext = Record<string, any>> = {
  context: TContext;
  data: TData;
  headers?: HeadersInit;
  method?: string;
  signal?: AbortSignal;
};
type MiddlewareNext = (options?: {
  context?: Record<string, any>;
  data?: any;
  headers?: HeadersInit;
  result?: any;
}) => Promise<any>;
type MiddlewareContext = {
  context: Record<string, any>;
  data: any;
  handlerType: "router" | "serverFn" | "serverRoute";
  headers?: HeadersInit;
  method?: string;
  next: MiddlewareNext;
  request: Request;
  signal?: AbortSignal;
};
type ServerFunction<TData = any, TResult = any> = {
  (options?: {
    context?: Record<string, any>;
    data?: TData;
    fetch?: typeof fetch;
    headers?: HeadersInit;
    signal?: AbortSignal;
  }): Promise<TResult | Response>;
  method?: string;
};
type Middleware = {
  options?: Record<string, unknown>;
  middleware(middleware: Middleware[]): Middleware;
  inputValidator<TData>(validator: (data: unknown) => TData | Promise<TData>): Middleware;
  validator<TData>(validator: (data: unknown) => TData | Promise<TData>): Middleware;
  client(fn: (ctx: MiddlewareContext) => unknown): Middleware;
  server(fn: (ctx: MiddlewareContext) => unknown): Middleware;
};
type ServerFunctionBuilder<TData = any> = {
  (options?: Record<string, unknown>): ServerFunctionBuilder<TData>;
  middleware(middleware: Middleware[]): ServerFunctionBuilder<TData>;
  inputValidator<TNextData>(validator: (data: unknown) => TNextData | Promise<TNextData>): ServerFunctionBuilder<TNextData>;
  validator<TNextData>(validator: (data: unknown) => TNextData | Promise<TNextData>): ServerFunctionBuilder<TNextData>;
  handler<TResult>(handler: (ctx: ServerFnContext<TData>) => TResult | Promise<TResult>): ServerFunction<TData, TResult>;
};
export function createServerFn(_options?: { method?: "GET" | "POST" | string }): ServerFunctionBuilder {
  return undefined as any;
}
export function createMiddleware(_options?: Record<string, unknown>): Middleware {
  return undefined as any;
}
export function createCsrfMiddleware(_options?: {
  filter?: (context: MiddlewareContext) => boolean;
}): Middleware {
  return undefined as any;
}
export const createServerOnlyFn = (<T extends (...args: any[]) => any>(fn: T) => fn);
export const createClientOnlyFn = (<T extends (...args: any[]) => any>(fn: T) => fn);
export function createIsomorphicFn(): {
  client<T extends (...args: any[]) => any>(fn: T): T;
  server<T extends (...args: any[]) => any>(fn: T): T;
} {
  return undefined as any;
}
export function createStart<TOptions extends Record<string, unknown>>(
  getOptions: (() => TOptions | Promise<TOptions>) | TOptions,
): {
  getOptions(): TOptions | Promise<TOptions>;
} {
  return {
    getOptions: () => typeof getOptions === "function" ? getOptions() : getOptions,
  };
}
`;
}

export function generateTanstackRouteTree(files: WorkspaceFile[]) {
  const routes = collectRoutes(files);

  if (!routes) {
    return null;
  }

  const byFullPath = new Map(routes.map((route) => [route.fullPath, route]));
  const imports = [
    `import { Route as rootRouteImport } from "./routes/__root";`,
    ...routes.map(
      (route) =>
        `import { Route as ${route.identifier}Import } from "${route.importPath}";`,
    ),
  ].join("\n");
  const declarations = routes
    .map((route) => {
      const parent =
        route.parentFullPath === null || route.parentFullPath === "/"
          ? "rootRouteImport"
          : `${byFullPath.get(route.parentFullPath)?.identifier}RouteWithChildren`;

      return `const ${route.identifier} = ${route.identifier}Import.update({
  id: "${route.id}",
  path: "${route.path}",
  getParentRoute: () => ${parent},
});`;
    })
    .join("\n\n");
  const routesWithChildren = routes.filter((route) =>
    routes.some((candidate) => candidate.parentFullPath === route.fullPath),
  );
  const childInterfaces = routesWithChildren
    .map((route) => {
      const children = routes.filter(
        (candidate) => candidate.parentFullPath === route.fullPath,
      );
      const members = children
        .map((child) => `  ${child.identifier}: typeof ${child.identifier};`)
        .join("\n");

      return `interface ${childMapName(route)} {
${members}
}

const ${childMapName(route)}: ${childMapName(route)} = {
${children.map((child) => `  ${child.identifier},`).join("\n")}
};

const ${route.identifier}RouteWithChildren = ${route.identifier}._addFileChildren(${childMapName(route)});`;
    })
    .join("\n\n");
  const rootChildren = routes.filter((route) => route.parentFullPath === "/");
  const rootChildrenMembers = rootChildren
    .map((route) => {
      const hasChildren = routesWithChildren.includes(route);
      return `  ${route.identifier}: typeof ${hasChildren ? `${route.identifier}RouteWithChildren` : route.identifier};`;
    })
    .join("\n");
  const rootChildrenValues = rootChildren
    .map((route) => {
      const hasChildren = routesWithChildren.includes(route);
      return `  ${route.identifier}: ${hasChildren ? `${route.identifier}RouteWithChildren` : route.identifier},`;
    })
    .join("\n");
  const routeType = (route: RouteEntry) => {
    const hasChildren = routesWithChildren.includes(route);
    return `typeof ${hasChildren ? `${route.identifier}RouteWithChildren` : route.identifier}`;
  };

  return `/* eslint-disable */

// This file is generated from src/routes by the Tuto TanStack Start playground.

${imports}

${declarations}

export interface FileRoutesByFullPath {
${routes.map((route) => `  "${route.fullPath}": ${routeType(route)};`).join("\n")}
}

export interface FileRoutesByTo {
${routes
  .filter((route) => !route.fullPath.endsWith("/") || route.fullPath === "/")
  .map((route) => `  "${route.fullPath}": ${routeType(route)};`)
  .join("\n")}
}

export interface FileRoutesById {
  __root__: typeof rootRouteImport;
${routes.map((route) => `  "${route.fullPath}": ${routeType(route)};`).join("\n")}
}

export interface FileRouteTypes {
  fileRoutesByFullPath: FileRoutesByFullPath;
  fullPaths: ${routes.map((route) => `"${route.fullPath}"`).join(" | ") || "never"};
  fileRoutesByTo: FileRoutesByTo;
  to: ${
    routes
      .filter(
        (route) => !route.fullPath.endsWith("/") || route.fullPath === "/",
      )
      .map((route) => `"${route.fullPath}"`)
      .join(" | ") || "never"
  };
  id: "__root__" | ${routes.map((route) => `"${route.fullPath}"`).join(" | ") || "never"};
  fileRoutesById: FileRoutesById;
}

interface RootRouteChildren {
${rootChildrenMembers}
}

declare module "@tanstack/react-router" {
  interface FileRoutesByPath {
${routes
  .map(
    (route) => `    "${route.fullPath}": {
      id: "${route.fullPath}";
      path: "${route.path}";
      fullPath: "${route.fullPath}";
      preLoaderRoute: typeof ${route.identifier}Import;
      parentRoute: ${route.parentFullPath === "/" || route.parentFullPath === null ? "typeof rootRouteImport" : routeType(byFullPath.get(route.parentFullPath)!)};
    };`,
  )
  .join("\n")}
  }
}

declare module "@tanstack/router-core" {
  interface FileRoutesByPath {
${routes
  .map(
    (route) => `    "${route.fullPath}": {
      id: "${route.fullPath}";
      path: "${route.path}";
      fullPath: "${route.fullPath}";
      preLoaderRoute: typeof ${route.identifier}Import;
      parentRoute: ${route.parentFullPath === "/" || route.parentFullPath === null ? "typeof rootRouteImport" : routeType(byFullPath.get(route.parentFullPath)!)};
    };`,
  )
  .join("\n")}
  }
}

${childInterfaces}

const rootRouteChildren: RootRouteChildren = {
${rootChildrenValues}
};

export const routeTree = rootRouteImport
  ._addFileChildren(rootRouteChildren)
  ._addFileTypes<FileRouteTypes>();
`;
}

export function materializeTanstackRouteTree(files: WorkspaceFile[]) {
  const generated = generateTanstackRouteTree(files);
  const routes = collectRoutes(files);

  if (!generated || !routes) {
    return files;
  }

  const generatedFiles: WorkspaceFile[] = [
    {
      path: routeTreePath,
      language: languageForPath(routeTreePath),
      description:
        "Generated TanStack route tree for the stateless playground.",
      content: generated,
    },
    {
      path: routerRegisterPath,
      language: languageForPath(routerRegisterPath),
      description: "Generated TanStack router type registration.",
      content: `import type { router } from "./router";

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

declare module "@tanstack/router-core" {
  interface Register {
    router: typeof router;
  }
}
`,
    },
    {
      path: editorShimPath,
      language: languageForPath(editorShimPath),
      description: "Generated Monaco-only TanStack Router type shim.",
      content: generateTanstackEditorShim(routes),
    },
  ];
  const withoutGenerated = files.filter(
    (file) =>
      file.path !== routeTreePath &&
      file.path !== routerRegisterPath &&
      file.path !== editorShimPath,
  );

  return [...withoutGenerated, ...generatedFiles].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}
