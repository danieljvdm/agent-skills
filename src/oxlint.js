/**
 * Runtime form of the typed preset declared in oxlint.ts.
 *
 * This file is intentionally plain JavaScript because Node does not strip
 * TypeScript from packages in node_modules when Vite+ loads vite.config.ts.
 */
import { devKitToolIgnorePatterns } from "./tool-ignore-patterns.js";

export { devKitToolIgnorePatterns } from "./tool-ignore-patterns.js";

export const recommendedOxlintConfig = {
  ignorePatterns: [...devKitToolIgnorePatterns],
  options: {
    typeAware: true,
  },
  jsPlugins: [
    {
      name: "effect",
      specifier: "@danieljvdm/dev-kit/oxlint-plugin-effect",
    },
    {
      name: "stylistic",
      specifier: "@danieljvdm/dev-kit/oxlint-plugin-style",
    },
  ],
  plugins: ["import", "react", "vitest"],
  rules: {
    eqeqeq: "error",
    "effect/prefer-schema-alias": "error",
    "import/default": "off",
    "import/namespace": "off",
    "import/no-cycle": "error",
    "import/no-duplicates": ["error", { preferInline: true }],
    "import/no-self-import": "error",
    "react/exhaustive-deps": "error",
    "react/rules-of-hooks": "error",
    "stylistic/padding-line-between-statements": [
      "error",
      { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
      {
        blankLine: "any",
        prev: ["const", "let", "var"],
        next: ["const", "let", "var"],
      },
      { blankLine: "always", prev: "*", next: "return" },
    ],
    "typescript/consistent-type-imports": [
      "error",
      { fixStyle: "inline-type-imports", prefer: "type-imports" },
    ],
    "typescript/no-floating-promises": "off",
    "typescript/no-explicit-any": "error",
    "typescript/no-misused-spread": "off",
    "typescript/no-non-null-assertion": "error",
    "typescript/require-array-sort-compare": "off",
    "typescript/restrict-template-expressions": "off",
    "typescript/switch-exhaustiveness-check": "error",
    "unicorn/prefer-node-protocol": "error",
    "vitest/no-focused-tests": "error",
    "vitest/no-identical-title": "error",
    "vitest/no-standalone-expect": "off",
    "vitest/valid-expect": "error",
  },
  overrides: [
    {
      files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
      rules: {
        "typescript/no-non-null-assertion": "off",
      },
    },
  ],
};
