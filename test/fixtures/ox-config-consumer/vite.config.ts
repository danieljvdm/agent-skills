import { recommendedOxfmtConfig } from "@danieljvdm/dev-kit/oxfmt";
import { recommendedOxlintConfig } from "@danieljvdm/dev-kit/oxlint";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ...recommendedOxfmtConfig,
  },
  lint: {
    extends: [recommendedOxlintConfig],
    rules: {
      "effect/no-effect-run": "error",
    },
  },
});
