import { recommendedOxfmtConfig as packagedOxfmtConfig } from "@danieljvdm/dev-kit/oxfmt";
import { describe, expect, it } from "vitest";

import { recommendedOxfmtConfig as sourceOxfmtConfig } from "../src/oxfmt.ts";

describe("recommended Oxfmt config", () => {
  it("pins the shared format and sorting conventions", () => {
    expect(packagedOxfmtConfig).toMatchObject({
      ignorePatterns: [
        ".agents/**",
        ".claude/**",
        ".dev-kit/**",
        ".opencode/**",
        ".repos/**",
        ".vite-hooks/_/**",
      ],
      printWidth: 100,
      semi: true,
      singleQuote: false,
      sortImports: true,
      sortPackageJson: true,
      trailingComma: "all",
    });
  });

  it("keeps the JavaScript runtime export aligned with the typed source", () => {
    expect(packagedOxfmtConfig).toEqual(sourceOxfmtConfig);
  });
});
