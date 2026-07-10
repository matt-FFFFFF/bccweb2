// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async (): Promise<UserConfig> => ({
  plugins: [
    react(),
    // Gated dynamic import: a normal/prod build never loads this devDep (survives
    // `npm ci --omit=dev`); emitFile stays false so the treemap lands in
    // .omo/evidence/ (relative to the apps/web cwd), never in the shipped dist/web.
    ...(process.env.ANALYZE
      ? [
          (await import("rollup-plugin-visualizer")).visualizer({
            filename: "../../.omo/evidence/treemap-baseline.html",
            gzipSize: true,
            brotliSize: true,
          }),
        ]
      : []),
  ],
  server: {
    port: 5173,
    proxy: {
      // Proxy /api/* to local Functions during development
      "/api": {
        target: "http://localhost:7071",
        changeOrigin: true,
      },
      // Proxy /.auth/* to local SWA CLI during development
      "/.auth": {
        target: "http://localhost:4280",
        changeOrigin: true,
      },
      // Proxy /blob/* to Azurite blob service for direct public blob reads
      "/blob": {
        target: "http://127.0.0.1:10000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/blob/, "/devstoreaccount1/data"),
      },
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
}));
