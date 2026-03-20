import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/serverless/compile": [
      "./lib/serverless-vite/**/*.cjs",
      "./node_modules/@vitejs/**/*",
      "./node_modules/vite/**/*",
      "./node_modules/rolldown/**/*",
      "./node_modules/@rolldown/**/*",
      "./node_modules/esbuild/**/*",
      "./node_modules/@esbuild/**/*",
      "./node_modules/lightningcss/**/*",
      "./node_modules/tinyglobby/**/*",
      "./node_modules/fdir/**/*",
      "./node_modules/picomatch/**/*",
      "./node_modules/postcss/**/*",
    ],
  },
};

export default nextConfig;
