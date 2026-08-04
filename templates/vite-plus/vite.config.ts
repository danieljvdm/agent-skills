import { recommendedOxfmtConfig } from "@danieljvdm/dev-kit/oxfmt";
import { recommendedOxlintConfig } from "@danieljvdm/dev-kit/oxlint";
import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ...recommendedOxfmtConfig,
  },
  lint: {
    extends: [recommendedOxlintConfig],
    ignorePatterns: [".agents/**", ".dev-kit/**", ".repos/**"],
  },
  run: {
    tasks: {
      check: ["vp fmt --check", "vp lint", "vp test", "vp run typecheck"],
      typecheck: "tsc --noEmit",
    },
  },
});
