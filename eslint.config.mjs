import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const commonRules = {
  "no-debugger": "error",
  "no-duplicate-imports": "error",
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
  "no-restricted-imports": ["error", {
    patterns: [{
      group: ["**/license-service/**", "**/website/**"],
      message: "Public code must not import private repository sources.",
    }],
  }],
  "no-throw-literal": "error",
  "no-unreachable": "error",
  "no-useless-concat": "error",
};

export default [
  {
    ignores: [
      "**/bin/**",
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/obj/**",
      "**/target/**",
      "memory/**",
      "packages/license-service/**",
      "website/**",
    ],
  },
  {
    files: ["scripts/**/*.mjs", "tests/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      ...commonRules,
    },
  },
  {
    files: [
      "packages/node/src/**/*.ts",
      "packages/node/tests/**/*.ts",
      "src/**/*.ts",
      "tests/**/*.ts",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      parser: tsParser,
      parserOptions: {
        sourceType: "module",
      },
      sourceType: "module",
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...commonRules,
    },
  },
];
