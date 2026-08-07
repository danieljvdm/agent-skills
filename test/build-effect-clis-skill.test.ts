import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

describe("build-effect-clis skill", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("ships routed opinionated Effect CLI guidance", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const testPath = yield* path.fromFileUrl(new URL(import.meta.url));
        const root = path.resolve(path.dirname(testPath), "..");
        const skillDir = path.join(root, "skills", "build-effect-clis");
        const referencesDir = path.join(skillDir, "references");
        const skill = yield* fs.readFileString(path.join(skillDir, "SKILL.md"));

        assert.match(skill, /^---\nname: build-effect-clis\ndescription: /);
        assert.match(skill, /command-line applications entirely with Effect/i);
        assert.match(skill, /Command\.run/);
        assert.match(skill, /Schema\.TaggedError/);
        assert.notMatch(skill, /TODO/);
        assert.isTrue(yield* fs.exists(path.join(skillDir, "agents", "openai.yaml")));

        const expectedReferences = new Set([
          "command-design.md",
          "entrypoints-and-testing.md",
          "processes-and-platform.md",
        ]);
        const referenceNames = new Set(yield* fs.readDirectory(referencesDir));

        assert.deepEqual(referenceNames, expectedReferences);

        const routedReferences = new Set(
          [...skill.matchAll(/\]\(references\/([^)]+\.md)\)/g)].flatMap((match) =>
            match[1] === undefined ? [] : [match[1]],
          ),
        );

        assert.deepEqual(routedReferences, expectedReferences);

        const commandDesign = yield* fs.readFileString(
          path.join(referencesDir, "command-design.md"),
        );
        const entrypoints = yield* fs.readFileString(
          path.join(referencesDir, "entrypoints-and-testing.md"),
        );
        const processes = yield* fs.readFileString(
          path.join(referencesDir, "processes-and-platform.md"),
        );

        assert.match(commandDesign, /Command\.withSharedFlags/);
        assert.match(commandDesign, /schema-encoded value to stdout/i);
        assert.match(entrypoints, /NodeRuntime\.runMain/);
        assert.match(entrypoints, /dry-run proving writes did not occur/i);
        assert.match(processes, /ChildProcessSpawner/);
        assert.match(processes, /never\s+construct a shell command from user input/i);
      }),
    );
  });
});
