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
  const html = await getNextSsrWorkerPool().render(artifact, result.flight);
  const styleElements = result.stylePaths
    .map((stylePath) => {
      const style = artifact.styles[stylePath];
      if (!style) return "";
      const safePath = stylePath
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      return `<style data-tuto-next-style="${safePath}">${style.css.replaceAll("</style", "<\\/style")}</style>`;
    })
    .join("");
  if (!styleElements) return html;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${styleElements}</head>`);
  }
  return `${styleElements}${html}`;
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
    headers: Array<[string, string]>;
    revision: string;
    url: string;
  },
) {
  return `(async () => {
  const encoded = ${JSON.stringify(flight.toString("base64"))};
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const kernel = globalThis.__TUTO_NEXT_CLIENT_KERNEL__;
  const actionHeaders = new Headers(${JSON.stringify(config.headers)});
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
  function applyVirtualCookies(response) {
    const encoded = response.headers.get("x-tuto-next-virtual-set-cookie");
    if (!encoded) return;
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const setCookies = JSON.parse(new TextDecoder().decode(bytes));
    const jar = new Map();
    for (const part of (actionHeaders.get("cookie") || "").split(";")) {
      const pair = part.trim();
      const equals = pair.indexOf("=");
      if (equals > 0) jar.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    for (const setCookie of setCookies) {
      const pair = setCookie.split(";", 1)[0];
      const equals = pair.indexOf("=");
      if (equals <= 0) continue;
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1);
      const maxAge = /(?:^|;)\\s*max-age\\s*=\\s*(-?\\d+)/i.exec(setCookie);
      const expires = /(?:^|;)\\s*expires\\s*=\\s*([^;]+)/i.exec(setCookie);
      const expired = maxAge
        ? Number(maxAge[1]) <= 0
        : expires
          ? Date.parse(expires[1]) <= Date.now()
          : false;
      if (expired) jar.delete(name);
      else jar.set(name, value);
    }
    if (jar.size > 0) {
      actionHeaders.set("cookie", [...jar].map(([name, value]) => name + "=" + value).join("; "));
    } else {
      actionHeaders.delete("cookie");
    }
  }
  globalThis.__TUTO_NEXT_CALL_SERVER__ = async (actionId, args) => {
    const endpoint = ${JSON.stringify(config.actionEndpoint)};
    if (!endpoint) throw new Error("This preview has no Server Action endpoint.");
    const body = await kernel.rscClient.encodeReply(args);
    const response = await fetch(endpoint, {
      body: JSON.stringify({
        action: { actionId, body: await serializeBody(body), headers: Object.fromEntries(actionHeaders.entries()), revision: ${JSON.stringify(config.revision)}, url: ${JSON.stringify(config.url)} },
      }),
      headers: { "content-type": "text/plain;charset=UTF-8" },
      method: "POST",
      redirect: "manual",
    });
    applyVirtualCookies(response);
    if (!response.ok || !response.body) {
      const location = response.headers.get("location");
      throw new Error(
        location
          ? "The Server Action proxy redirected to " + location + "."
          : (await response.text()) || "The Server Action request failed.",
      );
    }
    if (!(response.headers.get("content-type") || "").startsWith("text/x-component")) {
      throw new Error(
        (await response.text()) ||
          "The Server Action proxy returned a non-Flight response.",
      );
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
      headers: [...new Headers(options.headers).entries()],
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
    headers?: HeadersInit;
    url?: string;
  },
) {
  const result = await getNextRscWorkerPool().invokeAction(artifact, {
    actionId: input.actionId,
    body: input.body,
    headers: [...new Headers(input.headers).entries()],
    url: input.url ?? "/",
  });
  const headers = new Headers(
    responseHeaders(artifact, result, "text/x-component; charset=utf-8"),
  );
  for (const [name, value] of result.headers) {
    if (name === "set-cookie") headers.append(name, value);
    else headers.set(name, value);
  }
  headers.set("access-control-allow-origin", "*");
  return new Response(Uint8Array.from(result.flight), {
    headers,
    status: result.status,
  });
}

async function serializedActionProxyBody(body: NextSerializedActionBody) {
  if (body.kind === "string") {
    return {
      body: Buffer.from(body.value),
      contentType: "text/plain;charset=UTF-8",
    };
  }
  const formData = new FormData();
  for (const entry of body.entries) {
    if (entry.kind === "string") {
      formData.append(entry.name, entry.value);
    } else {
      formData.append(
        entry.name,
        new File([Buffer.from(entry.value, "base64")], entry.filename, {
          type: entry.contentType,
        }),
      );
    }
  }
  const request = new Request("http://next.local", {
    body: formData,
    method: "POST",
  });
  return {
    body: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get("content-type") ?? "multipart/form-data",
  };
}

export async function executeNextServerActionArtifact(
  artifact: NextRequestArtifact,
  input: {
    actionId: string;
    body: NextSerializedActionBody;
    headers?: HeadersInit;
    url?: string;
  },
) {
  const originalUrl = input.url ?? "/";
  const actionBody = await serializedActionProxyBody(input.body);
  const originalHeaders = new Headers(input.headers);
  originalHeaders.delete("content-length");
  originalHeaders.delete("host");
  originalHeaders.delete("transfer-encoding");
  originalHeaders.set("accept", "text/x-component");
  originalHeaders.set("content-type", actionBody.contentType);
  originalHeaders.set("next-action", input.actionId);
  const proxy = artifact.router.proxy
    ? await invokeNextProxy(artifact, {
        body: actionBody.body,
        headers: originalHeaders,
        method: "POST",
        url: originalUrl,
      })
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

  const actionHeaders = new Headers(proxy?.requestHeaders ?? originalHeaders);
  const actionId = actionHeaders.get("next-action");
  if (!actionId) {
    const headers = new Headers({
      "cache-control": "private, no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-tuto-next-proxy": proxy
        ? `matched=${proxy.matched ? 1 : 0}; outcome=${proxy.outcome}`
        : "absent",
      "x-tuto-next-runtime-kind": "server-action",
    });
    return new Response(
      "The proxy removed the next-action header, so the Server Action was not dispatched.",
      { headers, status: 400 },
    );
  }
  const response = await invokeNextServerAction(artifact, {
    actionId,
    body: input.body,
    headers: actionHeaders,
    url: proxy?.url ?? originalUrl,
  });
  response.headers.set("x-tuto-next-runtime-kind", "server-action");
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

function staticAssetPath(pathname: string) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function etagMatches(value: string | null, etag: string) {
  if (!value) return false;
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, "");
    return normalized === "*" || normalized === etag;
  });
}

function serveNextStaticAsset(
  artifact: NextRequestArtifact,
  requestUrl: URL,
  method: string,
  requestHeaders: HeadersInit,
) {
  const asset = artifact.staticAssets[staticAssetPath(requestUrl.pathname)];
  if (!asset || (method !== "GET" && method !== "HEAD")) return null;
  const body = Buffer.from(asset.bodyBase64, "base64");
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=0, must-revalidate",
    "content-length": String(body.byteLength),
    "content-type": asset.contentType,
    etag: asset.etag,
    "x-tuto-next-generation": artifact.generation,
    "x-tuto-next-runtime-kind": "public-asset",
  });
  if (etagMatches(new Headers(requestHeaders).get("if-none-match"), asset.etag)) {
    headers.delete("content-length");
    return new Response(null, { headers, status: 304 });
  }
  return new Response(method === "HEAD" ? null : body, {
    headers,
    status: 200,
  });
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
  let response = serveNextStaticAsset(artifact, parsedUrl, method, headers);
  if (response) {
    // Public files are immutable bytes inside this compiled generation. The
    // URL remains revalidated because a later generation may change the file.
  } else if (matchedHandler) {
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
