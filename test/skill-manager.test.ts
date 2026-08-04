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
          "add",
          "dev-kit",
          "--no-apply",
          "--project-dir",
          projectDir,
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
          "remove",
          "dev-kit",
          "--no-apply",
          "--project-dir",
          projectDir,
        ]);
        assert.strictEqual(removed.exitCode, 0, removed.output);
        assert.notInclude(
          yield* fs.readFileString(path.join(projectDir, "dev-kit.jsonc")),
          '"dev-kit"',
        );
      }),
    );

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
          "remove",
          "effect-ts",
          "--no-apply",
          "--project-dir",
          projectDir,
        ]);
        assert.strictEqual(removed.exitCode, 0, removed.output);
        const manifest = yield* fs.readFileString(path.join(projectDir, "dev-kit.jsonc"));
        assert.include(manifest, "// Keep this family note.");
        assert.include(manifest, '"exclude": [');
        assert.include(manifest, '"effect-ts"');
      }),
    );

    it.effect("searches descriptions and reports approved provenance", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-search-" });
        const searched = yield* runDevKit(projectDir, [
          "search",
          "motion",
          "--project-dir",
          projectDir,
        ]);
        assert.strictEqual(searched.exitCode, 0, searched.output);
        assert.match(searched.output, /animation-vocabulary \[emilkowalski-skills\]/);
        const sourceSearch = yield* runDevKit(projectDir, [
          "search",
          "emilkowalski-skills",
          "--project-dir",
          projectDir,
        ]);
        assert.strictEqual(sourceSearch.exitCode, 0, sourceSearch.output);
        assert.match(sourceSearch.output, /animation-vocabulary \[emilkowalski-skills\]/);
        const info = yield* runDevKit(projectDir, ["info", "prototype"]);
        assert.strictEqual(info.exitCode, 0, info.output);
        assert.match(info.output, /Approved commit: [0-9a-f]{40}/);
      }),
    );

    it.effect("warns when a source family selects every approved skill", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-source-family-" });

        const added = yield* runDevKit(projectDir, [
          "add",
          "emilkowalski-skills",
          "--no-apply",
          "--project-dir",
          projectDir,
        ]);

        assert.strictEqual(added.exitCode, 0, added.output);
        assert.match(added.output, /selects all \d+ approved skills/);
        assert.match(added.output, /Prefer individual skill names/);
        assert.include(
          yield* fs.readFileString(path.join(projectDir, "dev-kit.jsonc")),
          '"emilkowalski-skills"',
        );
      }),
    );

    it.effect("browses installed package skills without selecting or installing them", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-package-list-" });
        const packageRoot = path.join(projectDir, "node_modules", "@tanstack", "ai");
        yield* fs.makeDirectory(path.join(packageRoot, "skills", "ai-core"), { recursive: true });
        yield* fs.writeFileString(
          path.join(projectDir, "package.json"),
          '{"dependencies":{"@tanstack/ai":"1.2.3"}}\n',
        );
        yield* fs.writeFileString(
          path.join(packageRoot, "package.json"),
          '{"name":"@tanstack/ai","version":"1.2.3","intent":{"version":1,"repo":"https://github.com/TanStack/ai","docs":"https://tanstack.com/ai"}}\n',
        );
        yield* fs.writeFileString(
          path.join(packageRoot, "skills", "ai-core", "SKILL.md"),
          "---\nname: ai-core\ndescription: Build streaming AI chat.\n---\n",
        );

        const listed = yield* runDevKit(projectDir, ["list", "--all", "--project-dir", projectDir]);
        assert.strictEqual(listed.exitCode, 0, listed.output);
        assert.match(listed.output, /@tanstack\/ai#ai-core \[installed 1\.2\.3\]/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.jsonc")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".agents")));

        const searched = yield* runDevKit(projectDir, [
          "search",
          "streaming",
          "--project-dir",
          projectDir,
        ]);
        assert.strictEqual(searched.exitCode, 0, searched.output);
        assert.match(searched.output, /@tanstack\/ai#ai-core/);

        const info = yield* runDevKit(projectDir, [
          "info",
          "@tanstack/ai#ai-core",
          "--project-dir",
          projectDir,
        ]);
        assert.strictEqual(info.exitCode, 0, info.output);
        assert.match(info.output, /Source: installed package/);
        assert.match(info.output, /Version: 1\.2\.3/);

        const added = yield* runDevKit(projectDir, [
          "add",
          "@tanstack/ai#ai-core",
          "--no-apply",
          "--project-dir",
          projectDir,
        ]);
        assert.strictEqual(added.exitCode, 0, added.output);
        assert.include(
          yield* fs.readFileString(path.join(projectDir, "dev-kit.jsonc")),
          '"@tanstack/ai#ai-core"',
        );
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".agents")));

        yield* fs.remove(packageRoot, { recursive: true });
        const unavailable = yield* runDevKit(projectDir, ["list", "--project-dir", projectDir]);
        assert.strictEqual(unavailable.exitCode, 0, unavailable.output);
        assert.match(unavailable.output, /! @tanstack\/ai#ai-core \[unavailable\]/);

        const removed = yield* runDevKit(projectDir, [
          "remove",
          "@tanstack/ai#ai-core",
          "--no-apply",
          "--project-dir",
          projectDir,
        ]);
        assert.strictEqual(removed.exitCode, 0, removed.output);
        assert.notInclude(
          yield* fs.readFileString(path.join(projectDir, "dev-kit.jsonc")),
          '"@tanstack/ai#ai-core"',
        );
      }),
    );

    it.effect("keeps custom manifests inside the project and renders a relative schema path", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-nested-manifest-",
        });

        const initialized = yield* runDevKit(projectDir, [
          "init",
          "--manifest",
          "config/dev-kit.jsonc",
          "--project-dir",
          projectDir,
        ]);
        assert.strictEqual(initialized.exitCode, 0, initialized.output);
        assert.include(
          yield* fs.readFileString(path.join(projectDir, "config", "dev-kit.jsonc")),
          '"$schema": "../node_modules/@danieljvdm/dev-kit/schema/dev-kit.schema.json"',
        );

        for (const manifest of ["../outside.jsonc", path.join(projectDir, "absolute.jsonc")]) {
          const rejected = yield* runDevKit(projectDir, [
            "init",
            "--manifest",
            manifest,
            "--project-dir",
            projectDir,
          ]);
          assert.notStrictEqual(rejected.exitCode, 0);
          assert.match(rejected.output, /--manifest must/);
        }
      }),
    );

    it.effect("refuses symlinked manifest paths without touching their targets", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-symlink-manifest-",
        });
        const externalDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-external-manifest-",
        });
        const externalManifest = path.join(externalDir, "manifest.jsonc");
        yield* fs.writeFileString(externalManifest, "keep me\n");
        yield* fs.symlink(externalManifest, path.join(projectDir, "dev-kit.jsonc"));

        const rejected = yield* runDevKit(projectDir, ["init", "--project-dir", projectDir]);

        assert.notStrictEqual(rejected.exitCode, 0);
        assert.match(rejected.output, /manifest is a symlink/);
        assert.strictEqual(yield* fs.readFileString(externalManifest), "keep me\n");
      }),
    );
  });
});
