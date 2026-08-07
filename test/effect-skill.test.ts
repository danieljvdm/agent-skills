import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { parse as parseJsonc } from "jsonc-parser";

const repositoryPaths = Effect.fn("repositoryPaths")(function* () {
  const path = yield* Path.Path;
  const testPath = yield* path.fromFileUrl(new URL(import.meta.url));
  const root = path.resolve(path.dirname(testPath), "..");
  const skillDir = path.join(root, "skills", "effect-ts");
  const architectureSkillDir = path.join(root, "skills", "effect-architecture-audit");

  return {
    architectureSkillDir,
    architectureReferencesDir: path.join(architectureSkillDir, "references"),
    root,
    skillDir,
    devKitSkillDir: path.join(root, "skills", "dev-kit"),
    cli: path.join(root, "src", "bin", "dev-kit.ts"),
  };
});

const runCli = Effect.fn("runTestCli")(function* (
  cli: string,
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const child = yield* ChildProcess.make("bun", [cli, ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [output, exitCode] = yield* Effect.all([
    Stream.mkString(Stream.decodeText(child.all)),
    child.exitCode,
  ]);

  return { exitCode, output };
});

const writeManifest = Effect.fn("writeTestManifest")(function* (
  projectDir: string,
  include: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.writeFileString(
    path.join(projectDir, "dev-kit.jsonc"),
    `${JSON.stringify({ include }, null, 2)}\n`,
  );
});

describe("shipped skills", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("ships the upstream Effect bootstrap and a focused architecture audit", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { architectureReferencesDir, architectureSkillDir, skillDir } =
          yield* repositoryPaths();

        assert.isTrue(yield* fs.exists(path.join(skillDir, "SKILL.md")));

        const skill = yield* fs.readFileString(path.join(skillDir, "SKILL.md"));

        assert.match(skill, /^---\nname: effect-ts\n/);
        assert.match(skill, /node_modules\/effect\/AGENTS\.md/);
        assert.match(skill, /node_modules\/effect\/src/);
        assert.notMatch(skill, /references\//);
        assert.notMatch(skill, /4\.0\.0-beta/);
        assert.isTrue(yield* fs.exists(path.join(skillDir, "agents", "openai.yaml")));

        const architectureSkill = yield* fs.readFileString(
          path.join(architectureSkillDir, "SKILL.md"),
        );
        const referenceNames = new Set(yield* fs.readDirectory(architectureReferencesDir));

        assert.match(architectureSkill, /^---\nname: effect-architecture-audit\n/);
        assert.notMatch(architectureSkill, /TODO/);
        assert.deepEqual(referenceNames, new Set(["service-and-boundary-audit.md"]));
        assert.match(architectureSkill, /\]\(references\/service-and-boundary-audit\.md\)/);
        assert.isTrue(yield* fs.exists(path.join(architectureSkillDir, "agents", "openai.yaml")));
      }),
    );

    it.effect("keeps the installed Effect v4 family aligned with bundled guidance", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root } = yield* repositoryPaths();
        const packageJson = JSON.parse(
          yield* fs.readFileString(path.join(root, "package.json")),
        ) as {
          dependencies: Record<string, string>;
          devDependencies: Record<string, string>;
        };
        const effectVersion = packageJson.dependencies.effect;

        if (effectVersion === undefined) assert.fail("effect dependency is missing");

        assert.isString(effectVersion);
        assert.strictEqual(packageJson.dependencies["@effect/platform-bun"], effectVersion);
        assert.strictEqual(packageJson.devDependencies["@effect/platform-node"], effectVersion);
        assert.strictEqual(packageJson.devDependencies["@effect/vitest"], effectVersion);
        assert.isTrue(yield* fs.exists(path.join(root, "node_modules", "effect", "AGENTS.md")));
      }),
    );

    it.effect("ships dev-kit guidance as a directly selectable skill", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { cli, devKitSkillDir } = yield* repositoryPaths();
        const skill = yield* fs.readFileString(path.join(devKitSkillDir, "SKILL.md"));

        assert.match(skill, /^---\nname: dev-kit\ndescription: /);
        assert.notMatch(skill, /TODO/);
        assert.match(skill, /"postinstall": "dev-kit apply"/);
        assert.notMatch(skill, /"postinstall": "dev-kit apply --locked"/);
        assert.isTrue(yield* fs.exists(path.join(devKitSkillDir, "agents", "openai.yaml")));

        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-self-plan-test-",
        });

        yield* writeManifest(projectDir, ["dev-kit"]);
        const result = yield* runCli(cli, projectDir, ["plan", "--project-dir", projectDir]);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.match(result.output, /copy dev-kit → \.agents\/skills\/dev-kit/);
      }),
    );

    it.effect("uses canonical dev-kit package, manifest, and schema names", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root } = yield* repositoryPaths();
        const packageJson = JSON.parse(
          yield* fs.readFileString(path.join(root, "package.json")),
        ) as {
          dependencies: Record<string, string>;
          name: string;
          scripts: Record<string, string>;
        };
        const selfManifest = parseJsonc(yield* fs.readFileString(path.join(root, "dev-kit.jsonc")));
        const selfLock = JSON.parse(yield* fs.readFileString(path.join(root, "dev-kit.lock.json")));

        assert.strictEqual(packageJson.name, "@danieljvdm/dev-kit");
        assert.strictEqual(packageJson.scripts.prepare, "./bin/dev-kit.mjs apply --locked");
        assert.strictEqual(packageJson.scripts["dev-kit"], "./bin/dev-kit.mjs");
        assert.deepEqual(selfManifest.include, ["dev-kit", "effect"]);
        assert.isTrue(selfManifest.setup.effectSource.enabled);
        assert.isTrue(selfManifest.setup.effectTsgo.enabled);
        assert.isTrue(selfManifest.setup.vitePlus.hooks.enabled);
        assert.isTrue(selfManifest.setup.vitePlus.quality.workflow.enabled);
        assert.isUndefined(packageJson.scripts.check);
        assert.isUndefined(packageJson.scripts.typecheck);
        assert.isFalse(selfManifest.targets.agents.enabled);
        assert.deepEqual(
          selfLock.outputs.map((output: { resourceId: string }) => output.resourceId),
          [
            "setup:vite-plus-github-actions",
            "setup:agent-instructions",
            "setup:claude-instructions",
          ],
        );
        assert.strictEqual(
          selfLock.setup.effectSource.tag,
          `effect@${packageJson.dependencies.effect}`,
        );
        assert.isTrue(yield* fs.exists(path.join(root, "dev-kit.example.jsonc")));
        assert.isTrue(yield* fs.exists(path.join(root, "schema", "dev-kit.schema.json")));
      }),
    );

    it.effect("selects the Effect umbrella and its focused skills directly", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { cli } = yield* repositoryPaths();
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-effect-plan-test-",
        });

        for (const { expectedSkills, include } of [
          {
            include: ["effect"],
            expectedSkills: ["effect-ts", "effect-architecture-audit", "build-effect-apis"],
          },
          { include: ["effect-ts"], expectedSkills: ["effect-ts"] },
          {
            include: ["effect-architecture-audit"],
            expectedSkills: ["effect-architecture-audit"],
          },
        ]) {
          yield* writeManifest(projectDir, include);
          const result = yield* runCli(cli, projectDir, ["plan", "--project-dir", projectDir]);

          assert.strictEqual(result.exitCode, 0, result.output);
          for (const skillName of ["effect-ts", "effect-architecture-audit", "build-effect-apis"]) {
            if (expectedSkills.includes(skillName)) {
              assert.include(result.output, `copy ${skillName} → .agents/skills/${skillName}`);
            } else {
              assert.notInclude(result.output, `copy ${skillName}`);
            }
          }
        }
      }),
    );
  });
});
