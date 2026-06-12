import { defineConfig } from "vitest/config";

// blob.test.ts: real 60-70s lease-renewal timing tests.
// puretrack.test.ts: stubs global fetch and runs slow.
// telemetry.integration.test.ts: mutates global applicationinsights state.
// Excluded from the default run; promoted to the only includes when
// VITEST_HEAVY=1 so `make test-heavy` can target them in an isolated process.
const HEAVY_TESTS = [
  "src/lib/__tests__/blob.test.ts",
  "src/lib/__tests__/puretrack.test.ts",
  "src/lib/__tests__/telemetry.integration.test.ts",
];

const runHeavy = process.env["VITEST_HEAVY"] === "1";

export default defineConfig({
  test: {
    include: runHeavy
      ? HEAVY_TESTS
      : [
          "src/__tests__/**/*.test.ts",
          "src/functions/__tests__/**/*.test.ts",
          "src/lib/**/__tests__/**/*.test.ts",
          "src/lib/signTofly/__tests__/**/*.test.ts",
        ],
    exclude: runHeavy ? [] : HEAVY_TESTS,
    setupFiles: [
      "src/__tests__/helpers/setup.ts",
      "src/__tests__/helpers/azurite.ts",
    ],
    testTimeout: runHeavy ? 120_000 : 15_000,
    // Run tests within a file sequentially for reliable blob state
    sequence: {
      concurrent: false,
    },
    fileParallelism: false,
  },
});
