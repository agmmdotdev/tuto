import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/serverless-tanstack-start/*.test.ts"],
    pool: "forks",
    testTimeout: 120_000,
  },
});
