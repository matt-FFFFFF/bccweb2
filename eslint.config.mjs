// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { ignores, nodeScripts, e2eConfig } from "./eslint.config.base.mjs";

export default [
  ignores,
  nodeScripts,
  ...e2eConfig,
];
