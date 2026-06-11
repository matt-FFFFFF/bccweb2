import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      "packages/scoring",
      "packages/types",
      "packages/schemas",
      "apps/api",
      "apps/web",
    ],
  },
});
