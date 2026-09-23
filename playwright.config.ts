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
  // Specs that fully mock the control plane (`page.route`) run under
  // playwright.local.config.ts against the static `dist/web` build. They must
  // never run against a real deployment: they need no server, and one of them
  // writes visual-QA screenshots to the workspace.
  testIgnore: [
    /browser-auto-open\.spec\.ts/,
    /browser-link\.spec\.ts/,
    /archived-list\.spec\.ts/,
    /conversation-management\.spec\.ts/,
    /chat-motion\.spec\.ts/,
    /menu-qa\.spec\.ts/,
  ],
  // Failure artifacts (traces/snapshots) can contain typed secrets such as the
  // owner password, so they are written under the git-ignored var/ directory
  // which the setup creates with 0700 permissions.
  outputDir: "var/.playwright",
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
