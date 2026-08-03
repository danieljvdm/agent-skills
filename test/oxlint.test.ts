import { describe, expect, it } from "vitest";

import { recommendedOxlintConfig as packagedOxlintConfig } from "@danieljvdm/dev-kit/oxlint";

import { recommendedOxlintConfig as sourceOxlintConfig } from "../src/oxlint.ts";

const recommendedOxlintConfig = packagedOxlintConfig;

describe("recommended Oxlint config", () => {
  it("enables the Vite+ plugins and type-aware rules", () => {
    expect(recommendedOxlintConfig.options).toEqual({ typeAware: true });
    expect(recommendedOxlintConfig.jsPlugins).toEqual([
      {
        name: "effect",
        specifier: "@danieljvdm/dev-kit/oxlint-plugin-effect",
      },
    ]);
    expect(recommendedOxlintConfig.plugins).toEqual(["import", "react", "vitest"]);
    expect(recommendedOxlintConfig.rules["react/rules-of-hooks"]).toBe("error");
    expect(recommendedOxlintConfig.rules["typescript/switch-exhaustiveness-check"]).toBe("error");
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
