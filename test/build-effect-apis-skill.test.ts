import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

describe("build-effect-apis skill", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("ships a routed contract-first API guide", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const testPath = yield* path.fromFileUrl(new URL(import.meta.url));
        const root = path.resolve(path.dirname(testPath), "..");
        const skillDir = path.join(root, "skills", "build-effect-apis");
        const referencesDir = path.join(skillDir, "references");
        const skill = yield* fs.readFileString(path.join(skillDir, "SKILL.md"));

        assert.match(skill, /^---\nname: build-effect-apis\ndescription: /);
        assert.match(skill, /contract spine/i);
        assert.match(skill, /HttpApiBuilder or HttpApiServer/);
        assert.match(skill, /AtomHttpApi\.Service/);
        assert.notMatch(skill, /TODO/);
        assert.isTrue(yield* fs.exists(path.join(skillDir, "agents", "openai.yaml")));

        const expectedReferences = new Set([
          "cloudflare-workers.md",
          "effect-atom-client.md",
          "effect-atom-lifecycle.md",
          "effect-atom-testing.md",
          "runtime-assembly.md",
          "server-and-middleware.md",
          "shared-contracts.md",
          "tanstack-start.md",
          "verification.md",
        ]);
        const referenceNames = new Set(yield* fs.readDirectory(referencesDir));

        assert.deepEqual(referenceNames, expectedReferences);

        const routedReferences = new Set(
          [...skill.matchAll(/\]\(references\/([^)]+\.md)\)/g)].flatMap((match) =>
            match[1] === undefined ? [] : [match[1]],
          ),
        );

        assert.deepEqual(routedReferences, expectedReferences);

        const cloudflare = yield* fs.readFileString(
          path.join(referencesDir, "cloudflare-workers.md"),
        );
        const tanstack = yield* fs.readFileString(path.join(referencesDir, "tanstack-start.md"));
        const atomClient = yield* fs.readFileString(
          path.join(referencesDir, "effect-atom-client.md"),
        );
        const atomLifecycle = yield* fs.readFileString(
          path.join(referencesDir, "effect-atom-lifecycle.md"),
        );
        const atomTesting = yield* fs.readFileString(
          path.join(referencesDir, "effect-atom-testing.md"),
        );
        const server = yield* fs.readFileString(
          path.join(referencesDir, "server-and-middleware.md"),
        );
        const runtime = yield* fs.readFileString(path.join(referencesDir, "runtime-assembly.md"));

        assert.match(cloudflare, /effect-cf/);
        assert.match(cloudflare, /raw route escape hatches/i);
        assert.match(tanstack, /request-specific runtime\/layers per request/);
        assert.match(atomClient, /reactivity-key constructors/);
        assert.match(atomLifecycle, /AsyncResult\.all/);
        assert.match(atomLifecycle, /Atom\.Interrupt/);
        assert.match(atomTesting, /unmounting one\s+consumer does not cancel work/);
        assert.match(atomClient, /HttpApiMiddleware\.layerClient/);
        assert.match(server, /requiredForClient/);
        assert.match(server, /Effect\.catchReasons/);
        assert.match(runtime, /HttpRouter\.toWebHandler/);
        assert.match(runtime, /HttpApiScalar\.layer/);
      }),
    );
  });
});
