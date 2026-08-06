/**
 * Runtime form of the typed preset declared in oxfmt.ts.
 *
 * This file is intentionally plain JavaScript because Node does not strip
 * TypeScript from packages in node_modules when tools load their config.
 */
import { devKitToolIgnorePatterns } from "./tool-ignore-patterns.js";

export { devKitToolIgnorePatterns } from "./tool-ignore-patterns.js";

export const recommendedOxfmtConfig = {
  arrowParens: "always",
  endOfLine: "lf",
  ignorePatterns: [...devKitToolIgnorePatterns],
  printWidth: 100,
  semi: true,
  singleQuote: false,
  sortImports: true,
  sortPackageJson: true,
  tabWidth: 2,
  trailingComma: "all",
  useTabs: false,
};
