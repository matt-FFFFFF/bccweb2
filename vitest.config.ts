import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/scoring",
      "packages/types",
      "packages/schemas",
      "apps/api",
      "apps/web",
    ],
  },
});
