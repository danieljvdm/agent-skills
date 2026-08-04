import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { patchGitignoreContents, patchProjectGitignore } from "../src/gitignore.ts";

describe("gitignore patch", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("uses the canonical .repos root and is idempotent", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-gitignore-test-",
        });
        const gitignorePath = path.join(projectDir, ".gitignore");
        yield* fs.writeFileString(gitignorePath, "node_modules/\n.repos/effect/\n");

        const first = yield* patchProjectGitignore({ projectDir });
        const firstContents = yield* fs.readFileString(gitignorePath);
        const second = yield* patchProjectGitignore({ projectDir });

        assert.deepEqual(first.added, [".repos/", ".dev-kit/"]);
        assert.isTrue(first.changed);
        assert.include(firstContents, ".repos/\n");
        assert.include(firstContents, ".dev-kit/\n");
        assert.isFalse(second.changed);
        assert.strictEqual(yield* fs.readFileString(gitignorePath), firstContents);
      }),
    );

    it.effect("keeps dry runs read-only", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-gitignore-test-",
        });
        const gitignorePath = path.join(projectDir, ".gitignore");

        const result = yield* patchProjectGitignore({ dryRun: true, projectDir });

        assert.isTrue(result.changed);
        assert.isFalse(yield* fs.exists(gitignorePath));
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".dev-kit")));
      }),
    );

    it.effect("refuses to follow a symlinked .gitignore", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-gitignore-test-",
        });
        const externalDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-gitignore-external-test-",
        });
        const externalGitignore = path.join(externalDir, ".gitignore");
        yield* fs.writeFileString(externalGitignore, "keep-this\n");
        yield* fs.symlink(externalGitignore, path.join(projectDir, ".gitignore"));

        const error = yield* Effect.flip(patchProjectGitignore({ projectDir }));

        assert.strictEqual(error._tag, "UnsafeGitignorePathError");
        assert.strictEqual(yield* fs.readFileString(externalGitignore), "keep-this\n");
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".dev-kit", "apply.lock")));
      }),
    );

    it.effect("preserves CRLF and existing entries", () =>
      Effect.sync(() => {
        const result = patchGitignoreContents("node_modules/\r\n.repos/\r\n");
        assert.deepEqual(result.added, [".dev-kit/"]);
        assert.strictEqual(
          result.contents,
          "node_modules/\r\n.repos/\r\n\r\n# dev-kit managed paths\r\n.dev-kit/\r\n",
        );
      }),
    );
  });
});
