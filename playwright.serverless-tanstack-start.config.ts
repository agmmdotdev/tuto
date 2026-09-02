import { defineConfig, devices } from "@playwright/test";

const port = 3107;
const baseURL = `http://127.0.0.1:${port}`;

// Some container runtimes do not expose the user namespaces Firefox's content
// sandbox expects. The browser process is already isolated by the test runner.
process.env.MOZ_DISABLE_CONTENT_SANDBOX ??= "1";

export default defineConfig({
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  reporter: "line",
  testDir: "./test/serverless-tanstack-start-browser",
  timeout: 180_000,
  use: {
    ...devices["Desktop Firefox"],
    baseURL,
    launchOptions: {
      firefoxUserPrefs: {
        "security.sandbox.content.level": 0,
        "security.sandbox.gpu.level": 0,
      },
    },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `yarn dev --hostname 127.0.0.1 --port ${port}`,
    env: {
      ...process.env,
      TUTO_TANSTACK_RSC_ACTION_ENCRYPTION_KEY:
        Buffer.alloc(32, 19).toString("base64"),
      TUTO_TANSTACK_WORKER_MAX_REQUESTS: "1",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: baseURL,
  },
});
