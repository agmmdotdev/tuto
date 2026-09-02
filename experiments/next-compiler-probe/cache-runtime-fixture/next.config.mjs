/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheComponents: true,
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
