import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/*-runtime/**",
      "**/.pnpm-store/**",
      "**/dist/**",
      "**/out/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/.vite/**",
      "**/node_modules/**",
      "apps/desktop/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  {
    files: ["**/e2e/**/*.ts", "**/playwright.config.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["apps/web/**/*.{ts,tsx}", "packages/ui/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["apps/server/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.config.{js,mjs,cjs}", "**/scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["apps/web/public/**/*.js", "scripts/project-manager-ui/**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
);
