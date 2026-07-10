// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { ignores, tsTypeAware, apiTestRelax } from "../../eslint.config.base.mjs";

export default [
  ignores,
  ...tsTypeAware({
    tsconfigRootDir: import.meta.dirname,
    project: ["./tsconfig.eslint.json"],
  }),
  apiTestRelax,
];
