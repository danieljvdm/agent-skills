import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runCommandSuccess, runDevKit } from "./test-platform.ts";

const writeFixture = Effect.fn("writeVitePlusHooksFixture")(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(
    path.join(projectDir, ".gitignore"),
    ".dev-kit/\n.vite-hooks/_/\nnode_modules/\n",
  );
  yield* fs.writeFileString(
    path.join(projectDir, "dev-kit.jsonc"),
    `${JSON.stringify(
      {
        include: [],
        setup: { vitePlus: { hooks: { enabled: true } } },
        targets: { agents: { enabled: false } },
      },
      null,
      2,
    )}\n`,
  );
  yield* fs.writeFileString(
    path.join(projectDir, "package.json"),
    `${JSON.stringify({ devDependencies: { "vite-plus": "0.2.6" } }, null, 2)}\n`,
  );
});

const installFakeVitePlus = Effect.fn("installFakeVitePlusHooks")(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const executable = path.join(projectDir, "node_modules", ".bin", "vp");
  yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
  yield* fs.writeFileString(
    executable,
    `#!/bin/sh
set -eu
mkdir -p .vite-hooks/_
printf '#!/usr/bin/env sh\\nexit 0\\n' > .vite-hooks/_/h
printf '#!/usr/bin/env sh\\n. "$(dirname "$0")/h"\\n' > .vite-hooks/_/pre-commit
chmod +x .vite-hooks/_/h .vite-hooks/_/pre-commit
if [ ! -f .vite-hooks/pre-commit ]; then printf 'vp staged\\n' > .vite-hooks/pre-commit; fi
git config core.hooksPath .vite-hooks/_
count=0
if [ -f .vite-hooks/_/config-count ]; then count="$(cat .vite-hooks/_/config-count)"; fi
printf '%s' "$((count + 1))" > .vite-hooks/_/config-count
`,
    { mode: 0o755 },
  );
});

describe("Vite+ hooks setup", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("configures hooks once and recreates the dispatcher in a linked worktree", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixtureRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-vite-hooks-test-",
        });
        const projectDir = path.join(fixtureRoot, "main");
        yield* fs.makeDirectory(projectDir);
        yield* runCommandSuccess(projectDir, "git", ["init", "--initial-branch", "main"]);
        yield* runCommandSuccess(projectDir, "git", ["config", "user.email", "test@example.com"]);
        yield* runCommandSuccess(projectDir, "git", ["config", "user.name", "Dev Kit Test"]);
        yield* writeFixture(projectDir);
        yield* installFakeVitePlus(projectDir);

        const planned = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);
        assert.strictEqual(planned.exitCode, 0, planned.output);
        assert.match(planned.output, /Vite\+ hooks → \.vite-hooks\/_/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".vite-hooks")));

        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        assert.strictEqual(applied.exitCode, 0, applied.output);
        assert.strictEqual(
          yield* fs.readFileString(path.join(projectDir, ".vite-hooks", "_", "config-count")),
          "1",
        );
        assert.strictEqual(
          (yield* runCommandSuccess(projectDir, "git", [
            "config",
            "--local",
            "--get",
            "core.hooksPath",
          ])).trim(),
          ".vite-hooks/_",
        );

        const converged = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);
        assert.strictEqual(converged.exitCode, 0, converged.output);
        assert.match(converged.output, /Dev kit up to date/);
        assert.strictEqual(
          yield* fs.readFileString(path.join(projectDir, ".vite-hooks", "_", "config-count")),
          "1",
        );

        yield* runCommandSuccess(projectDir, "git", ["add", "."]);
        yield* runCommandSuccess(projectDir, "git", ["commit", "-m", "fixture"]);
        const linkedDir = path.join(fixtureRoot, "linked");
        yield* runCommandSuccess(projectDir, "git", ["worktree", "add", "-b", "linked", linkedDir]);
        yield* installFakeVitePlus(linkedDir);

        assert.isFalse(yield* fs.exists(path.join(linkedDir, ".vite-hooks", "_")));
        const linked = yield* runDevKit(linkedDir, [
          "apply",
          "--locked",
          "--project-dir",
          linkedDir,
        ]);
        assert.strictEqual(linked.exitCode, 0, linked.output);
        assert.strictEqual(
          yield* fs.readFileString(path.join(linkedDir, ".vite-hooks", "_", "config-count")),
          "1",
        );
      }),
    );

    it.effect("requires vite-plus to be a direct installed dependency", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-vite-hooks-dependency-test-",
        });
        yield* runCommandSuccess(projectDir, "git", ["init", "--initial-branch", "main"]);
        yield* writeFixture(projectDir);
        yield* fs.writeFileString(path.join(projectDir, "package.json"), "{}\n");

        const result = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /vite-plus must be a direct project dependency/);
      }),
    );

    it.effect("preserves a competing Git hook manager", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-vite-hooks-conflict-test-",
        });
        yield* runCommandSuccess(projectDir, "git", ["init", "--initial-branch", "main"]);
        yield* runCommandSuccess(projectDir, "git", ["config", "core.hooksPath", ".custom-hooks"]);
        yield* writeFixture(projectDir);
        yield* installFakeVitePlus(projectDir);

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /refusing to replace another Git hook manager/);
        assert.strictEqual(
          (yield* runCommandSuccess(projectDir, "git", [
            "config",
            "--get",
            "core.hooksPath",
          ])).trim(),
          ".custom-hooks",
        );
      }),
    );
  });
});
