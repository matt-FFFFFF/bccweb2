// Shared, composable ESLint base fragments for the bccweb2 workspace.
//
// This is NOT an auto-loaded ESLint config. It exports named fragments that
// per-workspace configs (apps/api, packages/*) and the root eslint.config.mjs
// (scripts + e2e) import and compose. Keep imports bare (package) only.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import playwright from "eslint-plugin-playwright";

// Global ignore set shared by every workspace config.
export const ignores = {
  ignores: [
    "**/dist/**",
    "**/node_modules/**",
    "**/coverage/**",
    "**/*.d.ts",
    ".worktrees/**",
    "scripts/migrate/**",
  ],
};

// Convergence ruleset applied everywhere TypeScript is linted. All `error`.
export const sharedTsRules = {
  "no-unused-vars": "off",
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    },
  ],
  "@typescript-eslint/no-explicit-any": "error",
  "no-unused-expressions": "off",
  "@typescript-eslint/no-unused-expressions": "error",
};

// syntactic TS, scoped by caller (default src/**/*.ts). Returns an array.
export function tsSyntactic({ files = ["src/**/*.ts"] } = {}) {
  return tseslint.config({
    files,
    extends: [...tseslint.configs.recommended],
    rules: { ...sharedTsRules },
  });
}

// type-aware TS, scoped by caller (default src/**/*.ts). Returns an array.
export function tsTypeAware({ tsconfigRootDir, project, files = ["src/**/*.ts"] }) {
  return tseslint.config({
    files,
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { project, tsconfigRootDir } },
    rules: { ...sharedTsRules },
  });
}

// Relax the loose type-aware rules on test files (heavy mocking, casts).
export const apiTestRelax = {
  files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unsafe-assignment": "off",
    "@typescript-eslint/no-unsafe-member-access": "off",
    "@typescript-eslint/no-unsafe-call": "off",
    "@typescript-eslint/no-unsafe-argument": "off",
    "@typescript-eslint/no-unsafe-return": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    // The following fire only/overwhelmingly in tests as idiomatic-test-pattern
    // false-positives, per typescript-eslint guidance for test files. They stay
    // ON for production src (not relaxed here): require-await flags `async () => {}`
    // test callbacks that legitimately have no await; unbound-method flags passing
    // methods straight to mocks/spies/assertions; no-unsafe-function-type flags
    // `Function`-typed mock helpers; prefer-promise-reject-errors flags deliberate
    // non-Error rejection tests. no-floating-promises (the real missing-await safety
    // rule) is unaffected and stays enabled, so this hides no async bugs.
    "@typescript-eslint/require-await": "off",
    "@typescript-eslint/unbound-method": "off",
    "@typescript-eslint/no-unsafe-function-type": "off",
    "@typescript-eslint/prefer-promise-reject-errors": "off",
  },
};

// Plain Node ESM lint for scripts/*.mjs (no TS, no type-awareness).
export const nodeScripts = {
  files: ["scripts/**/*.mjs"],
  ...js.configs.recommended,
  languageOptions: { sourceType: "module", globals: { ...globals.node } },
};

// Playwright e2e, fully scoped to tests/e2e/**/*.ts. Returns an array.
export const e2eConfig = tseslint.config({
  files: ["tests/e2e/**/*.ts"],
  extends: [...tseslint.configs.recommended, playwright.configs["flat/recommended"]],
  rules: { ...sharedTsRules },
});
