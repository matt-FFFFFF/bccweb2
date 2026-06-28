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

// Syntactic (non type-aware) TS lint. Powers packages/* and e2e.
export const tsSyntactic = [
  ...tseslint.configs.recommended,
  { rules: { ...sharedTsRules } },
];

// Type-aware TS lint factory. Powers apps/api, which needs a parser project.
export function tsTypeAware({ tsconfigRootDir, project }) {
  return [
    ...tseslint.configs.recommendedTypeChecked,
    { languageOptions: { parserOptions: { project, tsconfigRootDir } } },
    { rules: { ...sharedTsRules } },
  ];
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
  },
};

// Plain Node ESM lint for scripts/*.mjs (no TS, no type-awareness).
export const nodeScripts = {
  files: ["scripts/**/*.mjs"],
  ...js.configs.recommended,
  languageOptions: { sourceType: "module", globals: { ...globals.node } },
};

// Playwright E2E lint. Spreads syntactic TS + the playwright flat preset.
export const e2eConfig = [
  ...tseslint.configs.recommended,
  playwright.configs["flat/recommended"],
  { files: ["tests/e2e/**/*.ts"], rules: { ...sharedTsRules } },
];
