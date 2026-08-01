import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runCommandSuccess, runDevKit } from "./test-platform.ts";

const commitAll = Effect.fn("commitEffectSourceFixture")(function* (
  repository: string,
  message: string,
) {
  yield* runCommandSuccess(repository, "git", ["add", "."]);
  yield* runCommandSuccess(repository, "git", ["commit", "-m", message]);
});

const createFixture = Effect.fn("createEffectSourceFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "dev-kit-effect-source-test-",
  });
  const upstream = path.join(root, "upstream");
  const project = path.join(root, "project");
  yield* fs.makeDirectory(upstream);
  yield* fs.makeDirectory(project);
  yield* runCommandSuccess(upstream, "git", ["init", "-b", "main"]);
  yield* runCommandSuccess(upstream, "git", ["config", "user.name", "Dev Kit Test"]);
  yield* runCommandSuccess(upstream, "git", [
    "config",
    "user.email",
    "dev-kit@example.test",
  ]);
  yield* fs.writeFileString(path.join(upstream, "source.txt"), "version one\n");
  yield* commitAll(upstream, "version one");
  yield* runCommandSuccess(upstream, "git", ["tag", "effect@1.2.3"]);
  yield* runCommandSuccess(project, "git", ["init", "-b", "main"]);
  yield* writeInstalledVersion(project, "1.2.3");
  return { project, root, upstream };
});

const writeInstalledVersion = Effect.fn("writeInstalledEffectVersion")(function* (
  project: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageDir = path.join(project, "node_modules", "effect");
  yield* fs.makeDirectory(packageDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ version })}\n`,
  );
});

const effectSyncArgs = (project: string, upstream: string) => [
  "effect",
  "sync",
  "--project-dir",
  project,
  "--repository",
  upstream,
] as const;

const writeManifest = Effect.fn("writeEffectSourceManifest")(function* (
  project: string,
  upstream: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(
    path.join(project, "dev-kit.jsonc"),
    `${JSON.stringify({
      include: ["effect"],
      setup: {
        effectSource: {
          enabled: true,
          repository: upstream,
        },
      },
      targets: { agents: { enabled: false } },
    }, null, 2)}\n`,
  );
});

describe("Effect source checkout", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("plans without cloning, then syncs and converges", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* createFixture();
        const checkout = path.join(fixture.project, ".repos", "effect");

        const planned = yield* runDevKit(fixture.project, [
          ...effectSyncArgs(fixture.project, fixture.upstream),
          "--dry-run",
        ]);
        assert.strictEqual(planned.exitCode, 0, planned.output);
        assert.match(planned.output, /Would sync Effect source effect@1\.2\.3 → \.repos\/effect/);
        assert.isFalse(yield* fs.exists(checkout));

        const applied = yield* runDevKit(
          fixture.project,
          effectSyncArgs(fixture.project, fixture.upstream),
        );
        assert.strictEqual(applied.exitCode, 0, applied.output);
        assert.match(applied.output, /✓ Effect source ready effect@1\.2\.3 → \.repos\/effect/);
        assert.notMatch(applied.output, /Cloning into|detached HEAD/);
        assert.strictEqual(yield* fs.readFileString(path.join(checkout, "source.txt")), "version one\n");
        assert.strictEqual(
          (yield* runCommandSuccess(checkout, "git", ["describe", "--tags", "--exact-match"])).trim(),
          "effect@1.2.3",
        );
        assert.strictEqual(
          (yield* runCommandSuccess(checkout, "git", ["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
          "HEAD",
        );

        const second = yield* runDevKit(
          fixture.project,
          effectSyncArgs(fixture.project, fixture.upstream),
        );
        assert.strictEqual(second.exitCode, 0, second.output);
        assert.match(second.output, /Effect source up to date effect@1\.2\.3/);
      }));

    it.effect("integrates with manifest locking and locked convergence", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* createFixture();
        yield* writeManifest(fixture.project, fixture.upstream);

        const planned = yield* runDevKit(fixture.project, [
          "plan",
          "--project-dir",
          fixture.project,
        ]);
        assert.strictEqual(planned.exitCode, 0, planned.output);
        assert.match(planned.output, /Effect source effect@1\.2\.3 → \.repos\/effect/);
        assert.isFalse(yield* fs.exists(path.join(fixture.project, ".repos", "effect")));

        const applied = yield* runDevKit(fixture.project, [
          "apply",
          "--project-dir",
          fixture.project,
        ]);
        assert.strictEqual(applied.exitCode, 0, applied.output);
        const lockPath = path.join(fixture.project, "dev-kit.lock.json");
        const firstLock = yield* fs.readFileString(lockPath);
        assert.deepEqual(JSON.parse(firstLock).setup.effectSource, {
          packageName: "effect",
          packageVersion: "1.2.3",
          path: ".repos/effect",
          repository: fixture.upstream,
          tag: "effect@1.2.3",
        });

        const locked = yield* runDevKit(fixture.project, [
          "apply",
          "--locked",
          "--project-dir",
          fixture.project,
        ]);
        assert.strictEqual(locked.exitCode, 0, locked.output);
        assert.match(locked.output, /Dev kit up to date/);
        assert.strictEqual(yield* fs.readFileString(lockPath), firstLock);
      }));

    it.effect("rejects locked version drift before updating, then advances unlocked", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* createFixture();
        yield* writeManifest(fixture.project, fixture.upstream);
        assert.strictEqual(
          (yield* runDevKit(fixture.project, [
            "apply",
            "--project-dir",
            fixture.project,
          ])).exitCode,
          0,
        );

        yield* fs.writeFileString(path.join(fixture.upstream, "source.txt"), "version two\n");
        yield* commitAll(fixture.upstream, "version two");
        yield* runCommandSuccess(fixture.upstream, "git", ["tag", "effect@2.0.0"]);
        yield* writeInstalledVersion(fixture.project, "2.0.0");
        const checkout = path.join(fixture.project, ".repos", "effect");

        const locked = yield* runDevKit(fixture.project, [
          "apply",
          "--locked",
          "--project-dir",
          fixture.project,
        ]);
        assert.notStrictEqual(locked.exitCode, 0);
        assert.match(locked.output, /manifest or packaged skills differ/);
        assert.strictEqual(yield* fs.readFileString(path.join(checkout, "source.txt")), "version one\n");

        const updated = yield* runDevKit(fixture.project, [
          "apply",
          "--project-dir",
          fixture.project,
        ]);
        assert.strictEqual(updated.exitCode, 0, updated.output);
        assert.strictEqual(yield* fs.readFileString(path.join(checkout, "source.txt")), "version two\n");
        assert.strictEqual(
          JSON.parse(yield* fs.readFileString(path.join(fixture.project, "dev-kit.lock.json")))
            .setup.effectSource.tag,
          "effect@2.0.0",
        );
      }));

    it.effect("refuses to switch a dirty checkout when the installed version moves", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* createFixture();
        const args = effectSyncArgs(fixture.project, fixture.upstream);
        assert.strictEqual((yield* runDevKit(fixture.project, args)).exitCode, 0);
        const checkout = path.join(fixture.project, ".repos", "effect");

        yield* fs.writeFileString(path.join(fixture.upstream, "source.txt"), "version two\n");
        yield* commitAll(fixture.upstream, "version two");
        yield* runCommandSuccess(fixture.upstream, "git", ["tag", "effect@2.0.0"]);
        yield* writeInstalledVersion(fixture.project, "2.0.0");
        yield* fs.writeFileString(path.join(checkout, "local.txt"), "keep me\n");

        const result = yield* runDevKit(fixture.project, args);
        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /local changes; refusing to switch/);
        assert.strictEqual(yield* fs.readFileString(path.join(checkout, "local.txt")), "keep me\n");
        assert.strictEqual(yield* fs.readFileString(path.join(checkout, "source.txt")), "version one\n");
      }));

    it.effect("skips source checkout setup in CI", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* createFixture();
        const result = yield* runDevKit(
          fixture.project,
          effectSyncArgs(fixture.project, fixture.upstream),
          { CI: "true" },
        );
        assert.strictEqual(result.exitCode, 0, result.output);
        assert.match(result.output, /Effect source skipped CI/);
        assert.isFalse(yield* fs.exists(path.join(fixture.project, ".repos", "effect")));
      }));

    it.effect("leaves no checkout behind when the version tag is missing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* createFixture();
        yield* writeInstalledVersion(fixture.project, "9.9.9");

        const result = yield* runDevKit(
          fixture.project,
          effectSyncArgs(fixture.project, fixture.upstream),
        );
        assert.notStrictEqual(result.exitCode, 0);
        assert.isFalse(yield* fs.exists(path.join(fixture.project, ".repos", "effect")));
      }));
  });
});
