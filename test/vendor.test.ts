import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cli = resolve("src/bin/dev-kit.ts");
const tsx = import.meta.resolve("tsx");
const cliArgs = ["--import", tsx, cli];

const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });

const runCli = (args: ReadonlyArray<string>, cwd: string) =>
  run(process.execPath, [...cliArgs, ...args], cwd);

const writeSkill = (root: string, name: string, body: string) => {
  const skillDir = join(root, "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill ${name}.\ndisable-model-invocation: true\n---\n\n${body}\n`,
  );
};

const commitAll = (repository: string, message: string) => {
  run("git", ["add", "."], repository);
  run("git", ["commit", "-m", message], repository);
};

const createFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "dev-kit-vendor-test-"));
  const upstream = join(root, "upstream");
  const aggregate = join(root, "aggregate");
  mkdirSync(upstream);
  mkdirSync(aggregate);
  run("git", ["init", "-b", "main"], upstream);
  run("git", ["config", "user.name", "Dev Kit Test"], upstream);
  run("git", ["config", "user.email", "dev-kit@example.test"], upstream);
  writeSkill(upstream, "one", "version one");
  writeSkill(upstream, "two", "second skill");
  writeFileSync(join(upstream, "LICENSE"), "test license\n");
  commitAll(upstream, "initial");

  const writeManifest = (include: ReadonlyArray<string>) => {
    writeFileSync(
      join(aggregate, "skill-sources.jsonc"),
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
  };
  writeManifest(["one"]);

  return { aggregate, root, upstream, writeManifest };
};

test("vendors, transforms, locks, and updates a local git source", () => {
  const fixture = createFixture();
  try {
    runCli(["vendor", "--repo-dir", fixture.aggregate], fixture.aggregate);
    const firstSkill = readFileSync(
      join(fixture.aggregate, "skills", "one", "SKILL.md"),
      "utf8",
    );
    assert.match(firstSkill, /version one/);
    assert.doesNotMatch(firstSkill, /disable-model-invocation/);
    assert.equal(
      readFileSync(
        join(fixture.aggregate, "third-party", "fixture-skills", "LICENSE"),
        "utf8",
      ),
      "test license\n",
    );

    const firstLockText = readFileSync(
      join(fixture.aggregate, "skill-sources.lock.json"),
      "utf8",
    );
    const firstLock = JSON.parse(firstLockText);
    assert.deepEqual(firstLock.sources[0].skills, ["one"]);
    assert.deepEqual(firstLock.sources[0].include, ["one"]);
    assert.equal(firstLock.sources[0].resolved, run("git", ["rev-parse", "HEAD"], fixture.upstream).trim());

    writeSkill(fixture.upstream, "one", "version two");
    commitAll(fixture.upstream, "update");
    runCli(["vendor", "--locked", "--repo-dir", fixture.aggregate], fixture.aggregate);
    assert.match(
      readFileSync(join(fixture.aggregate, "skills", "one", "SKILL.md"), "utf8"),
      /version one/,
    );

    fixture.writeManifest(["two"]);
    const failedLockedRun = spawnSync(
      process.execPath,
      [...cliArgs, "vendor", "--locked", "--repo-dir", fixture.aggregate],
      { cwd: fixture.aggregate, encoding: "utf8" },
    );
    assert.notEqual(failedLockedRun.status, 0);
    assert.equal(
      readFileSync(join(fixture.aggregate, "skill-sources.lock.json"), "utf8"),
      firstLockText,
    );
    assert.match(
      readFileSync(join(fixture.aggregate, "skills", "one", "SKILL.md"), "utf8"),
      /version one/,
    );

    fixture.writeManifest(["one"]);
    runCli(["vendor", "--repo-dir", fixture.aggregate], fixture.aggregate);
    assert.match(
      readFileSync(join(fixture.aggregate, "skills", "one", "SKILL.md"), "utf8"),
      /version two/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("rejects symlinks in vendored skill paths", () => {
  const root = mkdtempSync(join(tmpdir(), "dev-kit-vendor-symlink-test-"));
  try {
    const upstream = join(root, "upstream");
    const aggregate = join(root, "aggregate");
    const outside = join(root, "outside");
    mkdirSync(join(upstream, "skills"), { recursive: true });
    mkdirSync(aggregate);
    mkdirSync(outside);
    writeFileSync(
      join(outside, "SKILL.md"),
      "---\nname: escaped\ndescription: Escaped test skill.\n---\n",
    );
    symlinkSync(outside, join(upstream, "skills", "escaped"));
    run("git", ["init", "-b", "main"], upstream);
    run("git", ["config", "user.name", "Dev Kit Test"], upstream);
    run("git", ["config", "user.email", "dev-kit@example.test"], upstream);
    commitAll(upstream, "symlink");
    writeFileSync(
      join(aggregate, "skill-sources.jsonc"),
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

    const result = spawnSync(process.execPath, [...cliArgs, "vendor", "--repo-dir", aggregate], {
      cwd: aggregate,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(outside, "SKILL.md"), "utf8").includes("Escaped"), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects unsafe paths from a tampered lockfile before deleting files", () => {
  const fixture = createFixture();
  try {
    runCli(["vendor", "--repo-dir", fixture.aggregate], fixture.aggregate);
    const protectedFile = join(fixture.aggregate, "README.md");
    writeFileSync(protectedFile, "keep me\n");
    const lockPath = join(fixture.aggregate, "skill-sources.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.sources[0].skills = ["../README.md"];
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const result = spawnSync(
      process.execPath,
      [...cliArgs, "vendor", "--repo-dir", fixture.aggregate],
      { cwd: fixture.aggregate, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(protectedFile, "utf8"), "keep me\n");
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});
