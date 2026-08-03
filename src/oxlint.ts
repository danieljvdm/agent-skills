import type { OxlintConfig } from "oxlint";

/**
 * High-signal Oxlint defaults for TypeScript projects.
 *
 * Extend this object from standalone Oxlint's `extends`, or from Vite+'s
 * `lint.extends`, so project-local plugins, rules, and overrides compose
 * without losing nested configuration.
 */
export const recommendedOxlintConfig = {
  options: {
    typeAware: true,
  },
  jsPlugins: [
    {
      name: "effect",
      specifier: "@danieljvdm/dev-kit/oxlint-plugin-effect",
    },
  ],
  plugins: ["import", "react", "vitest"],
  rules: {
    eqeqeq: "error",
    "import/default": "off",
    "import/namespace": "off",
    "import/no-cycle": "error",
    "import/no-duplicates": "error",
    "import/no-self-import": "error",
    "react/exhaustive-deps": "error",
    "react/rules-of-hooks": "error",
    "typescript/consistent-type-imports": "error",
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
} satisfies OxlintConfig;

export type RecommendedOxlintConfig = typeof recommendedOxlintConfig;
