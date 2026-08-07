import { recommendedOxlintConfig as packagedOxlintConfig } from "@danieljvdm/dev-kit/oxlint";
import { describe, expect, it } from "vitest";

import { recommendedOxlintConfig as sourceOxlintConfig } from "../src/oxlint.ts";

const recommendedOxlintConfig = packagedOxlintConfig;

describe("recommended Oxlint config", () => {
  it("enables the Vite+ plugins and type-aware rules", () => {
    expect(recommendedOxlintConfig.ignorePatterns).toEqual([
      ".agents/**",
      ".claude/**",
      ".dev-kit/**",
      ".opencode/**",
      ".repos/**",
      ".vite-hooks/_/**",
    ]);
    expect(recommendedOxlintConfig.options).toEqual({ typeAware: true });
    expect(recommendedOxlintConfig.jsPlugins).toEqual([
      {
        name: "effect",
        specifier: "@danieljvdm/dev-kit/oxlint-plugin-effect",
      },
      {
        name: "stylistic",
        specifier: "@danieljvdm/dev-kit/oxlint-plugin-style",
      },
    ]);
    expect(recommendedOxlintConfig.plugins).toEqual(["import", "react", "vitest"]);
    expect(recommendedOxlintConfig.rules["import/no-duplicates"]).toEqual([
      "error",
      { preferInline: true },
    ]);
    expect(recommendedOxlintConfig.rules["effect/prefer-schema-alias"]).toBe("error");
    expect(recommendedOxlintConfig.rules["react/rules-of-hooks"]).toBe("error");
    expect(recommendedOxlintConfig.rules["stylistic/padding-line-between-statements"]).toEqual([
      "error",
      { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
      {
        blankLine: "any",
        prev: ["const", "let", "var"],
        next: ["const", "let", "var"],
      },
      { blankLine: "always", prev: "*", next: "return" },
    ]);
    expect(recommendedOxlintConfig.rules["typescript/switch-exhaustiveness-check"]).toBe("error");
    expect(recommendedOxlintConfig.rules["typescript/consistent-type-imports"]).toEqual([
      "error",
      { fixStyle: "inline-type-imports", prefer: "type-imports" },
    ]);
    expect(recommendedOxlintConfig.rules["typescript/no-floating-promises"]).toBe("off");
    expect(recommendedOxlintConfig.rules["vitest/no-standalone-expect"]).toBe("off");
    expect(recommendedOxlintConfig.overrides[0]?.rules["typescript/no-non-null-assertion"]).toBe(
      "off",
    );
  });

  it("keeps the JavaScript runtime export aligned with the typed source", () => {
    expect(packagedOxlintConfig).toEqual(sourceOxlintConfig);
  });
});
