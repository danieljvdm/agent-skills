import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runDevKit } from "./test-platform.ts";

const writeManifest = Effect.fn("writePackageSyncManifest")(function* (
  projectDir: string,
  mode: "copy" | "symlink" = "copy",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(
    path.join(projectDir, "dev-kit.jsonc"),
    `${JSON.stringify(
      {
        include: ["@tanstack/ai#ai-core"],
        targets: { agents: { enabled: true, mode } },
      },
      null,
      2,
    )}\n`,
  );
  yield* fs.writeFileString(
    path.join(projectDir, "package.json"),
    '{"dependencies":{"@tanstack/ai":"1.2.3"}}\n',
  );
});

const installTanStackAiSkill = Effect.fn("installTestTanStackAiSkill")(function* (
  projectDir: string,
  version: string,
  body = "Package content.\n",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageRoot = path.join(projectDir, "node_modules", "@tanstack", "ai");
  const skillRoot = path.join(packageRoot, "skills", "ai-core");
  yield* fs.makeDirectory(path.join(skillRoot, "chat-experience"), { recursive: true });
  yield* fs.writeFileString(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@tanstack/ai",
      version,
      intent: {
        version: 1,
        repo: "https://github.com/TanStack/ai",
        docs: "https://tanstack.com/ai",
      },
    })}\n`,
  );
  yield* fs.writeFileString(
    path.join(skillRoot, "SKILL.md"),
    `---\nname: ai-core\ndescription: Test TanStack AI skill.\n---\n\n${body}`,
  );
  yield* fs.writeFileString(
    path.join(skillRoot, "chat-experience", "SKILL.md"),
    "---\nname: ai-core/chat-experience\ndescription: Nested topic.\n---\n\nNested.\n",
  );
});

describe("package-backed project sync", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("copies nested package skills and locks installed version and content", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-package-sync-" });
        yield* writeManifest(projectDir);
        yield* installTanStackAiSkill(projectDir, "1.2.3");

        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        assert.strictEqual(applied.exitCode, 0, applied.output);
        const installedSkill = path.join(projectDir, ".agents", "skills", "ai-core");
        assert.isTrue(yield* fs.exists(path.join(installedSkill, "SKILL.md")));
        assert.isTrue(yield* fs.exists(path.join(installedSkill, "chat-experience", "SKILL.md")));

        const lockPath = path.join(projectDir, "dev-kit.lock.json");
        const firstLock = JSON.parse(yield* fs.readFileString(lockPath));
        assert.deepEqual(firstLock.outputs[0].catalog, {
          package: "@tanstack/ai",
          version: "1.2.3",
          skill: "ai-core",
          digest: firstLock.outputs[0].digest,
        });
        assert.match(firstLock.outputs[0].digest, /^sha256:/);

        const converged = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);
        assert.strictEqual(converged.exitCode, 0, converged.output);

        yield* installTanStackAiSkill(projectDir, "1.2.4");
        const changedVersion = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);
        assert.notStrictEqual(changedVersion.exitCode, 0);
        assert.match(changedVersion.output, /manifest or packaged skills differ/);

        const updated = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        assert.strictEqual(updated.exitCode, 0, updated.output);
        const secondLock = JSON.parse(yield* fs.readFileString(lockPath));
        assert.strictEqual(secondLock.outputs[0].catalog.version, "1.2.4");

        yield* installTanStackAiSkill(projectDir, "1.2.4", "Changed package content.\n");
        const changedContent = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);
        assert.notStrictEqual(changedContent.exitCode, 0);
        assert.match(changedContent.output, /manifest or packaged skills differ/);
      }),
    );

    it.effect("fails without mutating outputs when a selected package is missing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-package-missing-",
        });
        yield* writeManifest(projectDir);

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /package skill package is not installed: @tanstack\/ai/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".agents")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
      }),
    );

    it.effect(
      "keeps symlink locks stable across package-store relocation and detects content drift",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-package-link-" });
          yield* writeManifest(projectDir, "symlink");
          yield* installTanStackAiSkill(projectDir, "1.2.3");
          const packageLink = path.join(projectDir, "node_modules", "@tanstack", "ai");
          const firstStore = path.join(projectDir, ".package-store", "first", "ai");
          yield* fs.makeDirectory(path.dirname(firstStore), { recursive: true });
          yield* fs.rename(packageLink, firstStore);
          yield* fs.symlink(firstStore, packageLink);

          const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
          assert.strictEqual(applied.exitCode, 0, applied.output);
          const lock = JSON.parse(
            yield* fs.readFileString(path.join(projectDir, "dev-kit.lock.json")),
          );
          assert.match(lock.outputs[0].catalog.digest, /^sha256:/);
          assert.notStrictEqual(lock.outputs[0].catalog.digest, lock.outputs[0].digest);

          const secondStore = path.join(projectDir, ".package-store", "second", "ai");
          yield* fs.makeDirectory(path.dirname(secondStore), { recursive: true });
          yield* fs.remove(packageLink);
          yield* fs.rename(firstStore, secondStore);
          yield* fs.symlink(secondStore, packageLink);
          const relocated = yield* runDevKit(projectDir, [
            "apply",
            "--locked",
            "--project-dir",
            projectDir,
          ]);
          assert.strictEqual(relocated.exitCode, 0, relocated.output);

          yield* installTanStackAiSkill(projectDir, "1.2.3", "Changed behind symlink.\n");
          const changed = yield* runDevKit(projectDir, [
            "apply",
            "--locked",
            "--project-dir",
            projectDir,
          ]);
          assert.notStrictEqual(changed.exitCode, 0);
          assert.match(changed.output, /manifest or packaged skills differ/);
        }),
    );

    it.effect("rejects selected package skills that collide at the output name", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-package-collision-",
        });
        yield* fs.writeFileString(
          path.join(projectDir, "package.json"),
          '{"dependencies":{"one":"1","two":"1"}}\n',
        );
        yield* fs.writeFileString(
          path.join(projectDir, "dev-kit.jsonc"),
          '{"include":["one#same","two#same"],"targets":{"agents":{"enabled":true,"mode":"copy"}}}\n',
        );
        for (const packageName of ["one", "two"]) {
          const root = path.join(projectDir, "node_modules", packageName);
          yield* fs.makeDirectory(path.join(root, "skills", "same"), { recursive: true });
          yield* fs.writeFileString(
            path.join(root, "package.json"),
            JSON.stringify({
              name: packageName,
              version: "1.0.0",
              intent: {
                version: 1,
                repo: `https://example.test/${packageName}`,
                docs: "https://example.test/docs",
              },
            }),
          );
          yield* fs.writeFileString(
            path.join(root, "skills", "same", "SKILL.md"),
            `---\nname: same\ndescription: ${packageName}.\n---\n`,
          );
        }

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /would both install as same: one#same, two#same/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".agents")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
      }),
    );

    it.effect("keeps an explicitly selected valid skill when a package sibling is malformed", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-package-sibling-",
        });
        const packageRoot = path.join(projectDir, "node_modules", "package-skills");
        yield* fs.makeDirectory(path.join(packageRoot, "skills", "valid"), { recursive: true });
        yield* fs.makeDirectory(path.join(packageRoot, "skills", "broken"), { recursive: true });
        yield* fs.writeFileString(
          path.join(projectDir, "package.json"),
          '{"dependencies":{"package-skills":"1"}}\n',
        );
        yield* fs.writeFileString(
          path.join(projectDir, "dev-kit.jsonc"),
          '{"include":["package-skills#valid"],"targets":{"agents":{"enabled":true,"mode":"copy"}}}\n',
        );
        yield* fs.writeFileString(
          path.join(packageRoot, "package.json"),
          '{"name":"package-skills","version":"1.0.0","repository":"https://example.test/package-skills"}',
        );
        yield* fs.writeFileString(
          path.join(packageRoot, "skills", "valid", "SKILL.md"),
          "---\nname: valid\ndescription: Valid.\n---\n",
        );
        yield* fs.writeFileString(
          path.join(packageRoot, "skills", "broken", "SKILL.md"),
          "---\nname: wrong\ndescription: Broken.\n---\n",
        );

        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        assert.strictEqual(applied.exitCode, 0, applied.output);
        assert.isTrue(
          yield* fs.exists(path.join(projectDir, ".agents", "skills", "valid", "SKILL.md")),
        );
      }),
    );
  });
});
