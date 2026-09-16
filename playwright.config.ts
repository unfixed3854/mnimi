import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/mobile/e2e",
  testMatch: "web.spec.ts",
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:18081",
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "bun run web:test:server",
      url: "http://127.0.0.1:18787/api/registration",
      reuseExistingServer: false,
    },
    {
      command: "bun run web:dev --port 18081",
      url: "http://localhost:18081",
      env: {
        EXPO_PUBLIC_API_URL: "http://localhost:18787",
        BROWSER: "none",
        CI: "1",
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
