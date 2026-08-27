import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import kernelManifest from "../../../../../../lib/serverless-tanstack-start/kernel-manifest.generated.json";

export const runtime = "nodejs";

const kernelPath = resolve(
  process.cwd(),
  "lib",
  "serverless-tanstack-start",
  kernelManifest.client.file,
);
let kernelSourcePromise: Promise<string> | undefined;

function readKernelSource() {
  kernelSourcePromise ??= readFile(kernelPath, "utf8");
  return kernelSourcePromise;
}

export async function GET(request: Request) {
  const requestedVersion = new URL(request.url).searchParams.get("v");
  if (requestedVersion !== kernelManifest.id) {
    return new Response("Unknown TanStack Start client kernel.", {
      headers: { "cache-control": "no-store" },
      status: 404,
    });
  }

  return new Response(await readKernelSource(), {
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "text/javascript; charset=utf-8",
      etag: `"${kernelManifest.id}"`,
    },
  });
}
