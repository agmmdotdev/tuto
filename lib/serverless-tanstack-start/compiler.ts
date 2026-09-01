import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { BuildDiagnostic, WorkspaceFile } from "@/lib/ide/types";
import {
  createTanstackStartDeploymentManifest,
  createWorkspaceRevision,
  getTanstackStartArtifact,
  putTanstackStartArtifact,
  type TanstackStartArtifact,
  type TanstackStartBuildMetrics,
  type TanstackStartIsrDocument,
} from "./artifact-cache";
import {
  getDurableTanstackStartArtifactSummary,
  putDurableTanstackStartArtifact,
  type TanstackStartArtifactSummary,
} from "./artifact-store";
import { getNativeRpcWorkerPool } from "./native-rpc-worker-pool";
import type { NativeRpcRequest, NativeRpcResult } from "./native-rpc-protocol";
import { createTanstackStartIsrDocument } from "./isr-policy";

const runtimeRequire = createRequire(import.meta.url);
const picomatch = runtimeRequire("picomatch") as (
  pattern: string,
  options?: { dot?: boolean },
) => (value: string) => boolean;

export type ServerlessTanstackStartResult = {
  success: boolean;
  html: string | null;
  diagnostics: BuildDiagnostic[];
  durationMs: number;
  cacheStatus: "durable" | "hit" | "miss" | "shared";
  buildMetrics: TanstackStartBuildMetrics;
  revision: string;
};

type PrerenderPagePlan = {
  autoSubfolderIndex: boolean;
  crawlLinks: boolean;
  headers: Record<string, string>;
  outputPath?: string;
  path: string;
  retryCount: number;
  retryDelay: number;
  shell?: boolean;
};
type PrerenderPlan = {
  concurrency: number;
  failOnError: boolean;
  filter?: {
    exclude: string[];
    include: string[];
  };
  maxRedirects: number;
  pages: PrerenderPagePlan[];
};
type RunnerResult = TanstackStartArtifact & {
  prerenderPlan?: PrerenderPlan;
};
type BuildOutcome =
  | { origin: "build"; result: RunnerResult }
  | { origin: "durable"; result: TanstackStartArtifactSummary };

const runnerPath = resolve(
  process.cwd(),
  "lib",
  "serverless-tanstack-start",
  "core-preview-runner.generated.cjs",
);
const resultStartMarker = "__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_START__";
const resultEndMarker = "__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_END__";
const inFlightBuildsKey = Symbol.for("tuto.tanstack-start.in-flight-builds.v1");
const maxPrerenderedDocuments = 64;
const maxPrerenderedDocumentBytes = 3_000_000;
const maxPrerenderedTotalBytes = 6_000_000;
const maxStaticServerFunctionResults = 64;
const maxStaticServerFunctionResultBytes = 3_000_000;
const maxStaticServerFunctionTotalBytes = 6_000_000;

function getInFlightBuilds() {
  const globals = globalThis as typeof globalThis & {
    [inFlightBuildsKey]?: Map<string, Promise<BuildOutcome>>;
  };
  globals[inFlightBuildsKey] ??= new Map();
  return globals[inFlightBuildsKey];
}

function durableStoreWarning(operation: "read" | "write", error: unknown) {
  return {
    id: randomUUID(),
    level: "warn" as const,
    message: `Durable TanStack artifact ${operation} failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
    timestamp: new Date().toISOString(),
  };
}

async function loadOrBuild(files: WorkspaceFile[], revision: string) {
  let readWarning: ReturnType<typeof durableStoreWarning> | undefined;

  try {
    const durable = await getDurableTanstackStartArtifactSummary(revision);
    if (durable) {
      return { origin: "durable", result: durable } satisfies BuildOutcome;
    }
  } catch (error) {
    readWarning = durableStoreWarning("read", error);
  }

  const runnerResult = await spawnBuildRunner(files, revision);
  const { prerenderPlan, ...compiledArtifact } = runnerResult;
  let result = compiledArtifact;
  if (result.success && prerenderPlan) {
    try {
      result = await prerenderArtifact(result, prerenderPlan);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Static prerendering failed.";
      result = {
        ...result,
        diagnostics: [
          ...result.diagnostics,
          {
            id: randomUUID(),
            level: "error",
            message: `TanStack Start prerender failed: ${message}`,
            timestamp: new Date().toISOString(),
          },
        ],
        html: `<!doctype html><html><body><pre>${message
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")}</pre></body></html>`,
        success: false,
      };
    }
  }
  if (readWarning) result.diagnostics.push(readWarning);
  if (result.success) {
    try {
      await putDurableTanstackStartArtifact(result);
    } catch (error) {
      result.diagnostics.push(durableStoreWarning("write", error));
    }
    putTanstackStartArtifact(result);
  }

  return { origin: "build", result } satisfies BuildOutcome;
}

function prerenderOutputPath(page: PrerenderPagePlan) {
  const cleanPath = (page.outputPath ?? page.path).split(/[?#]/, 1)[0] || "/";
  if (page.shell) return `${cleanPath}.html`;
  if (cleanPath.endsWith("/") || page.autoSubfolderIndex) {
    return `${cleanPath.replace(/\/+$/, "")}/index.html` || "/index.html";
  }
  return `${cleanPath}.html`;
}

function extractPrerenderLinks(html: string) {
  const links: string[] = [];
  const pattern = /<a[^>]+href=["']([^"']+)["'][^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const href = match[1];
    if (href && (href.startsWith("/") || href.startsWith("./"))) {
      links.push(href);
    }
  }
  return links;
}

function normalizedPrerenderRoute(value: string, basePath = "/") {
  const url = new URL(value, `http://tuto.local${basePath}`);
  if (url.origin !== "http://tuto.local" || url.hash) return null;
  return `${url.pathname}${url.search}`;
}

function prerenderPathMatchesFilter(
  routePath: string,
  filter: PrerenderPlan["filter"],
) {
  if (!filter) return true;
  const pathname = new URL(routePath, "http://tuto.local").pathname;
  const included =
    filter.include.length === 0 ||
    filter.include.some((pattern) =>
      picomatch(pattern, { dot: true })(pathname),
    );
  return (
    included &&
    !filter.exclude.some((pattern) =>
      picomatch(pattern, { dot: true })(pathname),
    )
  );
}

async function executePrerenderRequest(
  artifact: TanstackStartArtifact,
  page: PrerenderPagePlan,
  path: string,
  redirectsRemaining: number,
): Promise<NativeRpcResult> {
  const headers = new Headers(page.headers);
  headers.set("accept", "text/html");
  headers.set("origin", "http://tuto.local");
  headers.set("sec-fetch-site", "same-origin");
  const request: NativeRpcRequest = {
    headers: [...headers.entries()],
    method: "GET",
    url: new URL(path, "http://tuto.local").toString(),
  };
  const execution = await getNativeRpcWorkerPool().execute(
    {
      kernelId: artifact.kernelId,
      revision: artifact.revision,
      serverBundle: artifact.serverBundle,
      serverChunks: artifact.serverChunks,
    },
    request,
  );
  const response = execution.result;
  const location = new Headers(response.headers).get("location");
  if (
    response.status >= 300 &&
    response.status < 400 &&
    location &&
    redirectsRemaining > 0
  ) {
    const redirectUrl = new URL(location, request.url);
    if (redirectUrl.origin === "http://tuto.local") {
      return executePrerenderRequest(
        artifact,
        page,
        `${redirectUrl.pathname}${redirectUrl.search}`,
        redirectsRemaining - 1,
      );
    }
  }
  return response;
}

async function prerenderArtifact(
  artifact: TanstackStartArtifact,
  plan: PrerenderPlan,
): Promise<TanstackStartArtifact> {
  const startedAt = Date.now();
  const documents: Record<string, string> = {};
  const routes: Record<string, string> = {};
  const staticServerFunctions: Record<string, string> = {};
  const isr: Record<string, TanstackStartIsrDocument> = {};
  const warnings: BuildDiagnostic[] = [];
  const pending: PrerenderPagePlan[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let staticServerFunctionBytes = 0;
  let shell: string | undefined;

  const enqueue = (page: PrerenderPagePlan) => {
    if (!page.shell && !prerenderPathMatchesFilter(page.path, plan.filter)) {
      return;
    }
    const key = page.shell ? `shell:${page.path}` : `route:${page.path}`;
    if (seen.has(key)) return;
    if (seen.size >= maxPrerenderedDocuments) {
      throw new Error(
        `Prerender link crawling exceeded ${maxPrerenderedDocuments} documents.`,
      );
    }
    seen.add(key);
    pending.push(page);
  };
  plan.pages.forEach(enqueue);

  const renderPage = async (page: PrerenderPagePlan) => {
    let response: NativeRpcResult | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= page.retryCount; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, page.retryDelay),
        );
      }
      try {
        response = await executePrerenderRequest(
          artifact,
          page,
          page.path,
          plan.maxRedirects,
        );
        const contentType =
          new Headers(response.headers).get("content-type") ?? "";
        if (response.status < 200 || response.status >= 300) {
          throw new Error(
            `Failed to fetch ${page.path}: HTTP ${response.status}.`,
          );
        }
        if (!contentType.includes("text/html")) {
          throw new Error(
            `Failed to fetch ${page.path}: expected HTML, received ${contentType || "no content type"}.`,
          );
        }
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError || !response) {
      const message =
        lastError instanceof Error ? lastError.message : String(lastError);
      if (plan.failOnError) throw new Error(message);
      warnings.push({
        id: randomUUID(),
        level: "warn",
        message: `TanStack Start prerender skipped ${page.path}: ${message}`,
        timestamp: new Date().toISOString(),
      });
      return [] as PrerenderPagePlan[];
    }

    for (const [cachePath, body] of Object.entries(
      response.staticServerFunctionCache ?? {},
    )) {
      if (
        !/^\/__tsr\/staticServerFnCache\/[a-f0-9]{40}\.json$/.test(cachePath)
      ) {
        throw new Error(
          `Invalid static server function cache path: ${cachePath}.`,
        );
      }
      const existing = staticServerFunctions[cachePath];
      if (existing !== undefined) {
        if (existing !== body) {
          throw new Error(
            `Static server function cache collision for ${cachePath}.`,
          );
        }
        continue;
      }
      if (
        Object.keys(staticServerFunctions).length >=
        maxStaticServerFunctionResults
      ) {
        throw new Error(
          `Static server function output exceeded ${maxStaticServerFunctionResults} results.`,
        );
      }
      const bytes = Buffer.byteLength(body);
      if (bytes > maxStaticServerFunctionResultBytes) {
        throw new Error(
          `Static server function result ${cachePath} is too large.`,
        );
      }
      staticServerFunctionBytes += bytes;
      if (staticServerFunctionBytes > maxStaticServerFunctionTotalBytes) {
        throw new Error(
          "Static server function results exceed the revision size limit.",
        );
      }
      staticServerFunctions[cachePath] = body;
    }

    const html = Buffer.from(response.bodyBase64, "base64").toString("utf8");
    const bytes = Buffer.byteLength(html);
    if (bytes > maxPrerenderedDocumentBytes) {
      throw new Error(`Prerendered document ${page.path} is too large.`);
    }
    totalBytes += bytes;
    if (totalBytes > maxPrerenderedTotalBytes) {
      throw new Error("Prerendered documents exceed the revision size limit.");
    }
    const outputPath = prerenderOutputPath(page);
    if (Object.hasOwn(documents, outputPath)) {
      throw new Error(`Duplicate prerender output path: ${outputPath}.`);
    }
    documents[outputPath] = html;
    if (page.shell) shell = outputPath;
    else {
      routes[page.path] = outputPath;
      const policy = createTanstackStartIsrDocument({
        cacheControl: new Headers(response.headers).get("cache-control"),
        maxRedirects: plan.maxRedirects,
        requestHeaders: page.headers,
        routePath: page.path,
        staticServerFunctionPaths: Object.keys(
          response.staticServerFunctionCache ?? {},
        ),
      });
      if (policy) isr[outputPath] = policy;
    }

    if (!page.crawlLinks || page.shell) return [] as PrerenderPagePlan[];
    return extractPrerenderLinks(html)
      .map((href) => normalizedPrerenderRoute(href, page.path))
      .filter((path): path is string => path !== null)
      .map((path) => ({ ...page, outputPath: undefined, path }));
  };

  while (pending.length > 0) {
    const batch = pending.splice(0, plan.concurrency);
    const discovered = await Promise.all(batch.map(renderPage));
    discovered.flat().forEach(enqueue);
  }

  const prerendered = {
    documents,
    ...(Object.keys(isr).length > 0 ? { isr } : {}),
    routes,
    ...(shell ? { shell } : {}),
  };
  return {
    ...artifact,
    deploymentManifest: createTanstackStartDeploymentManifest(
      prerendered,
      staticServerFunctions,
    ),
    diagnostics: [
      ...artifact.diagnostics,
      ...warnings,
      {
        id: randomUUID(),
        level: "info",
        message: `TanStack Start emitted ${Object.keys(documents).length} static HTML document(s), ${Object.keys(isr).length} ISR policy record(s), and ${Object.keys(staticServerFunctions).length} static server-function result(s) in ${Date.now() - startedAt}ms.`,
        timestamp: new Date().toISOString(),
      },
    ],
    durationMs: artifact.durationMs + (Date.now() - startedAt),
    prerendered,
    ...(Object.keys(staticServerFunctions).length > 0
      ? { staticServerFunctions }
      : {}),
  };
}

function spawnBuildRunner(files: WorkspaceFile[], revision: string) {
  return new Promise<RunnerResult>((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [runnerPath], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectResult);
    child.once("exit", (code) => {
      if (code !== 0) {
        rejectResult(
          new Error(
            stderr.trim() ||
              `TanStack Start runtime runner exited with code ${code ?? -1}.`,
          ),
        );
        return;
      }

      try {
        const startIndex = stdout.lastIndexOf(resultStartMarker);
        const endIndex = stdout.lastIndexOf(resultEndMarker);

        if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
          throw new Error(
            stderr.trim() || "Unable to locate TanStack Start result payload.",
          );
        }

        const jsonPayload = stdout
          .slice(startIndex + resultStartMarker.length, endIndex)
          .trim();
        resolveResult(JSON.parse(jsonPayload) as RunnerResult);
      } catch (error) {
        rejectResult(
          error instanceof Error
            ? error
            : new Error("Unable to parse TanStack Start runtime output."),
        );
      }
    });

    child.stdin.write(JSON.stringify({ files, revision }));
    child.stdin.end();
  });
}

export async function compileServerlessTanstackStartWorkspace(
  files: WorkspaceFile[],
): Promise<ServerlessTanstackStartResult> {
  const revision = createWorkspaceRevision(files);
  const cached = getTanstackStartArtifact(revision);

  if (cached) {
    return {
      cacheStatus: "hit",
      buildMetrics: cached.buildMetrics,
      diagnostics: cached.diagnostics,
      durationMs: 0,
      html: cached.html,
      revision,
      success: cached.success,
    };
  }

  const inFlightBuilds = getInFlightBuilds();
  const existingBuild = inFlightBuilds.get(revision);
  const build = existingBuild ?? loadOrBuild(files, revision);
  if (!existingBuild) inFlightBuilds.set(revision, build);

  const outcome = await build.finally(() => {
    if (!existingBuild) inFlightBuilds.delete(revision);
  });
  const result = outcome.result;

  return {
    buildMetrics: result.buildMetrics,
    cacheStatus: existingBuild
      ? "shared"
      : outcome.origin === "durable"
        ? "durable"
        : "miss",
    diagnostics: result.diagnostics,
    durationMs: outcome.origin === "durable" ? 0 : result.durationMs,
    html: result.html,
    revision,
    success: result.success,
  };
}
