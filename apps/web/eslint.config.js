import reactHooks from "eslint-plugin-react-hooks";
import { reactRefresh } from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage", "**/*.d.ts"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh.plugin,
    },
    languageOptions: { sourceType: "module" },
    rules: {
      "no-unused-expressions": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "no-unused-vars": "off",
      // Re-enabled per issue #10 item 1; mirrors the ^_ opt-out convention in
      // eslint.config.base.mjs. Base no-unused-vars stays off intentionally.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Re-enabled per issue #10 item 2.
      "@typescript-eslint/no-explicit-any": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "off",
      "react-refresh/only-export-components": "off",
    },
  },
);
