import { ignores, nodeScripts, e2eConfig } from "./eslint.config.base.mjs";

export default [
  ignores,
  nodeScripts,
  ...e2eConfig,
];
