import { readFile } from "node:fs/promises";
import path from "node:path";
import type { NextRequestArtifact } from "./artifact";
import { matchNextRouteHandler } from "./route-manifest";
import {
  getNextRscWorkerPool,
  type NextFlightWorkerResult,
  type NextSerializedActionBody,
} from "./rsc-worker-pool";
import { getNextSsrWorkerPool } from "./ssr-worker-pool";

export type NextRuntimeRequest = {
  headers?: HeadersInit;
  url?: string;
};

export type NextRouteHandlerRequest = NextRuntimeRequest & {
  body?: string | Uint8Array;
  headers?: HeadersInit;
  method?: string;
};

export type NextExecuteRequest = NextRouteHandlerRequest & {
  actionEndpoint?: string;
  hydrate?: boolean;
};

async function flightToHtml(
  artifact: NextRequestArtifact,
  result: NextFlightWorkerResult,
) {
  return getNextSsrWorkerPool().render(artifact, result.flight);
}

function inlineScript(code: string) {
  return code.replaceAll("</script", "<\\/script");
}

let clientKernelPromise: Promise<string> | undefined;

function readClientKernel() {
  clientKernelPromise ??= readFile(
    path.resolve(
      process.cwd(),
      "lib",
      "serverless-next",
      "client-kernel.generated.js",
    ),
    "utf8",
  );
  return clientKernelPromise;
}

function hydrationBootstrap(
  flight: Buffer,
  config: {
    actionEndpoint?: string;
    generation: string;
    revision: string;
    url: string;
  },
) {
  return `(async () => {
  const encoded = ${JSON.stringify(flight.toString("base64"))};
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const kernel = globalThis.__TUTO_NEXT_CLIENT_KERNEL__;
  let root;
  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }
  async function serializeBody(body) {
    if (typeof body === "string") return { kind: "string", value: body };
    const entries = [];
    for (const [name, value] of body.entries()) {
      if (typeof value === "string") entries.push({ kind: "string", name, value });
      else entries.push({
        contentType: value.type || "application/octet-stream",
        filename: value.name || "blob",
        kind: "file",
        name,
        value: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
      });
    }
    return { entries, kind: "form-data" };
  }
  globalThis.__TUTO_NEXT_CALL_SERVER__ = async (actionId, args) => {
    const endpoint = ${JSON.stringify(config.actionEndpoint)};
    if (!endpoint) throw new Error("This preview has no Server Action endpoint.");
    const body = await kernel.rscClient.encodeReply(args);
    const response = await fetch(endpoint, {
      body: JSON.stringify({
        action: { actionId, body: await serializeBody(body), revision: ${JSON.stringify(config.revision)}, url: ${JSON.stringify(config.url)} },
      }),
      headers: { "content-type": "text/plain;charset=UTF-8" },
      method: "POST",
    });
    if (!response.ok || !response.body) {
      throw new Error((await response.text()) || "The Server Action request failed.");
    }
    const payload = await kernel.rscClient.createFromReadableStream(response.body, {
      callServer: globalThis.__TUTO_NEXT_CALL_SERVER__,
    });
    root.render(payload.root);
    return payload.actionResult;
  };
  const model = await kernel.rscClient.createFromReadableStream(stream, {
    callServer: globalThis.__TUTO_NEXT_CALL_SERVER__,
  });
  root = kernel.reactDomClient.hydrateRoot(document, model);
  globalThis.__TUTO_NEXT_ROOT__ = root;
  globalThis.__TUTO_NEXT_HYDRATED__ = ${JSON.stringify(config.generation)};
})().catch((error) => {
  globalThis.__TUTO_NEXT_HYDRATION_ERROR__ = error instanceof Error ? error.stack : String(error);
  console.error(error);
});`;
}

function responseHeaders(
  artifact: NextRequestArtifact,
  result: NextFlightWorkerResult,
  contentType: string,
) {
  return {
    "cache-control": "private, no-store",
    "content-type": contentType,
    "x-tuto-next-cache": `hit=${result.cacheMetrics.hits}; stale=${result.cacheMetrics.staleHits}; miss=${result.cacheMetrics.misses}; write=${result.cacheMetrics.writes}; revalidate=${result.cacheMetrics.revalidations}`,
    "x-tuto-next-generation": artifact.generation,
    ...(result.routePattern
      ? { "x-tuto-next-route-pattern": result.routePattern }
      : {}),
  };
}

export async function renderHydratableNextRequestArtifact(
  artifact: NextRequestArtifact,
  options: NextRuntimeRequest & { actionEndpoint?: string } = {},
) {
  const url = options.url ?? "/";
  const result = await getNextRscWorkerPool().render(artifact, url, [
    ...new Headers(options.headers).entries(),
  ]);
  const html = await flightToHtml(artifact, result);
  const scripts = `<script>${inlineScript(await readClientKernel())}</script>
<script>${inlineScript(artifact.clientBundle.code)}</script>
<script type="module">${inlineScript(
    hydrationBootstrap(result.flight, {
      actionEndpoint: options.actionEndpoint,
      generation: artifact.generation,
      revision: artifact.revision,
      url,
    }),
  )}</script>`;
  const document = html.includes("</body>")
    ? html.replace("</body>", `${scripts}</body>`)
    : `${html}${scripts}`;
  return new Response(document, {
    headers: responseHeaders(artifact, result, "text/html; charset=utf-8"),
    status: result.status,
  });
}

export async function renderNextRequestArtifact(
  artifact: NextRequestArtifact,
  options: NextRuntimeRequest & { flight?: boolean } = {},
) {
  const result = await getNextRscWorkerPool().render(
    artifact,
    options.url ?? "/",
    [...new Headers(options.headers).entries()],
  );
  if (options.flight) {
    return new Response(Uint8Array.from(result.flight), {
      headers: responseHeaders(
        artifact,
        result,
        "text/x-component; charset=utf-8",
      ),
      status: result.status,
    });
  }
  const html = await flightToHtml(artifact, result);
  return new Response(html, {
    headers: responseHeaders(artifact, result, "text/html; charset=utf-8"),
    status: result.status,
  });
}

export async function serializeNextActionBody(
  body: string | FormData,
): Promise<NextSerializedActionBody> {
  if (typeof body === "string") return { kind: "string", value: body };
  const entries: Extract<
    NextSerializedActionBody,
    { kind: "form-data" }
  >["entries"] = [];
  for (const [name, value] of body.entries()) {
    if (typeof value === "string") {
      entries.push({ kind: "string", name, value });
    } else {
      entries.push({
        contentType: value.type || "application/octet-stream",
        filename: value.name || "blob",
        kind: "file",
        name,
        value: Buffer.from(await value.arrayBuffer()).toString("base64"),
      });
    }
  }
  return { entries, kind: "form-data" };
}

export async function invokeNextServerAction(
  artifact: NextRequestArtifact,
  input: {
    actionId: string;
    body: NextSerializedActionBody;
    url?: string;
  },
) {
  const result = await getNextRscWorkerPool().invokeAction(artifact, {
    actionId: input.actionId,
    body: input.body,
    url: input.url ?? "/",
  });
  return new Response(Uint8Array.from(result.flight), {
    headers: {
      ...responseHeaders(artifact, result, "text/x-component; charset=utf-8"),
      "access-control-allow-origin": "*",
    },
    status: result.status,
  });
}

export async function invokeNextRouteHandler(
  artifact: NextRequestArtifact,
  options: NextRouteHandlerRequest = {},
) {
  const headers = new Headers(options.headers);
  const body =
    typeof options.body === "string"
      ? Buffer.from(options.body)
      : options.body
        ? Buffer.from(options.body)
        : undefined;
  const result = await getNextRscWorkerPool().invokeRouteHandler(artifact, {
    ...(body ? { bodyBase64: body.toString("base64") } : {}),
    headers: [...headers.entries()],
    method: (options.method ?? "GET").toUpperCase(),
    url: options.url ?? "/",
  });
  const responseHeaders = new Headers(result.headers);
  responseHeaders.set(
    "x-tuto-next-cache",
    `hit=${result.cacheMetrics.hits}; stale=${result.cacheMetrics.staleHits}; miss=${result.cacheMetrics.misses}; write=${result.cacheMetrics.writes}; revalidate=${result.cacheMetrics.revalidations}`,
  );
  responseHeaders.set("x-tuto-next-generation", artifact.generation);
  if (result.routePattern) {
    responseHeaders.set("x-tuto-next-route-pattern", result.routePattern);
  }
  return new Response(
    result.body.length > 0 ? Uint8Array.from(result.body) : null,
    {
      headers: responseHeaders,
      status: result.status,
      statusText: result.statusText,
    },
  );
}

function requestBody(options: NextRouteHandlerRequest) {
  if (typeof options.body === "string") return Buffer.from(options.body);
  if (options.body) return Buffer.from(options.body);
  return undefined;
}

export async function invokeNextProxy(
  artifact: NextRequestArtifact,
  options: NextRouteHandlerRequest = {},
) {
  const body = requestBody(options);
  return getNextRscWorkerPool().invokeProxy(artifact, {
    ...(body ? { bodyBase64: body.toString("base64") } : {}),
    headers: [...new Headers(options.headers).entries()],
    method: (options.method ?? "GET").toUpperCase(),
    url: options.url ?? "/",
  });
}

function mergeProxyResponseHeaders(
  proxyHeaders: Array<[string, string]>,
  response: Response,
) {
  const headers = new Headers(proxyHeaders);
  for (const [name, value] of response.headers.entries()) {
    if (name !== "set-cookie") headers.set(name, value);
  }
  if (typeof response.headers.getSetCookie === "function") {
    for (const cookie of response.headers.getSetCookie()) {
      headers.append("set-cookie", cookie);
    }
  } else {
    const cookie = response.headers.get("set-cookie");
    if (cookie) headers.append("set-cookie", cookie);
  }
  return headers;
}

export async function executeNextRequestArtifact(
  artifact: NextRequestArtifact,
  options: NextExecuteRequest = {},
) {
  const method = (options.method ?? "GET").toUpperCase();
  const originalUrl = options.url ?? "/";
  const proxy = artifact.router.proxy
    ? await invokeNextProxy(artifact, { ...options, method, url: originalUrl })
    : null;
  if (proxy?.outcome === "redirect" || proxy?.outcome === "response") {
    const headers = new Headers(proxy.headers);
    headers.set("x-tuto-next-proxy", `matched=1; outcome=${proxy.outcome}`);
    headers.set("x-tuto-next-runtime-kind", "proxy");
    return new Response(
      proxy.body.length > 0 ? Uint8Array.from(proxy.body) : null,
      {
        headers,
        status: proxy.status,
        statusText: proxy.statusText,
      },
    );
  }

  const url = proxy?.url ?? originalUrl;
  const headers = proxy?.requestHeaders ?? [
    ...new Headers(options.headers).entries(),
  ];
  const parsedUrl = new URL(url, "http://next.local");
  const matchedHandler = matchNextRouteHandler(artifact.router, parsedUrl);
  let response: Response;
  if (matchedHandler) {
    response = await invokeNextRouteHandler(artifact, {
      body: options.body,
      headers,
      method,
      url,
    });
    response.headers.set("x-tuto-next-runtime-kind", "route-handler");
  } else if (method === "GET" || method === "HEAD") {
    response = options.hydrate
      ? await renderHydratableNextRequestArtifact(artifact, {
          actionEndpoint: options.actionEndpoint,
          headers,
          url,
        })
      : await renderNextRequestArtifact(artifact, { headers, url });
    response.headers.set("x-tuto-next-runtime-kind", "page");
    if (method === "HEAD") {
      response = new Response(null, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    }
  } else {
    response = new Response(null, {
      headers: { allow: "GET, HEAD" },
      status: 405,
    });
  }

  if (!proxy) {
    response.headers.set("x-tuto-next-proxy", "absent");
    return response;
  }
  const combinedHeaders = mergeProxyResponseHeaders(proxy.headers, response);
  combinedHeaders.set(
    "x-tuto-next-proxy",
    `matched=${proxy.matched ? 1 : 0}; outcome=${proxy.outcome}`,
  );
  return new Response(response.body, {
    headers: combinedHeaders,
    status: response.status,
    statusText: response.statusText,
  });
}
