import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  digestFileContent,
  digestText,
  observePath,
  observePathWithRawModes,
} from "../src/path-digest.ts";

describe("path digest", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("is deterministic through Effect platform services", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixtureRoot = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-digest-test-" });
        const first = path.join(fixtureRoot, "first");
        const second = path.join(fixtureRoot, "second");

        yield* fs.makeDirectory(path.join(first, "nested"), { recursive: true });
        yield* fs.writeFileString(path.join(first, "alpha.txt"), "alpha\n");
        yield* fs.makeDirectory(path.join(second, "nested"), { recursive: true });
        yield* fs.writeFileString(path.join(second, "alpha.txt"), "alpha\n");

        const [firstDigest, secondDigest] = yield* Effect.all([
          observePath(first),
          observePath(second),
        ]);

        assert.strictEqual(firstDigest.kind, "directory");
        assert.deepEqual(firstDigest, secondDigest);
      }),
    );

    it.effect("uses exact symlink text and Effect Crypto", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixtureRoot = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-digest-test-" });
        const link = path.join(fixtureRoot, "link");

        yield* fs.symlink("first-target", link);
        const first = yield* observePath(link);

        yield* fs.remove(link);
        yield* fs.symlink("second-target", link);
        const second = yield* observePath(link);

        assert.strictEqual(first.kind, "symlink");
        assert.strictEqual(second.kind, "symlink");
        assert.notDeepEqual(first, second);
        assert.strictEqual(yield* digestText("same"), yield* digestText("same"));
      }),
    );

    it.effect("normalizes regular file permissions to Git modes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixtureRoot = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-digest-test-" });
        const restricted = path.join(fixtureRoot, "restricted.txt");
        const readable = path.join(fixtureRoot, "readable.txt");
        const executable = path.join(fixtureRoot, "executable.txt");

        for (const file of [restricted, readable, executable]) {
          yield* fs.writeFileString(file, "same\n");
        }
        yield* fs.chmod(restricted, 0o600);
        yield* fs.chmod(readable, 0o644);
        yield* fs.chmod(executable, 0o700);

        const [restrictedDigest, readableDigest, executableDigest] = yield* Effect.all([
          observePath(restricted),
          observePath(readable),
          observePath(executable),
        ]);

        assert.deepEqual(restrictedDigest, readableDigest);
        assert.notDeepEqual(executableDigest, readableDigest);

        yield* fs.chmod(executable, 0o755);
        assert.deepEqual(yield* observePath(executable), executableDigest);
        assert.strictEqual(
          yield* digestFileContent("same\n", 0o600),
          yield* digestFileContent("same\n", 0o644),
        );
        assert.strictEqual(
          yield* digestFileContent("same\n", 0o700),
          yield* digestFileContent("same\n", 0o755),
        );
        assert.notDeepEqual(
          yield* observePathWithRawModes(restricted),
          yield* observePathWithRawModes(readable),
        );
      }),
    );
  });
});
