import { defineConfig } from "vite";
export default defineConfig({
  root: "src/web",
  esbuild: { jsx: "automatic" },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: 5199,
    proxy: {
      "/api": { target: "http://127.0.0.1:4891", changeOrigin: false },
    },
  },
});
