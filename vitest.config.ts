import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/scoring",
      "packages/types",
      "apps/api",
      "apps/web",
    ],
  },
});
