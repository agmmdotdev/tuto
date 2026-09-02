/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  webpack(config) {
    config.cache = false;
    return config;
  },
};

export default nextConfig;
