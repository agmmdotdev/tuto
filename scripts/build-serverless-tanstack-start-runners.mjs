import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

await build({
  entryPoints: [
    "lib/serverless-tanstack-start/core-preview-runner.ts",
    "lib/serverless-tanstack-start/core-rpc-runner.ts",
    "lib/serverless-tanstack-start/core-compiler-runner.ts",
  ],
  platform: "node",
  format: "cjs",
  target: "node22",
  outdir: "lib/serverless-tanstack-start",
  outExtension: {
    ".js": ".generated.cjs",
  },
});

await Promise.all(
  [
    "lib/serverless-tanstack-start/core-preview-runner.generated.cjs",
    "lib/serverless-tanstack-start/core-rpc-runner.generated.cjs",
    "lib/serverless-tanstack-start/core-compiler-runner.generated.cjs",
  ].map(async (filePath) => {
    const contents = await readFile(filePath, "utf8");
    await writeFile(
      filePath,
      contents.replaceAll(
        'require("./server-functions-transform")',
        'require("./server-functions-transform.generated.cjs")',
      ),
    );
  }),
);
