// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const typesSrc = fileURLToPath(new URL("../../packages/types/src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@bccweb/types": typesSrc,
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/__tests__/**/*.test.{ts,tsx}", "src/__tests__/**/*.test.{ts,tsx}"],
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
