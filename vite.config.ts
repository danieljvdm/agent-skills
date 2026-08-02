import { recommendedOxlintConfig } from "@danieljvdm/dev-kit/oxlint";
import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    extends: [recommendedOxlintConfig],
    ignorePatterns: [".agents/**", ".dev-kit/**", ".repos/**"],
  },
});
