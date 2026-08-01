import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/effect-tsgo.test.ts",
      "test/gitignore.test.ts",
      "test/path-digest.test.ts",
      "test/project-process-lock.test.ts",
    ],
  },
});
