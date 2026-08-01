import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  EFFECT_TSGO_TYPESCRIPT_VERSION,
  EFFECT_TSGO_VERSION,
  planEffectTsgoPatch,
} from "../src/effect-tsgo.ts";

const writePackageVersion = Effect.fn("writeTestPackageVersion")(function* (
  projectDir: string,
  packageName: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(
    projectDir,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  yield* fs.makeDirectory(path.dirname(manifestPath), { recursive: true });
  yield* fs.writeFileString(manifestPath, `${JSON.stringify({ version })}\n`);
});

describe("Effect tsgo patch", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("plans only the exact pinned local toolchain", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-tsgo-test-",
        });
        yield* writePackageVersion(projectDir, "@effect/tsgo", EFFECT_TSGO_VERSION);
        yield* writePackageVersion(
          projectDir,
          "typescript",
          EFFECT_TSGO_TYPESCRIPT_VERSION,
        );
        const executable = path.join(projectDir, "node_modules", ".bin", "effect-tsgo");
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(executable, "fixture\n");

        const plan = yield* planEffectTsgoPatch({ dryRun: true, projectDir });

        assert.strictEqual(
          plan.executable,
          path.join(yield* fs.realPath(projectDir), "node_modules", ".bin", "effect-tsgo"),
        );
        assert.deepEqual(plan.args, ["patch"]);
        assert.strictEqual(plan.effectTsgoVersion, EFFECT_TSGO_VERSION);
        assert.strictEqual(plan.typescriptVersion, EFFECT_TSGO_TYPESCRIPT_VERSION);
      }));

    it.effect("rejects drift from the toolkit pin", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-tsgo-test-",
        });
        yield* writePackageVersion(projectDir, "@effect/tsgo", "0.24.2");
        yield* writePackageVersion(
          projectDir,
          "typescript",
          EFFECT_TSGO_TYPESCRIPT_VERSION,
        );
        const executable = path.join(projectDir, "node_modules", ".bin", "effect-tsgo");
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(executable, "fixture\n");

        const error = yield* Effect.flip(planEffectTsgoPatch({ projectDir }));

        assert.strictEqual(error._tag, "EffectTsgoDependencyError");
        if (error._tag === "EffectTsgoDependencyError") {
          assert.strictEqual(error.packageName, "@effect/tsgo");
          assert.strictEqual(error.actualVersion, "0.24.2");
        }
      }));

    it.effect("passes explicit force and TypeScript package options through", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-tsgo-test-",
        });
        yield* writePackageVersion(projectDir, "@effect/tsgo", EFFECT_TSGO_VERSION);
        yield* writePackageVersion(
          projectDir,
          "@typescript/native",
          EFFECT_TSGO_TYPESCRIPT_VERSION,
        );
        const executable = path.join(projectDir, "node_modules", ".bin", "effect-tsgo");
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(executable, "fixture\n");

        const plan = yield* planEffectTsgoPatch({
          force: true,
          projectDir,
          typescriptPackage: "@typescript/native",
        });

        assert.deepEqual(plan.args, [
          "patch",
          "--force",
          "--typescript-package",
          "@typescript/native",
        ]);
      }));

    it.effect("rejects package names that can escape node_modules", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-tsgo-test-",
        });

        for (const packageName of [
          "../typescript",
          "@scope/../../typescript",
          "@scope/name/extra",
          "/typescript",
          "typescript\\..\\escape",
          "@scope/",
          "@scope",
          "",
        ]) {
          const error = yield* Effect.flip(
            planEffectTsgoPatch({ projectDir, typescriptPackage: packageName }),
          );
          assert.strictEqual(error._tag, "InvalidEffectTsgoPackageNameError");
          if (error._tag === "InvalidEffectTsgoPackageNameError") {
            assert.strictEqual(error.packageName, packageName);
          }
        }
      }));
  });
});
