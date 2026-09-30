import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 60000,
    pool: "forks",
    // patchright-core leaves one CDP call unawaited when a page closes while it is still
    // attaching (the hung-page tab-server tests do exactly that); the tab server only logs
    // such rejections. Every other unhandled error still fails the run.
    onUnhandledError(error) {
      if ((error as { method?: string }).method === "Network.setCacheDisabled") return false;
    },
  },
});
