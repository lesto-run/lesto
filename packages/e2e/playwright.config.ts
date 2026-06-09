import { defineConfig, devices } from "@playwright/test";

const PORT = 4180;

/**
 * Playwright boots the fixture server itself (`webServer`) and tears it down
 * after, so `bun run test:e2e` is the whole story — no manual server step. CI
 * runs this in its own job after installing the chromium browser.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "list",

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: "bun run fixtures/server.ts",
    url: `http://127.0.0.1:${PORT}`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
  },
});
