import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runCommandSuccess, runDevKit } from "./test-platform.ts";

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
  yield* runCommandSuccess(upstream, "git", ["config", "user.name", "Dev Kit Test"]);
  yield* runCommandSuccess(upstream, "git", ["config", "user.email", "dev-kit@example.test"]);
  yield* writeSkill(upstream, "one", "version one");
  yield* writeSkill(upstream, "two", "second skill");
  yield* fs.writeFileString(path.join(upstream, "LICENSE"), "test license\n");
  yield* commitAll(upstream, "initial");
  yield* writeSourceManifest(aggregate, upstream, ["one"]);

  return { aggregate, root, upstream };
});

describe("approved skill catalog", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("adds, lists, and removes approved sources without hand-editing JSONC", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* createFixture();
        const sourcesPath = path.join(fixture.aggregate, "skill-sources.jsonc");

        yield* fs.writeFileString(sourcesPath, '{\n  // Approved upstreams.\n  "sources": []\n}\n');

        const added = yield* runDevKit(fixture.aggregate, [
          "catalog",
          "add",
          fixture.upstream,
          "--all",
          "--id",
          "fixture-skills",
          "--ref",
          "main",
          "--repo-dir",
          fixture.aggregate,
        ]);

        assert.strictEqual(added.exitCode, 0, added.output);
        const manifestText = yield* fs.readFileString(sourcesPath);

        assert.include(manifestText, "// Approved upstreams.");
        const manifest = JSON.parse(manifestText.replace("// Approved upstreams.", ""));

        assert.deepEqual(manifest.sources[0].include, ["one", "two"]);
        assert.notInclude(manifestText, '"*"');
        assert.isFalse(yield* fs.exists(path.join(fixture.aggregate, "skills", "one")));

        const listed = yield* runDevKit(fixture.aggregate, [
          "catalog",
          "list",
          "--repo-dir",
          fixture.aggregate,
        ]);

        assert.strictEqual(listed.exitCode, 0, listed.output);
        assert.match(listed.output, /fixture-skills[\s\S]*2 skills/);

        const beforeRemoval = yield* fs.readFileString(sourcesPath);
        const unconfirmed = yield* runDevKit(fixture.aggregate, [
          "catalog",
          "remove",
          "two",
          "--repo-dir",
          fixture.aggregate,
        ]);

        assert.notStrictEqual(unconfirmed.exitCode, 0);
        assert.match(unconfirmed.output, /requires --yes outside a terminal/);
        assert.strictEqual(yield* fs.readFileString(sourcesPath), beforeRemoval);

        const removedSkill = yield* runDevKit(fixture.aggregate, [
          "catalog",
          "remove",
          "two",
          "--yes",
          "--repo-dir",
          fixture.aggregate,
        ]);

        assert.strictEqual(removedSkill.exitCode, 0, removedSkill.output);
        const afterSkill = JSON.parse(
          (yield* fs.readFileString(sourcesPath)).replace("// Approved upstreams.", ""),
        );

        assert.deepEqual(afterSkill.sources[0].include, ["one"]);

        const removedSource = yield* runDevKit(fixture.aggregate, [
          "catalog",
          "remove",
          "fixture-skills",
          "--yes",
          "--repo-dir",
          fixture.aggregate,
        ]);

        assert.strictEqual(removedSource.exitCode, 0, removedSource.output);
        const afterSource = JSON.parse(
          (yield* fs.readFileString(sourcesPath)).replace("// Approved upstreams.", ""),
        );

        assert.deepEqual(afterSource.sources, []);
        const lock = JSON.parse(
          yield* fs.readFileString(path.join(fixture.aggregate, "skill-sources.lock.json")),
        );

        assert.deepEqual(lock.sources, []);
      }),
    );

    it.effect("requires an explicit approval selection outside a terminal", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* createFixture();
        const sourcesPath = path.join(fixture.aggregate, "skill-sources.jsonc");
        const original = '{\n  "sources": []\n}\n';

        yield* fs.writeFileString(sourcesPath, original);

        const result = yield* runDevKit(fixture.aggregate, [
          "catalog",
          "add",
          fixture.upstream,
          "--id",
          "fixture-skills",
          "--ref",
          "main",
          "--repo-dir",
          fixture.aggregate,
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /choose skills with --skill <name>, or pass --all/);
        assert.strictEqual(yield* fs.readFileString(sourcesPath), original);
        assert.isFalse(yield* fs.exists(path.join(fixture.aggregate, "skill-sources.lock.json")));
      }),
    );

    it.effect("pins source metadata without copying upstream trees into the distro", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* createFixture();

        const firstRun = yield* runDevKit(fixture.aggregate, [
          "catalog",
          "refresh",
          "--repo-dir",
          fixture.aggregate,
        ]);

        assert.strictEqual(firstRun.exitCode, 0, firstRun.output);
        assert.isFalse(yield* fs.exists(path.join(fixture.aggregate, "skills", "one")));
        assert.isFalse(yield* fs.exists(path.join(fixture.aggregate, "third-party")));

        const firstLockPath = path.join(fixture.aggregate, "skill-sources.lock.json");
        const firstLockText = yield* fs.readFileString(firstLockPath);
        const firstLock = JSON.parse(firstLockText);

        assert.deepEqual(firstLock.sources[0].skills, ["one"]);
        assert.deepEqual(firstLock.sources[0].include, ["one"]);
        assert.strictEqual(firstLock.sources[0].descriptions.one, "Test skill one.");
        assert.strictEqual(
          firstLock.sources[0].resolved,
          (yield* runCommandSuccess(fixture.upstream, "git", ["rev-parse", "HEAD"])).trim(),
        );

        yield* writeSkill(fixture.upstream, "one", "version two");
        yield* commitAll(fixture.upstream, "update");
        const lockedRun = yield* runDevKit(fixture.aggregate, [
          "catalog",
          "refresh",
          "--locked",
          "--repo-dir",
          fixture.aggregate,
        ]);

        assert.strictEqual(lockedRun.exitCode, 0, lockedRun.output);
        assert.strictEqual(yield* fs.readFileString(firstLockPath), firstLockText);

        yield* writeSourceManifest(fixture.aggregate, fixture.upstream, ["two"]);
        const failedLockedRun = yield* runDevKit(fixture.aggregate, [
          "catalog",
          "refresh",
          "--locked",
          "--repo-dir",
          fixture.aggregate,
        ]);

        assert.notStrictEqual(failedLockedRun.exitCode, 0);
        assert.strictEqual(yield* fs.readFileString(firstLockPath), firstLockText);

        yield* writeSourceManifest(fixture.aggregate, fixture.upstream, ["one"]);
        const updatedRun = yield* runDevKit(fixture.aggregate, [
          "catalog",
          "refresh",
          "--repo-dir",
          fixture.aggregate,
        ]);

        assert.strictEqual(updatedRun.exitCode, 0, updatedRun.output);
        const updatedLock = JSON.parse(yield* fs.readFileString(firstLockPath));

        assert.notStrictEqual(updatedLock.sources[0].resolved, firstLock.sources[0].resolved);
      }),
    );

    it.effect("rejects symlinks in approved skill paths", () =>
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
        yield* runCommandSuccess(upstream, "git", ["config", "user.name", "Dev Kit Test"]);
        yield* runCommandSuccess(upstream, "git", ["config", "user.email", "dev-kit@example.test"]);
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

        const result = yield* runDevKit(aggregate, ["catalog", "refresh", "--repo-dir", aggregate]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.include(yield* fs.readFileString(path.join(outside, "SKILL.md")), "Escaped");
      }),
    );

    it.effect("rejects unsafe paths from a tampered lock before deleting files", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* createFixture();
        const firstRun = yield* runDevKit(fixture.aggregate, [
          "catalog",
          "refresh",
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
          "catalog",
          "refresh",
          "--repo-dir",
          fixture.aggregate,
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.strictEqual(yield* fs.readFileString(protectedFile), "keep me\n");
      }),
    );

    it.effect("refuses to refresh while another dev-kit operation holds the lock", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* createFixture();
        const processLock = path.join(fixture.aggregate, ".dev-kit", "apply.lock");
        const ownerPath = path.join(processLock, "owner.json");

        yield* fs.makeDirectory(processLock, { recursive: true });
        yield* fs.writeFileString(ownerPath, '{"token":"other-process"}\n');

        const result = yield* runDevKit(fixture.aggregate, [
          "catalog",
          "refresh",
          "--repo-dir",
          fixture.aggregate,
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /another dev-kit operation may be active/);
        assert.isFalse(yield* fs.exists(path.join(fixture.aggregate, "skill-sources.lock.json")));
        assert.strictEqual(yield* fs.readFileString(ownerPath), '{"token":"other-process"}\n');
      }),
    );
  });
});
