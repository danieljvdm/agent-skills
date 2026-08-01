import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(".");
const skillDir = join(root, "skills", "effect-ts");
const devKitSkillDir = join(root, "skills", "dev-kit");
const referencesDir = join(skillDir, "references");
const cli = resolve("src/bin/dev-kit.ts");
const tsx = import.meta.resolve("tsx");
const cliArgs = ["--import", tsx, cli];

const runCli = (args: ReadonlyArray<string>, cwd: string) =>
  execFileSync(process.execPath, [...cliArgs, ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });

const writeManifest = (projectDir: string, include: ReadonlyArray<string>) => {
  writeFileSync(
    join(projectDir, "dev-kit.jsonc"),
    `${JSON.stringify({ include }, null, 2)}\n`,
  );
};

test("ships one consolidated Effect skill with valid local references", () => {
  assert.equal(existsSync(join(skillDir, "SKILL.md")), true);
  assert.equal(existsSync(join(root, "skills", "effect-cli", "SKILL.md")), false);
  assert.equal(existsSync(join(root, "skills", "effect-patterns", "SKILL.md")), false);

  const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: effect-ts\n/);
  assert.doesNotMatch(skill, /name: effect-(?:cli|patterns)/);
  assert.doesNotMatch(skill, /stop and prompt the user.*\.repos\/effect/is);

  const referenceNames = new Set(readdirSync(referencesDir));
  assert.equal(referenceNames.has("audit-services.md"), true);
  for (const duplicateReference of [
    "guide-functions-and-errors.md",
    "guide-logging.md",
    "guide-schema-first-modeling.md",
    "guide-service-design.md",
    "guide-service-design-audit.md",
    "guide-testing-conventions.md",
  ]) {
    assert.equal(
      referenceNames.has(duplicateReference),
      false,
      `duplicate topic reference still exists: ${duplicateReference}`,
    );
  }

  const routedReferences = [
    ...skill.matchAll(/`\.\/references\/([^`]+\.md)`/g),
  ].map((match) => match[1]!);
  const uniqueRoutedReferences = new Set(routedReferences);

  assert.ok(routedReferences.length > 0);
  for (const reference of routedReferences) {
    assert.equal(
      referenceNames.has(reference),
      true,
      `SKILL.md routes to missing reference: ${reference}`,
    );
  }
  for (const reference of referenceNames) {
    if (reference.endsWith(".md")) {
      assert.equal(
        uniqueRoutedReferences.has(reference),
        true,
        `reference is not routed from SKILL.md: ${reference}`,
      );
    }
  }

  for (const reference of referenceNames) {
    if (!reference.endsWith(".md")) {
      continue;
    }
    const markdown = readFileSync(join(referencesDir, reference), "utf8");
    for (const match of markdown.matchAll(/\]\((?!https?:|#)([^)]+\.md)(?:#[^)]+)?\)/g)) {
      assert.equal(
        existsSync(resolve(referencesDir, match[1]!)),
        true,
        `${reference} links to missing file: ${match[1]}`,
      );
    }
  }
});

test("Effect guidance matches beta.102 and avoids removed APIs", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const effectVersion = packageJson.dependencies.effect;
  assert.ok(effectVersion);
  assert.equal(packageJson.dependencies["@effect/platform-node"], effectVersion);
  assert.match(readFileSync(join(skillDir, "SKILL.md"), "utf8"), new RegExp(effectVersion));
  assert.match(
    readFileSync(join(referencesDir, "version-and-source.md"), "utf8"),
    new RegExp(effectVersion),
  );

  const guidance = readdirSync(referencesDir)
    .filter((name) => name.endsWith(".md") && name !== "version-and-source.md")
    .map((name) => readFileSync(join(referencesDir, name), "utf8"))
    .join("\n");

  assert.doesNotMatch(guidance, /Schema\.DefectWithStack/);
  assert.doesNotMatch(guidance, /Schedule\.either\s*\(/);
  assert.doesNotMatch(guidance, /ExecutionPlan\.captureRequirements\s*\(/);
  assert.doesNotMatch(guidance, /Context\.(?:Tag|GenericTag)\b/);
  assert.doesNotMatch(guidance, /Effect\.(?:Tag|Service|runtime)\b/);
});

test("ships dev-kit guidance as a directly selectable skill", () => {
  const skill = readFileSync(join(devKitSkillDir, "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: dev-kit\ndescription: /);
  assert.doesNotMatch(skill, /TODO/);
  assert.equal(existsSync(join(devKitSkillDir, "agents", "openai.yaml")), true);

  const projectDir = mkdtempSync(join(tmpdir(), "dev-kit-self-sync-test-"));
  try {
    writeManifest(projectDir, ["dev-kit"]);
    const output = runCli(
      [
        "plan",
        "--project-dir",
        projectDir,
        "--manifest",
        "dev-kit.jsonc",
      ],
      projectDir,
    );
    assert.match(output, /copy dev-kit -> \.agents\/skills\/dev-kit/);
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("uses canonical dev-kit package, manifest, and schema names", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.name, "@danieljvdm/dev-kit");
  assert.equal(existsSync(join(root, "dev-kit.example.jsonc")), true);
  assert.equal(existsSync(join(root, "schema", "dev-kit.schema.json")), true);
});

test("the effect family and direct skill id both select only effect-ts", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "dev-kit-effect-sync-test-"));
  try {
    for (const include of [["effect"], ["effect-ts"]]) {
      writeManifest(projectDir, include);
      const output = runCli(
        [
          "plan",
          "--project-dir",
          projectDir,
          "--manifest",
          "dev-kit.jsonc",
        ],
        projectDir,
      );
      assert.match(output, /copy effect-ts -> \.agents\/skills\/effect-ts/);
      assert.doesNotMatch(output, /effect-cli|effect-patterns/);
    }
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("old split Effect skill ids are no longer selectable", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "dev-kit-old-effect-id-test-"));
  try {
    for (const oldSkill of ["effect-cli", "effect-patterns"]) {
      writeManifest(projectDir, [oldSkill]);
      const result = spawnSync(
        process.execPath,
        [
          ...cliArgs,
          "plan",
          "--project-dir",
          projectDir,
          "--manifest",
          "dev-kit.jsonc",
        ],
        { cwd: projectDir, encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
    }
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});
