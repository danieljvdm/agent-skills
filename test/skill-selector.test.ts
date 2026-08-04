import { assert, describe, it } from "@effect/vitest";

import { isSkillName, parseSkillSelector } from "../src/skill-selector.ts";

describe("skill selectors", () => {
  it("parses canonical static and exact package selectors", () => {
    assert.deepEqual(parseSkillSelector("effect-ts"), { type: "static", name: "effect-ts" });
    assert.deepEqual(parseSkillSelector("tanstack#router"), {
      type: "package",
      package: "tanstack",
      skill: "router",
    });
    assert.deepEqual(parseSkillSelector("@tanstack/react-start#tanstack-router"), {
      type: "package",
      package: "@tanstack/react-start",
      skill: "tanstack-router",
    });
  });

  it("accepts only immediate lowercase-hyphen skill names", () => {
    for (const name of ["a", "ai-core", "versioned-skill"]) {
      assert.isTrue(isSkillName(name));
    }
    for (const name of ["", "AI-core", "ai_core", "ai/core", "ai--core", "-ai", "ai-"]) {
      assert.isFalse(isSkillName(name));
    }
  });

  it("rejects incomplete, ambiguous, and unsafe selectors", () => {
    for (const selector of [
      "@tanstack/react-start",
      "@tanstack/react-start#",
      "#router",
      "@tanstack/react-start#router/nested",
      "@tanstack/react-start#..",
      "@tanstack/react-start#router#nested",
      "@tanstack/react-start#router/../nested",
      "@tanstack//react-start#router",
      "@Tanstack/react-start#router",
      "@tanstack/react-start#Router",
      "@tanstack/react-start#router_skill",
      "tanstack#*",
      "tanstack#router ",
    ]) {
      assert.strictEqual(parseSkillSelector(selector), undefined, selector);
    }
  });
});
