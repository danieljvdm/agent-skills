import { describe, expect, it } from "vitest";

import { recommendedOxlintConfig } from "@danieljvdm/dev-kit/oxlint";

describe("recommended Oxlint config", () => {
  it("enables the Vite+ plugins and type-aware rules", () => {
    expect(recommendedOxlintConfig.options).toEqual({ typeAware: true });
    expect(recommendedOxlintConfig.plugins).toEqual(["import", "react", "vitest"]);
    expect(recommendedOxlintConfig.rules["react/rules-of-hooks"]).toBe("error");
    expect(recommendedOxlintConfig.rules["typescript/switch-exhaustiveness-check"]).toBe("error");
    expect(recommendedOxlintConfig.rules["vitest/no-standalone-expect"]).toBe("off");
  });
});
