import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  EFFECT_TSGO_TYPESCRIPT_VERSION,
  EFFECT_TSGO_VERSION,
} from "../src/effect-tsgo.ts";
import { repositoryRoot, runDevKit } from "./test-platform.ts";

type ManifestOptions = {
  readonly agentsEnabled?: boolean;
  readonly claudeEnabled?: boolean;
  readonly effectTsgoEnabled?: boolean;
};

const writeManifest = Effect.fn("writeSyncTestManifest")(function* (
  projectDir: string,
  options: ManifestOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(
    path.join(projectDir, "dev-kit.jsonc"),
    `${JSON.stringify(
      {
        include: ["effect"],
        ...(options.effectTsgoEnabled
          ? { setup: { effectTsgo: { enabled: true } } }
          : {}),
        targets: {
          agents: { enabled: options.agentsEnabled ?? true, mode: "copy" },
          claude: { enabled: options.claudeEnabled ?? false, mode: "symlink" },
        },
      },
      null,
      2,
    )}\n`,
  );
});

const createProject = Effect.fn("createSyncTestProject")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const projectDir = yield* fs.makeTempDirectoryScoped({
    prefix: "dev-kit-sync-test-",
  });
  yield* writeManifest(projectDir);
  return projectDir;
});

const writePackageVersion = Effect.fn("writeSyncTestPackageVersion")(function* (
  projectDir: string,
  packageName: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageDir = path.join(
    projectDir,
    "node_modules",
    ...packageName.split("/"),
  );
  yield* fs.makeDirectory(packageDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ version })}\n`,
  );
});

const installFakeEffectTsgo = Effect.fn("installFakeEffectTsgo")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* writePackageVersion(projectDir, "@effect/tsgo", EFFECT_TSGO_VERSION);
  yield* writePackageVersion(
    projectDir,
    "typescript",
    EFFECT_TSGO_TYPESCRIPT_VERSION,
  );

  const platformLib = path.join(
    projectDir,
    "node_modules",
    "@typescript",
    "typescript-test",
    "lib",
  );
  const effectPlatformLib = path.join(
    projectDir,
    "node_modules",
    "@effect",
    "tsgo-test",
    "lib",
  );
  yield* fs.makeDirectory(platformLib, { recursive: true });
  yield* fs.makeDirectory(effectPlatformLib, { recursive: true });
  yield* fs.writeFileString(path.join(platformLib, "tsc"), "original\n");
  yield* fs.writeFileString(path.join(effectPlatformLib, "tsc"), "patched\n");

  const executable = path.join(projectDir, "node_modules", ".bin", "effect-tsgo");
  yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
  yield* fs.writeFileString(
    executable,
    `#!/bin/sh
set -eu
marker="$PWD/tsgo-patch-count.txt"
count=0
if [ -f "$marker" ]; then count="$(tr -d '\\n' < "$marker")"; fi
printf '%s' "$((count + 1))" > "$marker"
cp "$PWD/node_modules/@typescript/typescript-test/lib/tsc" "$PWD/node_modules/@typescript/typescript-test/lib/tsc.original"
cp "$PWD/node_modules/@effect/tsgo-test/lib/tsc" "$PWD/node_modules/@typescript/typescript-test/lib/tsc"
printf 'Verification succeeded.\\n'
`,
    { mode: 0o755 },
  );
});

describe("project apply", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("plans creates without writing project state", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        const result = yield* runDevKit(projectDir, [
          "plan",
          "--project-dir",
          projectDir,
        ]);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.match(result.output, /create copy effect-ts -> \.agents\/skills\/effect-ts/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".agents")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".dev-kit")));
      }));

    it.effect("creates locked owned skills and converges without rewriting metadata", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        const first = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        assert.strictEqual(first.exitCode, 0, first.output);
        assert.match(first.output, /create copy effect-ts/);
        assert.isTrue(
          yield* fs.exists(
            path.join(projectDir, ".agents", "skills", "effect-ts", "SKILL.md"),
          ),
        );

        const lockPath = path.join(projectDir, "dev-kit.lock.json");
        const statePath = path.join(projectDir, ".dev-kit", "state.json");
        const firstLock = yield* fs.readFileString(lockPath);
        const firstState = yield* fs.readFileString(statePath);
        const lock = JSON.parse(firstLock);
        assert.strictEqual(lock.outputs[0].resourceId, "skill:effect-ts@agents");
        assert.strictEqual(lock.outputs[0].path, ".agents/skills/effect-ts");

        const second = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        assert.strictEqual(second.exitCode, 0, second.output);
        assert.match(second.output, /unchanged copy effect-ts/);
        assert.strictEqual(yield* fs.readFileString(lockPath), firstLock);
        assert.strictEqual(yield* fs.readFileString(statePath), firstState);
      }));

    it.effect("runs the manifest-driven Effect tsgo setup task exactly once", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        yield* installFakeEffectTsgo(projectDir);
        yield* writeManifest(projectDir, { effectTsgoEnabled: true });
        const marker = path.join(projectDir, "tsgo-patch-count.txt");

        const planned = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);
        assert.strictEqual(planned.exitCode, 0, planned.output);
        assert.match(planned.output, /setup effect-tsgo@0\.24\.3 -> typescript@7\.0\.2/);
        assert.isFalse(yield* fs.exists(marker));

        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        assert.strictEqual(applied.exitCode, 0, applied.output);
        assert.strictEqual(yield* fs.readFileString(marker), "1");

        const lockPath = path.join(projectDir, "dev-kit.lock.json");
        const lock = JSON.parse(yield* fs.readFileString(lockPath));
        assert.deepEqual(lock.setup.effectTsgo, {
          effectTsgoVersion: EFFECT_TSGO_VERSION,
          typescriptPackage: "typescript",
          typescriptVersion: EFFECT_TSGO_TYPESCRIPT_VERSION,
        });

        const postinstall = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);
        assert.strictEqual(postinstall.exitCode, 0, postinstall.output);
        assert.match(postinstall.output, /unchanged effect-tsgo@0\.24\.3/);
        assert.strictEqual(yield* fs.readFileString(marker), "1");

        lock.setup.effectTsgo.effectTsgoVersion = "0.0.0";
        yield* fs.writeFileString(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
        const mismatched = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);
        assert.notStrictEqual(mismatched.exitCode, 0);
        assert.match(mismatched.output, /manifest or packaged skills differ/);
      }));

    it.effect("preserves and reports an unknown destination", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const destination = path.join(projectDir, ".agents", "skills", "effect-ts");
        yield* fs.makeDirectory(destination, { recursive: true });
        yield* fs.writeFileString(path.join(destination, "keep.txt"), "user content\n");

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /conflict \.agents\/skills\/effect-ts/);
        assert.strictEqual(
          yield* fs.readFileString(path.join(destination, "keep.txt")),
          "user content\n",
        );
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
      }));

    it.effect("cleans only an unchanged owned skill when its target is disabled", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        const unrelated = path.join(projectDir, ".agents", "skills", "local-skill");
        yield* fs.makeDirectory(unrelated, { recursive: true });
        yield* fs.writeFileString(path.join(unrelated, "SKILL.md"), "local\n");
        yield* writeManifest(projectDir, { agentsEnabled: false });

        const planned = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);
        assert.strictEqual(planned.exitCode, 0, planned.output);
        assert.match(planned.output, /remove skill:effect-ts@agents/);
        assert.isTrue(
          yield* fs.exists(path.join(projectDir, ".agents", "skills", "effect-ts")),
        );

        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        assert.strictEqual(applied.exitCode, 0, applied.output);
        assert.isFalse(
          yield* fs.exists(path.join(projectDir, ".agents", "skills", "effect-ts")),
        );
        assert.strictEqual(yield* fs.readFileString(path.join(unrelated, "SKILL.md")), "local\n");
        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(path.join(projectDir, "dev-kit.lock.json"))).outputs,
          [],
        );
      }));

    it.effect("preserves modified stale owned skills as conflicts", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        const skillDocument = path.join(
          projectDir,
          ".agents",
          "skills",
          "effect-ts",
          "SKILL.md",
        );
        yield* fs.writeFileString(
          skillDocument,
          `${yield* fs.readFileString(skillDocument)}\nlocal edit\n`,
        );
        yield* writeManifest(projectDir, { agentsEnabled: false });

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /stale owned destination was modified/);
        assert.match(yield* fs.readFileString(skillDocument), /local edit/);
        assert.lengthOf(
          JSON.parse(yield* fs.readFileString(path.join(projectDir, "dev-kit.lock.json"))).outputs,
          1,
        );
      }));

    it.effect("adopts an exact locked output when local state is absent", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        yield* fs.remove(path.join(projectDir, ".dev-kit"), {
          force: true,
          recursive: true,
        });

        const result = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.match(result.output, /unchanged copy effect-ts.*\(adopt\)/);
        assert.isTrue(yield* fs.exists(path.join(projectDir, ".dev-kit", "state.json")));
      }));

    it.effect("retains relative-link semantics for symlink targets", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        yield* writeManifest(projectDir, { claudeEnabled: true });

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        assert.strictEqual(result.exitCode, 0, result.output);
        const link = path.join(projectDir, ".claude", "skills", "effect-ts");
        assert.strictEqual(
          yield* fs.readLink(link),
          path.relative(
            path.dirname(link),
            path.join(projectDir, ".agents", "skills", "effect-ts"),
          ),
        );
      }));

    it.effect("rejects manifest drift in locked mode without cleanup", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        yield* writeManifest(projectDir, { agentsEnabled: false });

        const result = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /manifest or packaged skills differ/);
        assert.isTrue(
          yield* fs.exists(path.join(projectDir, ".agents", "skills", "effect-ts")),
        );
        assert.lengthOf(
          JSON.parse(yield* fs.readFileString(path.join(projectDir, "dev-kit.lock.json"))).outputs,
          1,
        );
      }));

    it.effect("migrates local ownership state from a previously applied lock", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const nextProjectDir = yield* createProject();
        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        yield* writeManifest(projectDir, { agentsEnabled: false });
        yield* writeManifest(nextProjectDir, { agentsEnabled: false });
        assert.strictEqual(
          (yield* runDevKit(nextProjectDir, [
            "apply",
            "--project-dir",
            nextProjectDir,
          ])).exitCode,
          0,
        );
        yield* fs.copyFile(
          path.join(nextProjectDir, "dev-kit.lock.json"),
          path.join(projectDir, "dev-kit.lock.json"),
        );

        const result = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.match(result.output, /remove skill:effect-ts@agents/);
        assert.isFalse(
          yield* fs.exists(path.join(projectDir, ".agents", "skills", "effect-ts")),
        );
        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(path.join(projectDir, ".dev-kit", "state.json"))).outputs,
          [],
        );
      }));

    it.effect("rejects lockfile paths overlapping metadata or managed outputs", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        for (const lockfile of [
          ".dev-kit/state.json",
          ".agents/skills/effect-ts/dev-kit.lock.json",
        ]) {
          const projectDir = yield* createProject();
          const result = yield* runDevKit(projectDir, [
            "apply",
            "--lockfile",
            lockfile,
            "--project-dir",
            projectDir,
          ]);
          assert.notStrictEqual(result.exitCode, 0);
          assert.match(result.output, /overlaps/);
          assert.isFalse(yield* fs.exists(path.join(projectDir, ".agents")));
        }
      }));

    it.effect("does not adopt a pre-existing exact tree without a lock", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const root = yield* repositoryRoot();
        const destination = path.join(projectDir, ".agents", "skills", "effect-ts");
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fs.copy(path.join(root, "skills", "effect-ts"), destination);

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /destination exists but is not owned/);
      }));

    it.effect("refuses to mutate while another apply lock exists", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const processLock = path.join(projectDir, ".dev-kit", "apply.lock");
        yield* fs.makeDirectory(processLock, { recursive: true });
        yield* fs.writeFileString(path.join(processLock, "owner.json"), '{"token":"other"}\n');

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /another dev-kit apply may be active/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".agents")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
        assert.strictEqual(
          yield* fs.readFileString(path.join(processLock, "owner.json")),
          '{"token":"other"}\n',
        );
      }));

    it.effect("rolls back installed outputs after a late apply failure", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const blockedParent = path.join(projectDir, "blocked");
        yield* fs.writeFileString(blockedParent, "not a directory\n");

        const result = yield* runDevKit(projectDir, [
          "apply",
          "--lockfile",
          "blocked/dev-kit.lock.json",
          "--project-dir",
          projectDir,
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.isFalse(
          yield* fs.exists(path.join(projectDir, ".agents", "skills", "effect-ts")),
        );
        assert.strictEqual(yield* fs.readFileString(blockedParent), "not a directory\n");
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".dev-kit", "state.json")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".dev-kit", "apply.lock")));
      }));

    it.effect("rejects symlink ancestors without touching their targets", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const externalDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-external-test-",
        });
        yield* fs.writeFileString(path.join(externalDir, "keep.txt"), "external content\n");
        yield* fs.symlink(externalDir, path.join(projectDir, ".agents"));

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /ancestor is a symlink/);
        assert.strictEqual(
          yield* fs.readFileString(path.join(externalDir, "keep.txt")),
          "external content\n",
        );
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
      }));
  });
});
