import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/serverless/compile": [
      "./lib/serverless-vite/**/*.cjs",
      "./node_modules/esbuild/**/*",
      "./node_modules/@esbuild/**/*",
      "./node_modules/react/**/*",
      "./node_modules/react-dom/**/*",
      "./node_modules/scheduler/**/*",
      "./node_modules/lucide-react/**/*",
      "./node_modules/motion/**/*",
      "./node_modules/framer-motion/**/*",
      "./node_modules/tslib/**/*",
    ],
  },
};

export default nextConfig;
