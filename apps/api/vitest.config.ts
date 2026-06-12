import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/__tests__/**/*.test.ts",
      "src/functions/__tests__/**/*.test.ts",
      "src/lib/**/__tests__/**/*.test.ts",
      "src/lib/signTofly/__tests__/**/*.test.ts",
    ],
    exclude: [
      "src/lib/__tests__/blob.test.ts", // EXCLUDED: real 60-70s lease-renewal timing tests; run via 'make test-heavy'.
      "src/lib/__tests__/puretrack.test.ts", // EXCLUDED: stubs global fetch and runs slow; run via 'make test-heavy'.
      "src/lib/__tests__/telemetry.integration.test.ts", // EXCLUDED: mutates global applicationinsights state; run via 'make test-heavy'.
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
