import { readFile } from "node:fs/promises";
import path from "node:path";
import type { NextRequestArtifact } from "./artifact";
import { getNextRscWorkerPool } from "./rsc-worker-pool";
import { getNextSsrWorkerPool } from "./ssr-worker-pool";

async function flightToHtml(artifact: NextRequestArtifact, flight: Buffer) {
  return getNextSsrWorkerPool().render(artifact, flight);
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

function hydrationBootstrap(flight: Buffer, generation: string) {
  return `(async () => {
  const encoded = ${JSON.stringify(flight.toString("base64"))};
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const kernel = globalThis.__TUTO_NEXT_CLIENT_KERNEL__;
  const model = await kernel.rscClient.createFromReadableStream(stream);
  kernel.reactDomClient.hydrateRoot(document, model);
  globalThis.__TUTO_NEXT_HYDRATED__ = ${JSON.stringify(generation)};
})().catch((error) => {
  globalThis.__TUTO_NEXT_HYDRATION_ERROR__ = error instanceof Error ? error.stack : String(error);
  console.error(error);
});`;
}

export async function renderHydratableNextRequestArtifact(
  artifact: NextRequestArtifact,
) {
  const flight = await getNextRscWorkerPool().render(artifact);
  const html = await flightToHtml(artifact, flight);
  const scripts = `<script>${inlineScript(await readClientKernel())}</script>
<script>${inlineScript(artifact.clientBundle.code)}</script>
<script type="module">${inlineScript(hydrationBootstrap(flight, artifact.generation))}</script>`;
  const document = html.includes("</body>")
    ? html.replace("</body>", `${scripts}</body>`)
    : `${html}${scripts}`;
  return new Response(document, {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "text/html; charset=utf-8",
      "x-tuto-next-generation": artifact.generation,
    },
  });
}

export async function renderNextRequestArtifact(
  artifact: NextRequestArtifact,
  options: { flight?: boolean } = {},
) {
  const flight = await getNextRscWorkerPool().render(artifact);
  if (options.flight) {
    return new Response(flight, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/x-component; charset=utf-8",
        "x-tuto-next-generation": artifact.generation,
      },
    });
  }
  const html = await flightToHtml(artifact, flight);
  return new Response(html, {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "text/html; charset=utf-8",
      "x-tuto-next-generation": artifact.generation,
    },
  });
}
