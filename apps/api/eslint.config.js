import { ignores, tsTypeAware, apiTestRelax } from "../../eslint.config.base.mjs";

export default [
  ignores,
  ...tsTypeAware({
    tsconfigRootDir: import.meta.dirname,
    project: ["./tsconfig.eslint.json"],
  }),
  apiTestRelax,
];
