import type { OxfmtConfig } from "oxfmt";

/**
 * Canonical formatting defaults for standalone Oxfmt and Vite+ projects.
 *
 * Oxfmt does not support config inheritance. Spread this object into a
 * standalone Oxfmt config or Vite+'s `fmt` block before local overrides.
 */
export const recommendedOxfmtConfig = {
  arrowParens: "always",
  endOfLine: "lf",
  printWidth: 100,
  semi: true,
  singleQuote: false,
  sortImports: true,
  sortPackageJson: true,
  tabWidth: 2,
  trailingComma: "all",
  useTabs: false,
} satisfies OxfmtConfig;

export type RecommendedOxfmtConfig = typeof recommendedOxfmtConfig;
