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

  return {
    root,
    skillDir,
    devKitSkillDir: path.join(root, "skills", "dev-kit"),
    referencesDir: path.join(skillDir, "references"),
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
    it.effect("ships the broad Effect skill with valid local references", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, skillDir, referencesDir } = yield* repositoryPaths();

        assert.isTrue(yield* fs.exists(path.join(skillDir, "SKILL.md")));
        assert.isFalse(yield* fs.exists(path.join(root, "skills", "effect-cli", "SKILL.md")));
        assert.isFalse(yield* fs.exists(path.join(root, "skills", "effect-patterns", "SKILL.md")));
        assert.isFalse(
          yield* fs.exists(path.join(root, "skills", "effect-atom-data-fetching", "SKILL.md")),
        );
        assert.isFalse(yield* fs.exists(path.join(root, "skills", "effect-datetime", "SKILL.md")));

        const skill = yield* fs.readFileString(path.join(skillDir, "SKILL.md"));

        assert.match(skill, /^---\nname: effect-ts\n/);
        assert.notMatch(skill, /name: effect-(?:cli|patterns)/);
        assert.notMatch(skill, /stop and prompt the user.*\.repos\/effect/is);

        const referenceNames = new Set(yield* fs.readDirectory(referencesDir));

        assert.isTrue(referenceNames.has("audit-services.md"));
        assert.isTrue(referenceNames.has("guide-datetime.md"));
        assert.match(skill, /Prefer Effect `DateTime` over vanilla JavaScript `Date`/);

        for (const duplicateReference of [
          "atom-cache-lifecycle.md",
          "atom-http-and-invalidation.md",
          "atom-tanstack-start.md",
          "atom-testing.md",
          "guide-atom-data-fetching.md",
          "guide-functions-and-errors.md",
          "guide-http-boundaries.md",
          "guide-logging.md",
          "guide-schema-first-modeling.md",
          "guide-service-design.md",
          "guide-service-design-audit.md",
          "guide-testing-conventions.md",
        ]) {
          assert.isFalse(
            referenceNames.has(duplicateReference),
            `duplicate topic reference still exists: ${duplicateReference}`,
          );
        }

        const routedReferences = [...skill.matchAll(/`\.\/references\/([^`]+\.md)`/g)].flatMap(
          (match) => (match[1] === undefined ? [] : [match[1]]),
        );
        const uniqueRoutedReferences = new Set(routedReferences);

        assert.isNotEmpty(routedReferences);
        for (const reference of routedReferences) {
          assert.isTrue(
            referenceNames.has(reference),
            `SKILL.md routes to missing reference: ${reference}`,
          );
        }
        for (const reference of referenceNames) {
          if (reference.endsWith(".md")) {
            assert.isTrue(
              uniqueRoutedReferences.has(reference),
              `reference is not routed from SKILL.md: ${reference}`,
            );
          }
        }

        for (const reference of referenceNames) {
          if (!reference.endsWith(".md")) continue;
          const markdown = yield* fs.readFileString(path.join(referencesDir, reference));

          for (const match of markdown.matchAll(/\]\((?!https?:|#)([^)]+\.md)(?:#[^)]+)?\)/g)) {
            const linkedReference = match[1];

            if (linkedReference === undefined) continue;
            assert.isTrue(
              yield* fs.exists(path.resolve(referencesDir, linkedReference)),
              `${reference} links to missing file: ${match[1]}`,
            );
          }
        }
      }),
    );

    it.effect("matches the pinned Effect version and avoids removed APIs", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, skillDir, referencesDir } = yield* repositoryPaths();
        const packageJson = JSON.parse(
          yield* fs.readFileString(path.join(root, "package.json")),
        ) as { dependencies: Record<string, string> };
        const effectVersion = packageJson.dependencies.effect;

        if (effectVersion === undefined) assert.fail("effect dependency is missing");

        assert.isString(effectVersion);
        assert.strictEqual(packageJson.dependencies["@effect/platform-bun"], effectVersion);
        assert.match(
          yield* fs.readFileString(path.join(skillDir, "SKILL.md")),
          new RegExp(effectVersion),
        );
        assert.match(
          yield* fs.readFileString(path.join(referencesDir, "version-and-source.md")),
          new RegExp(effectVersion),
        );

        const guidance = (yield* Effect.forEach(
          (yield* fs.readDirectory(referencesDir)).filter(
            (name) => name.endsWith(".md") && name !== "version-and-source.md",
          ),
          (name) => fs.readFileString(path.join(referencesDir, name)),
        )).join("\n");

        assert.notMatch(guidance, /Schema\.DefectWithStack/);
        assert.notMatch(guidance, /Schedule\.either\s*\(/);
        assert.notMatch(guidance, /ExecutionPlan\.captureRequirements\s*\(/);
        assert.notMatch(guidance, /Context\.(?:Tag|GenericTag)\b/);
        assert.notMatch(guidance, /Effect\.(?:Tag|Service|runtime)\b/);
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
        ) as { name: string; scripts: Record<string, string> };
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
        assert.strictEqual(selfLock.setup.effectSource.tag, "effect@4.0.0-beta.102");
        assert.isTrue(yield* fs.exists(path.join(root, "dev-kit.example.jsonc")));
        assert.isTrue(yield* fs.exists(path.join(root, "schema", "dev-kit.schema.json")));
      }),
    );

    it.effect("selects the Effect umbrella directly and through compatibility aliases", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { cli } = yield* repositoryPaths();
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-effect-plan-test-",
        });

        for (const { include, includesApiSkill } of [
          { include: ["effect"], includesApiSkill: true },
          { include: ["effect-ts"], includesApiSkill: false },
          { include: ["effect-atom-data-fetching"], includesApiSkill: true },
        ]) {
          yield* writeManifest(projectDir, include);
          const result = yield* runCli(cli, projectDir, ["plan", "--project-dir", projectDir]);

          assert.strictEqual(result.exitCode, 0, result.output);
          assert.match(result.output, /copy effect-ts → \.agents\/skills\/effect-ts/);
          if (includesApiSkill) {
            assert.match(
              result.output,
              /copy build-effect-apis → \.agents\/skills\/build-effect-apis/,
            );
          } else {
            assert.notMatch(result.output, /copy build-effect-apis/);
          }
          assert.notMatch(result.output, /copy effect-atom-data-fetching|copy effect-datetime/);
          assert.notMatch(result.output, /effect-cli|effect-patterns/);
        }
      }),
    );

    it.effect("rejects removed split Effect skill ids", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { cli } = yield* repositoryPaths();
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-old-effect-id-test-",
        });

        for (const oldSkill of ["effect-cli", "effect-patterns", "effect-datetime"]) {
          yield* writeManifest(projectDir, [oldSkill]);
          const result = yield* runCli(cli, projectDir, ["plan", "--project-dir", projectDir]);

          assert.notStrictEqual(result.exitCode, 0);
        }
      }),
    );
  });
});
