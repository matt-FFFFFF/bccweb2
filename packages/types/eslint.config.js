// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { ignores, tsSyntactic } from "../../eslint.config.base.mjs";

export default [
  ignores,
  ...tsSyntactic({ files: ["src/**/*.ts"] }),
];
