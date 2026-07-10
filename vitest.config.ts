// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
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
