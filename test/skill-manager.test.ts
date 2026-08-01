import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runDevKit } from "./test-platform.ts";

describe("skill management UX", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("initializes, adds, lists, and removes skills with direct commands", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-manager-" });

        const initialized = yield* runDevKit(projectDir, ["init", "--project-dir", projectDir]);
        assert.strictEqual(initialized.exitCode, 0, initialized.output);
        assert.match(initialized.output, /Created dev-kit\.jsonc/);

        const added = yield* runDevKit(projectDir, [
          "add", "dev-kit", "--no-apply", "--project-dir", projectDir,
        ]);
        assert.strictEqual(added.exitCode, 0, added.output);
        assert.match(added.output, /Manifest updated/);
        assert.include(
          yield* fs.readFileString(path.join(projectDir, "dev-kit.jsonc")),
          '"dev-kit"',
        );

        const listed = yield* runDevKit(projectDir, ["list", "--project-dir", projectDir]);
        assert.strictEqual(listed.exitCode, 0, listed.output);
        assert.match(listed.output, /✓ dev-kit/);

        const removed = yield* runDevKit(projectDir, [
          "remove", "dev-kit", "--no-apply", "--project-dir", projectDir,
        ]);
        assert.strictEqual(removed.exitCode, 0, removed.output);
        assert.notInclude(
          yield* fs.readFileString(path.join(projectDir, "dev-kit.jsonc")),
          '"dev-kit"',
        );
      }));

    it.effect("removes a skill selected through a family by adding an exclusion", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-family-" });
        yield* fs.writeFileString(
          path.join(projectDir, "dev-kit.jsonc"),
          '{\n  "include": [\n    // Keep this family note.\n    "effect"\n  ]\n}\n',
        );

        const removed = yield* runDevKit(projectDir, [
          "remove", "effect-ts", "--no-apply", "--project-dir", projectDir,
        ]);
        assert.strictEqual(removed.exitCode, 0, removed.output);
        const manifest = yield* fs.readFileString(path.join(projectDir, "dev-kit.jsonc"));
        assert.include(manifest, "// Keep this family note.");
        assert.include(manifest, '"exclude": [');
        assert.include(manifest, '"effect-ts"');
      }));

    it.effect("searches descriptions and reports approved provenance", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-search-" });
        const searched = yield* runDevKit(projectDir, ["search", "motion", "--project-dir", projectDir]);
        assert.strictEqual(searched.exitCode, 0, searched.output);
        assert.match(searched.output, /animation-vocabulary/);
        const info = yield* runDevKit(projectDir, ["info", "prototype"]);
        assert.strictEqual(info.exitCode, 0, info.output);
        assert.match(info.output, /Approved commit: [0-9a-f]{40}/);
      }));
  });
});
