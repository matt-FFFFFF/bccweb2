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
      // Re-enabled per issue #10 item 5. Base no-unused-expressions stays off
      // intentionally (typescript-eslint replaces it with the TS-aware rule).
      "@typescript-eslint/no-unused-expressions": "error",
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
      // Re-enabled per issue #10 item 3.
      "react-hooks/exhaustive-deps": "error",
      // Re-enabled per issue #10 item 4.
      "react-refresh/only-export-components": "error",
    },
  },
);
