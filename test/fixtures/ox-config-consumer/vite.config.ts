import { createRecommendedVitePlusConfig } from "@danieljvdm/dev-kit/vite-plus";
import { defineConfig } from "vite-plus";

const recommended = createRecommendedVitePlusConfig();

export default defineConfig({
  ...recommended,
  lint: {
    ...recommended.lint,
    rules: {
      ...recommended.lint?.rules,
      "effect/no-effect-run": "error",
    },
  },
});
