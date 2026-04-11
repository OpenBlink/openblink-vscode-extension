// @ts-check
const tseslint = require("@typescript-eslint/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");

/** @type {import("eslint").Linter.Config[]} */
module.exports = [
  // Global ignores (must be a standalone config object)
  {
    ignores: ["out/**", "dist/**", "node_modules/**", "resources/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,

      // TypeScript-specific rules
      "@typescript-eslint/naming-convention": [
        "warn",
        {
          selector: "import",
          format: ["camelCase", "PascalCase"],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],

      // General rules
      curly: "warn",
      eqeqeq: "warn",
      "no-throw-literal": "warn",
      "prefer-const": "warn",
      semi: "warn",
    },
  },
];
