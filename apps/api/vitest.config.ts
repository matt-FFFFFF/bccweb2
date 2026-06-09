import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/__tests__/**/*.test.ts",
      "src/functions/__tests__/**/*.test.ts",
      "src/lib/__tests__/http.test.ts",
      "src/lib/__tests__/recompute.test.ts",
      "src/lib/__tests__/rateLimit.test.ts",
      "src/lib/__tests__/telemetryRedactor.test.ts",
      "src/lib/__tests__/pdf.test.ts",
      "src/lib/signTofly/__tests__/**/*.test.ts",
    ],
    setupFiles: [
      "src/__tests__/helpers/setup.ts",
      "src/__tests__/helpers/azurite.ts",
    ],
    testTimeout: 15_000,
    // Run tests within a file sequentially for reliable blob state
    sequence: {
      concurrent: false,
    },
    fileParallelism: false,
  },
});
