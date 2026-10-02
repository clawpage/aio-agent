import fs from "node:fs";
import { defineConfig } from "vite";
import { API_VERSION } from "./src/common/version";

const version = (JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

export default defineConfig({
  root: "src/ui",
  plugins: [
    {
      // What this build needs from the control plane; the UI edge checks it at startup.
      name: "aio-ui-build-info",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "aio-ui.json", source: JSON.stringify({ component: "ui", version, api: API_VERSION }) });
      },
    },
  ],
  esbuild: { jsx: "automatic" },
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: 5199,
    proxy: {
      "/api": { target: "http://127.0.0.1:4892", changeOrigin: false },
    },
  },
});
