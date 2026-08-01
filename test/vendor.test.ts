import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  runCommandSuccess,
  runDevKit,
} from "./test-platform.ts";

const writeSkill = Effect.fn("writeVendorTestSkill")(function* (
  root: string,
  name: string,
  body: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(root, "skills", name);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill ${name}.\ndisable-model-invocation: true\n---\n\n${body}\n`,
  );
});

const commitAll = Effect.fn("commitVendorTestRepository")(function* (
  repository: string,
  message: string,
) {
  yield* runCommandSuccess(repository, "git", ["add", "."]);
  yield* runCommandSuccess(repository, "git", ["commit", "-m", message]);
});

const writeSourceManifest = Effect.fn("writeVendorTestManifest")(function* (
  aggregate: string,
  upstream: string,
  include: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(
    path.join(aggregate, "skill-sources.jsonc"),
    `${JSON.stringify(
      {
        sources: [
          {
            id: "fixture-skills",
            repository: upstream,
            ref: "main",
            skillsPath: "skills",
            include,
            licensePath: "LICENSE",
            stripFrontmatter: ["disable-model-invocation"],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
});

const createFixture = Effect.fn("createVendorTestFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "dev-kit-vendor-test-",
  });
  const upstream = path.join(root, "upstream");
  const aggregate = path.join(root, "aggregate");
  yield* fs.makeDirectory(upstream);
  yield* fs.makeDirectory(aggregate);
  yield* runCommandSuccess(upstream, "git", ["init", "-b", "main"]);
  yield* runCommandSuccess(upstream, "git", [
    "config",
    "user.name",
    "Dev Kit Test",
  ]);
  yield* runCommandSuccess(upstream, "git", [
    "config",
    "user.email",
    "dev-kit@example.test",
  ]);
  yield* writeSkill(upstream, "one", "version one");
  yield* writeSkill(upstream, "two", "second skill");
  yield* fs.writeFileString(path.join(upstream, "LICENSE"), "test license\n");
  yield* commitAll(upstream, "initial");
  yield* writeSourceManifest(aggregate, upstream, ["one"]);

  return { aggregate, root, upstream };
});

describe("external skill vendoring", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("vendors, transforms, locks, and updates a local git source", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* createFixture();

        const firstRun = yield* runDevKit(fixture.aggregate, [
          "vendor",
          "--repo-dir",
          fixture.aggregate,
        ]);
        assert.strictEqual(firstRun.exitCode, 0, firstRun.output);
        const firstSkill = yield* fs.readFileString(
          path.join(fixture.aggregate, "skills", "one", "SKILL.md"),
        );
        assert.match(firstSkill, /version one/);
        assert.notMatch(firstSkill, /disable-model-invocation/);
        assert.strictEqual(
          yield* fs.readFileString(
            path.join(
              fixture.aggregate,
              "third-party",
              "fixture-skills",
              "LICENSE",
            ),
          ),
          "test license\n",
        );

        const firstLockPath = path.join(
          fixture.aggregate,
          "skill-sources.lock.json",
        );
        const firstLockText = yield* fs.readFileString(firstLockPath);
        const firstLock = JSON.parse(firstLockText);
        assert.deepEqual(firstLock.sources[0].skills, ["one"]);
        assert.deepEqual(firstLock.sources[0].include, ["one"]);
        assert.strictEqual(
          firstLock.sources[0].resolved,
          (yield* runCommandSuccess(fixture.upstream, "git", [
            "rev-parse",
            "HEAD",
          ])).trim(),
        );

        yield* writeSkill(fixture.upstream, "one", "version two");
        yield* commitAll(fixture.upstream, "update");
        const lockedRun = yield* runDevKit(fixture.aggregate, [
          "vendor",
          "--locked",
          "--repo-dir",
          fixture.aggregate,
        ]);
        assert.strictEqual(lockedRun.exitCode, 0, lockedRun.output);
        assert.match(
          yield* fs.readFileString(
            path.join(fixture.aggregate, "skills", "one", "SKILL.md"),
          ),
          /version one/,
        );

        yield* writeSourceManifest(fixture.aggregate, fixture.upstream, ["two"]);
        const failedLockedRun = yield* runDevKit(fixture.aggregate, [
          "vendor",
          "--locked",
          "--repo-dir",
          fixture.aggregate,
        ]);
        assert.notStrictEqual(failedLockedRun.exitCode, 0);
        assert.strictEqual(yield* fs.readFileString(firstLockPath), firstLockText);
        assert.match(
          yield* fs.readFileString(
            path.join(fixture.aggregate, "skills", "one", "SKILL.md"),
          ),
          /version one/,
        );

        yield* writeSourceManifest(fixture.aggregate, fixture.upstream, ["one"]);
        const updatedRun = yield* runDevKit(fixture.aggregate, [
          "vendor",
          "--repo-dir",
          fixture.aggregate,
        ]);
        assert.strictEqual(updatedRun.exitCode, 0, updatedRun.output);
        assert.match(
          yield* fs.readFileString(
            path.join(fixture.aggregate, "skills", "one", "SKILL.md"),
          ),
          /version two/,
        );
      }));

    it.effect("rejects symlinks in vendored skill paths", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-vendor-symlink-test-",
        });
        const upstream = path.join(root, "upstream");
        const aggregate = path.join(root, "aggregate");
        const outside = path.join(root, "outside");
        yield* fs.makeDirectory(path.join(upstream, "skills"), { recursive: true });
        yield* fs.makeDirectory(aggregate);
        yield* fs.makeDirectory(outside);
        yield* fs.writeFileString(
          path.join(outside, "SKILL.md"),
          "---\nname: escaped\ndescription: Escaped test skill.\n---\n",
        );
        yield* fs.symlink(outside, path.join(upstream, "skills", "escaped"));
        yield* runCommandSuccess(upstream, "git", ["init", "-b", "main"]);
        yield* runCommandSuccess(upstream, "git", [
          "config",
          "user.name",
          "Dev Kit Test",
        ]);
        yield* runCommandSuccess(upstream, "git", [
          "config",
          "user.email",
          "dev-kit@example.test",
        ]);
        yield* commitAll(upstream, "symlink");
        yield* fs.writeFileString(
          path.join(aggregate, "skill-sources.jsonc"),
          `${JSON.stringify({
            sources: [
              {
                id: "unsafe-skills",
                repository: upstream,
                ref: "main",
                skillsPath: "skills",
                include: ["*"],
              },
            ],
          })}\n`,
        );

        const result = yield* runDevKit(aggregate, [
          "vendor",
          "--repo-dir",
          aggregate,
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.include(yield* fs.readFileString(path.join(outside, "SKILL.md")), "Escaped");
      }));

    it.effect("rejects unsafe paths from a tampered lock before deleting files", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* createFixture();
        const firstRun = yield* runDevKit(fixture.aggregate, [
          "vendor",
          "--repo-dir",
          fixture.aggregate,
        ]);
        assert.strictEqual(firstRun.exitCode, 0, firstRun.output);
        const protectedFile = path.join(fixture.aggregate, "README.md");
        yield* fs.writeFileString(protectedFile, "keep me\n");
        const lockPath = path.join(fixture.aggregate, "skill-sources.lock.json");
        const lock = JSON.parse(yield* fs.readFileString(lockPath));
        lock.sources[0].skills = ["../README.md"];
        yield* fs.writeFileString(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

        const result = yield* runDevKit(fixture.aggregate, [
          "vendor",
          "--repo-dir",
          fixture.aggregate,
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.strictEqual(yield* fs.readFileString(protectedFile), "keep me\n");
      }));
  });
});
