import { ignores, tsSyntactic } from "../../eslint.config.base.mjs";

export default [
  ignores,
  ...tsSyntactic({ files: ["src/**/*.ts"] }),
];
