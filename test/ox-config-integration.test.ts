import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Path } from "effect";

import { repositoryRoot, runCommand } from "./test-platform.ts";

describe("shared Oxlint and Oxfmt configuration", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("loads in standalone tools and Vite+", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* repositoryRoot();
        const fixture = path.join(root, "test", "fixtures", "ox-config-consumer");
        const oxlint = path.join(root, "node_modules", ".bin", "oxlint");
        const oxfmt = path.join(root, "node_modules", ".bin", "oxfmt");
        const vitePlus = path.join(root, "node_modules", ".bin", "vp");
        const standaloneEnv = { VP_VERSION: "" };

        const standaloneLint = yield* runCommand(
          fixture,
          oxlint,
          ["--config", "oxlint.config.mjs", "valid.ts"],
          standaloneEnv,
        );
        assert.strictEqual(standaloneLint.exitCode, 0, standaloneLint.output);

        const effectLint = yield* runCommand(
          fixture,
          oxlint,
          ["--config", "oxlint.config.mjs", "invalid.js"],
          standaloneEnv,
        );
        assert.notStrictEqual(effectLint.exitCode, 0);
        assert.include(effectLint.output, "effect(no-effect-run)");

        const standaloneFormat = yield* runCommand(
          fixture,
          oxfmt,
          ["--config", "oxfmt.config.mjs", "valid.ts", "--check"],
          standaloneEnv,
        );
        assert.strictEqual(standaloneFormat.exitCode, 0, standaloneFormat.output);

        const vitePlusLint = yield* runCommand(fixture, vitePlus, ["lint", "valid.ts"]);
        assert.strictEqual(vitePlusLint.exitCode, 0, vitePlusLint.output);

        const vitePlusFormat = yield* runCommand(fixture, vitePlus, ["fmt", "valid.ts", "--check"]);
        assert.strictEqual(vitePlusFormat.exitCode, 0, vitePlusFormat.output);
      }),
    );
  });
});
