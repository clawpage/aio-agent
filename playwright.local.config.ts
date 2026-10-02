import { defineConfig, devices } from "@playwright/test";

/**
 * Local Playwright harness: serves the built web app from a static server and
 * relies on each spec to mock every control-plane API with `page.route`. It
 * never talks to a real deployment and has no auth setup project, so it is safe
 * to run while production is live.
 *
 * Usage:
 *   npm run build
 *   npx playwright test --config playwright.local.config.ts tests/e2e/browser-auto-open.spec.ts
 */
const PORT = 4288;

export default defineConfig({
  testDir: "tests/e2e",
  // Only the self-contained, fully mocked specs. Specs that exercise a real
  // backend must run under the default `playwright.config.ts` against a local
  // instance, never here.
  testMatch: [
    "**/browser-auto-open.spec.ts",
    "**/browser-link.spec.ts",
    "**/browser-lifecycle.spec.ts",
    "**/archived-list.spec.ts",
    "**/conversation-management.spec.ts",
    "**/chat-motion.spec.ts",
    "**/menu-qa.spec.ts",
    "**/file-preview.spec.ts",
    "**/documents.spec.ts",
    "**/mobile-chat.spec.ts",
    "**/settings.spec.ts",
    "**/working.spec.ts",
    "**/main-tasks.spec.ts",
    "**/terminal-sessions.spec.ts",
    "**/login-restore.spec.ts",
    "**/member-access.spec.ts",
    "**/desktop.spec.ts",
    "**/map-card.spec.ts",
    "**/schedules.spec.ts",
  ],
  outputDir: "var/.playwright-local",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    storageState: { cookies: [], origins: [] },
  },
  webServer: {
    command: `node tests/e2e/static-server.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      name: "mobile-webkit",
      testMatch: [
        "**/browser-lifecycle.spec.ts",
        "**/mobile-chat.spec.ts",
        "**/settings.spec.ts",
        "**/working.spec.ts",
    "**/main-tasks.spec.ts",
        "**/terminal-sessions.spec.ts",
    "**/login-restore.spec.ts",
    "**/member-access.spec.ts",
        "**/documents.spec.ts",
        "**/desktop.spec.ts",
        "**/map-card.spec.ts",
        "**/schedules.spec.ts",
      ],
      use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } },
    },
  ],
});
