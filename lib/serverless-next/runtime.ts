import { readFile } from "node:fs/promises";
import path from "node:path";
import type { NextRequestArtifact } from "./artifact";
import {
  getNextRscWorkerPool,
  type NextFlightWorkerResult,
  type NextSerializedActionBody,
} from "./rsc-worker-pool";
import { getNextSsrWorkerPool } from "./ssr-worker-pool";

export type NextRuntimeRequest = {
  url?: string;
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
  const result = await getNextRscWorkerPool().render(artifact, url);
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
