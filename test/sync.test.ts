import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

import {
  EFFECT_TSGO_TYPESCRIPT_VERSION,
  EFFECT_TSGO_VERSION,
} from "../src/effect-tsgo.ts";

const cli = resolve("src/bin/agent-skills.ts");
const tsx = import.meta.resolve("tsx");
const cliArgs = ["--import", tsx, cli];
const effectSkill = resolve("skills/effect-ts");

type ManifestOptions = {
  readonly agentsEnabled?: boolean;
  readonly claudeEnabled?: boolean;
  readonly effectTsgoEnabled?: boolean;
};

const writeManifest = (projectDir: string, options: ManifestOptions = {}) => {
  writeFileSync(
    join(projectDir, "agent-skills.jsonc"),
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
};

const installFakeEffectTsgo = (projectDir: string) => {
  const writePackage = (packageName: string, version: string) => {
    const packageDir = join(projectDir, "node_modules", ...packageName.split("/"));
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), `${JSON.stringify({ version })}\n`);
  };
  writePackage("@effect/tsgo", EFFECT_TSGO_VERSION);
  writePackage("typescript", EFFECT_TSGO_TYPESCRIPT_VERSION);

  const platformLib = join(
    projectDir,
    "node_modules",
    "@typescript",
    "typescript-test",
    "lib",
  );
  mkdirSync(platformLib, { recursive: true });
  writeFileSync(join(platformLib, "tsc"), "original\n");
  const effectPlatformLib = join(
    projectDir,
    "node_modules",
    "@effect",
    "tsgo-test",
    "lib",
  );
  mkdirSync(effectPlatformLib, { recursive: true });
  writeFileSync(join(effectPlatformLib, "tsc"), "patched\n");

  const executable = join(projectDir, "node_modules", ".bin", "effect-tsgo");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const projectDir = process.cwd();
const marker = path.join(projectDir, "tsgo-patch-count.txt");
const count = fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) : 0;
fs.writeFileSync(marker, String(count + 1));
fs.writeFileSync(path.join(projectDir, "node_modules", "@typescript", "typescript-test", "lib", "tsc.original"), "original\\n");
fs.writeFileSync(path.join(projectDir, "node_modules", "@typescript", "typescript-test", "lib", "tsc"), "patched\\n");
console.log("Verification succeeded.");
`,
    { mode: 0o755 },
  );
};

const runCli = (projectDir: string, args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, [...cliArgs, ...args, "--project-dir", projectDir], {
    cwd: projectDir,
    encoding: "utf8",
  });

const createProject = () => {
  const projectDir = mkdtempSync(join(tmpdir(), "dev-kit-sync-test-"));
  writeManifest(projectDir);
  return projectDir;
};

test("plan reports creates without writing project state", () => {
  const projectDir = createProject();
  try {
    const result = runCli(projectDir, ["plan"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /create copy effect-ts -> \.agents\/skills\/effect-ts/);
    assert.equal(existsSync(join(projectDir, ".agents")), false);
    assert.equal(existsSync(join(projectDir, "dev-kit.lock.json")), false);
    assert.equal(existsSync(join(projectDir, ".dev-kit")), false);
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("apply creates locked owned skills and converges without rewriting metadata", () => {
  const projectDir = createProject();
  try {
    const first = runCli(projectDir, ["apply"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /create copy effect-ts/);
    assert.equal(existsSync(join(projectDir, ".agents", "skills", "effect-ts", "SKILL.md")), true);

    const lockPath = join(projectDir, "dev-kit.lock.json");
    const statePath = join(projectDir, ".dev-kit", "state.json");
    const firstLock = readFileSync(lockPath, "utf8");
    const firstState = readFileSync(statePath, "utf8");
    const lock = JSON.parse(firstLock);
    assert.equal(lock.outputs[0].resourceId, "skill:effect-ts@agents");
    assert.equal(lock.outputs[0].path, ".agents/skills/effect-ts");

    const second = runCli(projectDir, ["apply"]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /unchanged copy effect-ts/);
    assert.equal(readFileSync(lockPath, "utf8"), firstLock);
    assert.equal(readFileSync(statePath, "utf8"), firstState);
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("one manifest-driven apply runs the Effect tsgo setup task exactly once", () => {
  const projectDir = createProject();
  try {
    installFakeEffectTsgo(projectDir);
    writeManifest(projectDir, { effectTsgoEnabled: true });
    const marker = join(projectDir, "tsgo-patch-count.txt");

    const planned = runCli(projectDir, ["plan"]);
    assert.equal(planned.status, 0, planned.stderr);
    assert.match(planned.stdout, /setup effect-tsgo@0\.24\.3 -> typescript@7\.0\.2/);
    assert.equal(existsSync(marker), false);

    const applied = runCli(projectDir, ["apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(readFileSync(marker, "utf8"), "1");

    const lockPath = join(projectDir, "dev-kit.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.deepEqual(lock.setup.effectTsgo, {
      effectTsgoVersion: EFFECT_TSGO_VERSION,
      typescriptPackage: "typescript",
      typescriptVersion: EFFECT_TSGO_TYPESCRIPT_VERSION,
    });

    const postinstall = runCli(projectDir, ["apply", "--locked"]);
    assert.equal(postinstall.status, 0, postinstall.stderr);
    assert.match(postinstall.stdout, /unchanged effect-tsgo@0\.24\.3/);
    assert.equal(readFileSync(marker, "utf8"), "1");

    lock.setup.effectTsgo.effectTsgoVersion = "0.0.0";
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const mismatched = runCli(projectDir, ["apply", "--locked"]);
    assert.notEqual(mismatched.status, 0);
    assert.match(mismatched.stderr, /manifest or packaged skills differ/);
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("apply preserves and reports an unknown destination", () => {
  const projectDir = createProject();
  try {
    const destination = join(projectDir, ".agents", "skills", "effect-ts");
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "keep.txt"), "user content\n");

    const result = runCli(projectDir, ["apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /conflict \.agents\/skills\/effect-ts/);
    assert.equal(readFileSync(join(destination, "keep.txt"), "utf8"), "user content\n");
    assert.equal(existsSync(join(projectDir, "dev-kit.lock.json")), false);
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("disabling a target cleans only its unchanged owned skill", () => {
  const projectDir = createProject();
  try {
    assert.equal(runCli(projectDir, ["apply"]).status, 0);
    const unrelated = join(projectDir, ".agents", "skills", "local-skill");
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(unrelated, "SKILL.md"), "local\n");
    writeManifest(projectDir, { agentsEnabled: false });

    const planned = runCli(projectDir, ["plan"]);
    assert.equal(planned.status, 0, planned.stderr);
    assert.match(planned.stdout, /remove skill:effect-ts@agents/);
    assert.equal(existsSync(join(projectDir, ".agents", "skills", "effect-ts")), true);

    const applied = runCli(projectDir, ["apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(existsSync(join(projectDir, ".agents", "skills", "effect-ts")), false);
    assert.equal(readFileSync(join(unrelated, "SKILL.md"), "utf8"), "local\n");
    assert.deepEqual(JSON.parse(readFileSync(join(projectDir, "dev-kit.lock.json"), "utf8")).outputs, []);
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("modified stale owned skills conflict and are preserved", () => {
  const projectDir = createProject();
  try {
    assert.equal(runCli(projectDir, ["apply"]).status, 0);
    const skillDocument = join(projectDir, ".agents", "skills", "effect-ts", "SKILL.md");
    writeFileSync(skillDocument, `${readFileSync(skillDocument, "utf8")}\nlocal edit\n`);
    writeManifest(projectDir, { agentsEnabled: false });

    const result = runCli(projectDir, ["apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /stale owned destination was modified/);
    assert.match(readFileSync(skillDocument, "utf8"), /local edit/);
    assert.equal(JSON.parse(readFileSync(join(projectDir, "dev-kit.lock.json"), "utf8")).outputs.length, 1);
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("an exact locked output is adopted when local state is absent", () => {
  const projectDir = createProject();
  try {
    assert.equal(runCli(projectDir, ["apply"]).status, 0);
    rmSync(join(projectDir, ".dev-kit"), { force: true, recursive: true });

    const result = runCli(projectDir, ["apply", "--locked"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /unchanged copy effect-ts.*\(adopt\)/);
    assert.equal(existsSync(join(projectDir, ".dev-kit", "state.json")), true);
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("symlink targets retain current relative-link semantics", () => {
  const projectDir = createProject();
  try {
    writeManifest(projectDir, { claudeEnabled: true });
    const result = runCli(projectDir, ["apply"]);
    assert.equal(result.status, 0, result.stderr);
    const link = join(projectDir, ".claude", "skills", "effect-ts");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(
      readlinkSync(link),
      relative(dirname(link), join(projectDir, ".agents", "skills", "effect-ts")),
    );
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("locked apply rejects manifest drift without cleanup", () => {
  const projectDir = createProject();
  try {
    assert.equal(runCli(projectDir, ["apply"]).status, 0);
    writeManifest(projectDir, { agentsEnabled: false });

    const result = runCli(projectDir, ["apply", "--locked"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest or packaged skills differ/);
    assert.equal(existsSync(join(projectDir, ".agents", "skills", "effect-ts")), true);
    assert.equal(JSON.parse(readFileSync(join(projectDir, "dev-kit.lock.json"), "utf8")).outputs.length, 1);
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("locked apply migrates local ownership state from a previously applied lock", () => {
  const projectDir = createProject();
  const nextProjectDir = createProject();
  try {
    assert.equal(runCli(projectDir, ["apply"]).status, 0);
    writeManifest(projectDir, { agentsEnabled: false });

    writeManifest(nextProjectDir, { agentsEnabled: false });
    assert.equal(runCli(nextProjectDir, ["apply"]).status, 0);
    cpSync(
      join(nextProjectDir, "dev-kit.lock.json"),
      join(projectDir, "dev-kit.lock.json"),
    );

    const result = runCli(projectDir, ["apply", "--locked"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /remove skill:effect-ts@agents/);
    assert.equal(existsSync(join(projectDir, ".agents", "skills", "effect-ts")), false);
    assert.deepEqual(
      JSON.parse(readFileSync(join(projectDir, ".dev-kit", "state.json"), "utf8")).outputs,
      [],
    );
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
    rmSync(nextProjectDir, { force: true, recursive: true });
  }
});

test("apply rejects lockfile paths that overlap toolkit metadata or managed outputs", () => {
  for (const lockfile of [
    ".dev-kit/state.json",
    ".agents/skills/effect-ts/dev-kit.lock.json",
  ]) {
    const projectDir = createProject();
    try {
      const result = runCli(projectDir, ["apply", "--lockfile", lockfile]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /overlaps/);
      assert.equal(existsSync(join(projectDir, ".agents")), false);
    } finally {
      rmSync(projectDir, { force: true, recursive: true });
    }
  }
});

test("a pre-existing exact tree without a lock is not adopted", () => {
  const projectDir = createProject();
  try {
    const destination = join(projectDir, ".agents", "skills", "effect-ts");
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(effectSkill, destination, { recursive: true });

    const result = runCli(projectDir, ["apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /destination exists but is not owned/);
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("apply refuses to mutate a project while another apply lock exists", () => {
  const projectDir = createProject();
  try {
    const processLock = join(projectDir, ".dev-kit", "apply.lock");
    mkdirSync(processLock, { recursive: true });
    writeFileSync(join(processLock, "owner.json"), '{"pid":123}\n');

    const result = runCli(projectDir, ["apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /another dev-kit apply may be active/);
    assert.equal(existsSync(join(projectDir, ".agents")), false);
    assert.equal(existsSync(join(projectDir, "dev-kit.lock.json")), false);
    assert.equal(readFileSync(join(processLock, "owner.json"), "utf8"), '{"pid":123}\n');
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("a late apply failure rolls back installed skill outputs", () => {
  const projectDir = createProject();
  try {
    const blockedParent = join(projectDir, "blocked");
    writeFileSync(blockedParent, "not a directory\n");

    const result = runCli(projectDir, ["apply", "--lockfile", "blocked/dev-kit.lock.json"]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(projectDir, ".agents", "skills", "effect-ts")), false);
    assert.equal(readFileSync(blockedParent, "utf8"), "not a directory\n");
    assert.equal(existsSync(join(projectDir, ".dev-kit", "state.json")), false);
    assert.equal(existsSync(join(projectDir, ".dev-kit", "apply.lock")), false);
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("apply rejects symlink ancestors without touching their targets", () => {
  const projectDir = createProject();
  const externalDir = mkdtempSync(join(tmpdir(), "dev-kit-external-test-"));
  try {
    writeFileSync(join(externalDir, "keep.txt"), "external content\n");
    symlinkSync(externalDir, join(projectDir, ".agents"));

    const result = runCli(projectDir, ["apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ancestor is a symlink/);
    assert.equal(readFileSync(join(externalDir, "keep.txt"), "utf8"), "external content\n");
    assert.equal(existsSync(join(projectDir, "dev-kit.lock.json")), false);
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
    rmSync(externalDir, { force: true, recursive: true });
  }
});
