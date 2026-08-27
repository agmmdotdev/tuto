import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { buildTanstackStartKernels } from "./build-tanstack-start-kernels.mjs";

await buildTanstackStartKernels();

await build({
  entryPoints: [
    "lib/serverless-tanstack-start/client-route-fetch.ts",
    "lib/serverless-tanstack-start/core-preview-runner.ts",
    "lib/serverless-tanstack-start/core-rpc-runner.ts",
    "lib/serverless-tanstack-start/core-compiler-runner.ts",
    "lib/serverless-tanstack-start/native-rpc-runner.ts",
  ],
  platform: "node",
  format: "cjs",
  target: "node22",
  outdir: "lib/serverless-tanstack-start",
  outExtension: {
    ".js": ".generated.cjs",
  },
});

const runnerPaths = [
  "lib/serverless-tanstack-start/core-preview-runner.generated.cjs",
  "lib/serverless-tanstack-start/core-rpc-runner.generated.cjs",
  "lib/serverless-tanstack-start/core-compiler-runner.generated.cjs",
  "lib/serverless-tanstack-start/native-rpc-runner.generated.cjs",
];

await Promise.all(
  runnerPaths.map(async (filePath) => {
    const contents = await readFile(filePath, "utf8");
    await writeFile(
      filePath,
      contents
        .replaceAll(
          'require("./server-functions-transform")',
          'require("./server-functions-transform.generated.cjs")',
        )
        .replaceAll(
          'require("./client-route-fetch")',
          'require("./client-route-fetch.generated.cjs")',
        ),
    );
  }),
);

const runtimePaths = [
  "lib/serverless-tanstack-start/server-functions-transform.generated.cjs",
  "lib/serverless-tanstack-start/client-route-fetch.generated.cjs",
  ...runnerPaths,
  "lib/serverless-tanstack-start/client-kernel.generated.js",
  "lib/serverless-tanstack-start/server-kernel.generated.mjs",
  "lib/serverless-tanstack-start/kernel-manifest.generated.json",
  "lib/serverless-tanstack-start/native-rpc-protocol.ts",
  "lib/serverless-tanstack-start/native-rpc-worker-pool.ts",
  "lib/serverless-tanstack-start/server-runtime-store.ts",
];
const runtimeHash = createHash("sha256");
for (const filePath of runtimePaths) {
  runtimeHash.update(`${filePath}\n`);
  runtimeHash.update(await readFile(filePath));
}
await writeFile(
  "lib/serverless-tanstack-start/runtime-manifest.generated.json",
  `${JSON.stringify({ id: runtimeHash.digest("hex") }, null, 2)}\n`,
  "utf8",
);
