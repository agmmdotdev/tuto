import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/serverless/compile": [
      "./lib/serverless-vite/**/*.cjs",
      "./node_modules/esbuild/**/*",
      "./node_modules/@esbuild/**/*",
    ],
  },
};

export default nextConfig;
