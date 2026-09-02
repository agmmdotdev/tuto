import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/serverless-next-browser",
  timeout: 120_000,
  use: {
    browserName: "firefox",
    headless: true,
  },
  workers: 1,
});
