import { recommendedOxlintConfig } from "@danieljvdm/dev-kit/oxlint";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [recommendedOxlintConfig],
  rules: {
    "effect/no-effect-run": "error",
  },
});
