import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const runtimeRequire = createRequire(import.meta.url);
const outputPath = path.resolve(
  "lib/serverless-next/client-kernel.generated.js",
);
const manifestPath = path.resolve(
  "lib/serverless-next/client-kernel-manifest.generated.json",
);
const entry = `
import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactDomClient from "react-dom/client";
import * as RscClient from "next/dist/compiled/react-server-dom-webpack/client.browser";

globalThis.__TUTO_NEXT_CLIENT_KERNEL__ = Object.freeze({
  modules: Object.freeze({
    react: React,
    "react/jsx-runtime": ReactJsxRuntime,
  }),
  reactDomClient: ReactDomClient,
  rscClient: RscClient,
});
`;

const result = await build({
  banner: {
    js: `/* eslint-disable */
globalThis.__TUTO_NEXT_CLIENT_MODULES__ ||= Object.create(null);
globalThis.__webpack_require__ ||= ((id) => globalThis.__TUTO_NEXT_CLIENT_MODULES__[id]);
globalThis.__webpack_require__.u ||= ((id) => String(id));
globalThis.__webpack_chunk_load__ ||= (async () => {});`,
  },
  bundle: true,
  define: { "process.env.NODE_ENV": '"production"' },
  format: "iife",
  logLevel: "warning",
  minify: true,
  outfile: outputPath,
  platform: "browser",
  stdin: {
    contents: entry,
    loader: "js",
    resolveDir: process.cwd(),
    sourcefile: "tuto-next-client-kernel.js",
  },
  target: "es2022",
  write: false,
});

const code = result.outputFiles[0].text;
const id = createHash("sha256").update(code).digest("hex").slice(0, 20);
await writeFile(outputPath, code);
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      bytes: Buffer.byteLength(code),
      file: path.basename(outputPath),
      id,
      next: runtimeRequire("next/package.json").version,
      react: runtimeRequire("react/package.json").version,
      reactDom: runtimeRequire("react-dom/package.json").version,
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify({
    bytes: Buffer.byteLength(code),
    hash: id,
    output: path.relative(process.cwd(), outputPath),
  }),
);
