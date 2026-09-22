import { defineConfig, devices } from "@playwright/test";

/**
 * UI acceptance runs against a real deployment. Default is production; override
 * with PA_E2E_BASE (e.g. http://localhost:4891) for a local instance.
 */
const baseURL = process.env.PA_E2E_BASE ?? "https://agent.zymx.tech";
const storageState = process.env.PA_E2E_STATE ?? "var/.auth/state.json";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 150_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  // Live deployments can hiccup; a single retry keeps signal without hiding flakes.
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    ignoreHTTPSErrors: false,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    storageState,
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, use: { storageState: { cookies: [], origins: [] } } },
    {
      name: "desktop",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      dependencies: ["setup"],
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
