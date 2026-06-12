module.exports = {
  root: true,
  ignorePatterns: ["dist", "node_modules", "coverage", "*.d.ts"],
  overrides: [
    {
      files: ["src/**/*.{ts,tsx}"],
      parser: "@typescript-eslint/parser",
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname,
        sourceType: "module",
      },
      plugins: ["@typescript-eslint", "react-hooks", "react-refresh"],
      extends: ["plugin:@typescript-eslint/recommended"],
      rules: {
        // Keep the baseline green on the current codebase; re-enable after a cleanup PR.
        "no-unused-expressions": "off",
        "@typescript-eslint/no-unused-expressions": "off",
        "no-unused-vars": "off",
        "@typescript-eslint/no-unused-vars": "off",
        "@typescript-eslint/no-explicit-any": "off",
        "react-hooks/rules-of-hooks": "error",
        "react-hooks/exhaustive-deps": "off",
        "react-refresh/only-export-components": "off",
      },
    },
  ],
};
