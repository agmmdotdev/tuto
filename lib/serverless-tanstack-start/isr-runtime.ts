import type {
  TanstackStartArtifact,
  TanstackStartIsrDocument,
} from "./artifact-cache";
import { putTanstackStartArtifact } from "./artifact-cache";
import {
  resolveArtifactRequest,
  type ArtifactDocumentRequestResolution,
} from "./artifact-request";
import { putDurableTanstackStartArtifact } from "./artifact-store";
import { createTanstackStartIsrDocument } from "./isr-policy";
import { getNativeRpcWorkerPool } from "./native-rpc-worker-pool";
import type { NativeRpcRequest, NativeRpcResult } from "./native-rpc-protocol";

type SelectedDocument = Extract<
  ArtifactDocumentRequestResolution,
  { ok: true }
> & { body: string; kind: "route"; outputPath: string };

export type IsrDocumentResolution = {
  body: string;
  cacheControl: string;
  generatedAt: number;
  status: "fresh" | "regenerated" | "stale" | "stale-if-error";
};

type RegenerationState = {
  active: number;
  inFlight: Map<string, Promise<IsrDocumentResolution>>;
  publicationTails: Map<string, Promise<void>>;
  waiters: Array<() => void>;
};

const stateKey = Symbol.for("tuto.tanstack-start.isr-regeneration.v1");
const maxDocuments = 64;
const maxDocumentBytes = 3_000_000;
const maxStaticServerFunctionResults = 64;
const maxStaticServerFunctionResultBytes = 3_000_000;
const maxStaticServerFunctionTotalBytes = 6_000_000;

function readPositiveInteger(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function limits() {
  return {
    concurrency: readPositiveInteger("TUTO_TANSTACK_ISR_CONCURRENCY", 4),
    pending: readPositiveInteger("TUTO_TANSTACK_ISR_MAX_PENDING", 64),
  };
}

function state() {
  const globals = globalThis as typeof globalThis & {
    [stateKey]?: RegenerationState;
  };
  globals[stateKey] ??= {
    active: 0,
    inFlight: new Map(),
    publicationTails: new Map(),
    waiters: [],
  };
  return globals[stateKey];
}

async function withRegenerationSlot<T>(operation: () => Promise<T>) {
  const current = state();
  const { concurrency, pending } = limits();
  if (current.active >= concurrency) {
    if (current.waiters.length >= pending) {
      throw new Error("TanStack Start ISR regeneration queue is full.");
    }
    await new Promise<void>((resolve) => current.waiters.push(resolve));
  } else {
    current.active += 1;
  }
  try {
    return await operation();
  } finally {
    const next = current.waiters.shift();
    if (next) next();
    else current.active -= 1;
  }
}

async function publishSerially<T>(revision: string, operation: () => Promise<T>) {
  const current = state();
  const previous = current.publicationTails.get(revision) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  current.publicationTails.set(revision, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (current.publicationTails.get(revision) === tail) {
      current.publicationTails.delete(revision);
    }
  }
}

function artifactMatches(
  artifact: TanstackStartArtifact,
  selected: SelectedDocument,
) {
  const policy =
    selected.artifact.prerendered?.isr?.[selected.outputPath];
  return (
    policy !== undefined &&
    artifact.revision === selected.artifact.revision &&
    artifact.kernelId === selected.artifact.kernelId &&
    artifact.rpcToken === selected.artifact.rpcToken &&
    artifact.prerendered?.routes[policy.routePath] === selected.outputPath
  );
}

function requestForPolicy(
  policy: TanstackStartIsrDocument,
  path: string,
): NativeRpcRequest {
  const headers = new Headers(policy.requestHeaders);
  headers.set("accept", "text/html");
  headers.set("origin", "http://tuto.local");
  headers.set("sec-fetch-site", "same-origin");
  return {
    headers: [...headers.entries()],
    method: "GET",
    url: new URL(path, "http://tuto.local").toString(),
  };
}

async function executeRegenerationRequest(
  artifact: TanstackStartArtifact,
  policy: TanstackStartIsrDocument,
  path = policy.routePath,
  redirectsRemaining = policy.maxRedirects,
): Promise<NativeRpcResult> {
  const request = requestForPolicy(policy, path);
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
  const headers = new Headers(response.headers);
  const location = headers.get("location");
  if (
    response.status >= 300 &&
    response.status < 400 &&
    location &&
    redirectsRemaining > 0
  ) {
    const redirectUrl = new URL(location, request.url);
    if (redirectUrl.origin === "http://tuto.local") {
      return executeRegenerationRequest(
        artifact,
        policy,
        `${redirectUrl.pathname}${redirectUrl.search}`,
        redirectsRemaining - 1,
      );
    }
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`ISR request failed with HTTP ${response.status}.`);
  }
  const contentType = headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error(`ISR request returned ${contentType || "no content type"}.`);
  }
  return response;
}

function validatedStaticResults(response: NativeRpcResult) {
  const results = response.staticServerFunctionCache ?? {};
  const entries = Object.entries(results);
  if (entries.length > maxStaticServerFunctionResults) {
    throw new Error("ISR emitted too many static server-function results.");
  }
  let totalBytes = 0;
  for (const [cachePath, body] of entries) {
    if (!/^\/__tsr\/staticServerFnCache\/[a-f0-9]{40}\.json$/.test(cachePath)) {
      throw new Error(`Invalid static server function cache path: ${cachePath}.`);
    }
    const bytes = Buffer.byteLength(body);
    if (bytes > maxStaticServerFunctionResultBytes) {
      throw new Error(`Static server function result ${cachePath} is too large.`);
    }
    totalBytes += bytes;
  }
  if (totalBytes > maxStaticServerFunctionTotalBytes) {
    throw new Error("ISR static server-function results exceed the size limit.");
  }
  return results;
}

async function regenerateDocument(
  request: Request,
  selected: SelectedDocument,
): Promise<IsrDocumentResolution> {
  const initialPolicy = selected.artifact.prerendered?.isr?.[selected.outputPath];
  if (!initialPolicy) throw new Error("The selected document is not ISR-enabled.");
  const resolved = await resolveArtifactRequest(request);
  if (!resolved.ok || !artifactMatches(resolved.artifact, selected)) {
    throw new Error("The compiled revision changed before ISR regeneration.");
  }
  const currentPolicy =
    resolved.artifact.prerendered?.isr?.[selected.outputPath];
  const currentBody =
    resolved.artifact.prerendered?.documents[selected.outputPath];
  if (!currentPolicy || currentBody === undefined) {
    throw new Error("The ISR document is no longer available.");
  }
  if (currentPolicy.generatedAt !== initialPolicy.generatedAt) {
    return {
      body: currentBody,
      cacheControl: currentPolicy.cacheControl,
      generatedAt: currentPolicy.generatedAt,
      status: "regenerated",
    };
  }

  const response = await executeRegenerationRequest(
    resolved.artifact,
    currentPolicy,
  );
  const body = Buffer.from(response.bodyBase64, "base64").toString("utf8");
  if (Buffer.byteLength(body) > maxDocumentBytes) {
    throw new Error("ISR document exceeds the size limit.");
  }
  const staticResults = validatedStaticResults(response);
  const nextPolicy = createTanstackStartIsrDocument({
    cacheControl: new Headers(response.headers).get("cache-control"),
    maxRedirects: currentPolicy.maxRedirects,
    requestHeaders: currentPolicy.requestHeaders,
    routePath: currentPolicy.routePath,
    staticServerFunctionPaths: Object.keys(staticResults),
  });
  if (!nextPolicy) {
    throw new Error("ISR response no longer has a shared-cache max-age policy.");
  }

  return publishSerially(resolved.artifact.revision, async () => {
    const latest = await resolveArtifactRequest(request);
    if (!latest.ok || !artifactMatches(latest.artifact, selected)) {
      throw new Error("The compiled revision changed before ISR publication.");
    }
    const latestPolicy = latest.artifact.prerendered?.isr?.[selected.outputPath];
    const latestBody = latest.artifact.prerendered?.documents[selected.outputPath];
    if (!latestPolicy || latestBody === undefined) {
      throw new Error("The ISR document disappeared before publication.");
    }
    if (latestPolicy.generatedAt !== currentPolicy.generatedAt) {
      return {
        body: latestBody,
        cacheControl: latestPolicy.cacheControl,
        generatedAt: latestPolicy.generatedAt,
        status: "regenerated" as const,
      };
    }

    const staticServerFunctions = {
      ...(latest.artifact.staticServerFunctions ?? {}),
    };
    Object.assign(staticServerFunctions, staticResults);
    if (Object.keys(staticServerFunctions).length > maxStaticServerFunctionResults) {
      throw new Error("ISR static server-function cache exceeds the result limit.");
    }
    const staticBytes = Object.values(staticServerFunctions).reduce(
      (bytes, value) => bytes + Buffer.byteLength(value),
      0,
    );
    if (staticBytes > maxStaticServerFunctionTotalBytes) {
      throw new Error("ISR static server-function cache exceeds the size limit.");
    }

    const documents = {
      ...latest.artifact.prerendered!.documents,
      [selected.outputPath]: body,
    };
    if (Object.keys(documents).length > maxDocuments) {
      throw new Error("ISR document cache exceeds the result limit.");
    }
    const updated: TanstackStartArtifact = {
      ...latest.artifact,
      prerendered: {
        ...latest.artifact.prerendered!,
        documents,
        isr: {
          ...latest.artifact.prerendered!.isr,
          [selected.outputPath]: nextPolicy,
        },
      },
      ...(Object.keys(staticServerFunctions).length > 0
        ? { staticServerFunctions }
        : { staticServerFunctions: undefined }),
    };
    await putDurableTanstackStartArtifact(updated);
    putTanstackStartArtifact(updated);
    return {
      body,
      cacheControl: nextPolicy.cacheControl,
      generatedAt: nextPolicy.generatedAt,
      status: "regenerated" as const,
    };
  });
}

function singleFlight(request: Request, selected: SelectedDocument) {
  const current = state();
  const key = `${selected.artifact.revision}:${selected.outputPath}`;
  const existing = current.inFlight.get(key);
  if (existing) return existing;
  if (current.inFlight.size >= limits().pending) {
    return Promise.reject(
      new Error("TanStack Start ISR regeneration queue is full."),
    );
  }
  const regeneration = withRegenerationSlot(() =>
    regenerateDocument(request, selected),
  );
  current.inFlight.set(key, regeneration);
  void regeneration.finally(() => {
    if (current.inFlight.get(key) === regeneration) current.inFlight.delete(key);
  }).catch(() => undefined);
  return regeneration;
}

function bypassesCache(request: Request) {
  const cacheControl = request.headers.get("cache-control")?.toLowerCase() ?? "";
  return cacheControl
    .split(",")
    .some((directive) => /^(no-cache|max-age\s*=\s*0)$/.test(directive.trim()));
}

export async function resolveIncrementalStaticRegeneration(
  request: Request,
  selected: SelectedDocument,
  options: {
    now?: number;
    schedule?: (operation: () => Promise<void>) => void;
  } = {},
): Promise<IsrDocumentResolution | null> {
  const policy = selected.artifact.prerendered?.isr?.[selected.outputPath];
  if (!policy) return null;
  const now = options.now ?? Date.now();
  const ageSeconds = Math.max(0, now - policy.generatedAt) / 1_000;
  const forced = bypassesCache(request);
  if (!forced && ageSeconds < policy.revalidateSeconds) {
    return {
      body: selected.body,
      cacheControl: policy.cacheControl,
      generatedAt: policy.generatedAt,
      status: "fresh",
    };
  }

  const regenerationRequest = new Request(request.url, {
    headers: request.headers,
    method: "GET",
  });
  if (
    !forced &&
    ageSeconds <=
      policy.revalidateSeconds + policy.staleWhileRevalidateSeconds
  ) {
    const schedule =
      options.schedule ??
      ((operation: () => Promise<void>) => {
        queueMicrotask(() => void operation().catch(() => undefined));
      });
    schedule(async () => {
      await singleFlight(regenerationRequest, selected);
    });
    return {
      body: selected.body,
      cacheControl: "private, no-store",
      generatedAt: policy.generatedAt,
      status: "stale",
    };
  }

  try {
    return await singleFlight(regenerationRequest, selected);
  } catch {
    return {
      body: selected.body,
      cacheControl: "private, no-store",
      generatedAt: policy.generatedAt,
      status: "stale-if-error",
    };
  }
}

export function clearTanstackStartIsrStateForTests() {
  const current = state();
  current.active = 0;
  current.inFlight.clear();
  current.publicationTails.clear();
  current.waiters.splice(0);
}
