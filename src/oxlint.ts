import type { OxlintConfig } from "vite-plus/lint";

/**
 * High-signal Oxlint defaults for TypeScript projects using Vite+.
 *
 * Extend this object from `lint.extends` so project-local plugins, rules, and
 * overrides compose without losing nested configuration.
 */
export const recommendedOxlintConfig = {
  options: {
    typeAware: true,
  },
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
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/switch-exhaustiveness-check": "error",
    "unicorn/prefer-node-protocol": "error",
    "vitest/no-focused-tests": "error",
    "vitest/no-identical-title": "error",
    "vitest/no-standalone-expect": "off",
    "vitest/valid-expect": "error",
  },
} satisfies OxlintConfig;

export type RecommendedOxlintConfig = typeof recommendedOxlintConfig;
