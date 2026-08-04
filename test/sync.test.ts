import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Crypto, Effect, Encoding, FileSystem, Path } from "effect";

import { EFFECT_TSGO_TYPESCRIPT_VERSION, EFFECT_TSGO_VERSION } from "../src/effect-tsgo.ts";
import { repositoryRoot, runDevKit } from "./test-platform.ts";

type ManifestOptions = {
  readonly agentInstructionsEnabled?: boolean;
  readonly agentsEnabled?: boolean;
  readonly claudeInstructionsEnabled?: boolean;
  readonly claudeEnabled?: boolean;
  readonly effectTsgoEnabled?: boolean;
};

const writeManifest = Effect.fn("writeSyncTestManifest")(function* (
  projectDir: string,
  options: ManifestOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.writeFileString(
    path.join(projectDir, "dev-kit.jsonc"),
    `${JSON.stringify(
      {
        include: ["effect"],
        ...(options.agentInstructionsEnabled ||
        options.effectTsgoEnabled ||
        options.claudeInstructionsEnabled
          ? {
              setup: {
                ...(options.agentInstructionsEnabled
                  ? { agentInstructions: { enabled: true } }
                  : {}),
                ...(options.claudeInstructionsEnabled
                  ? { claudeInstructions: { enabled: true } }
                  : {}),
                ...(options.effectTsgoEnabled ? { effectTsgo: { enabled: true } } : {}),
              },
            }
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
});

const createProject = Effect.fn("createSyncTestProject")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const projectDir = yield* fs.makeTempDirectoryScoped({
    prefix: "dev-kit-sync-test-",
  });

  yield* writeManifest(projectDir);

  return projectDir;
});

const writeProjectPackage = Effect.fn("writeSyncTestProjectPackage")(function* (
  projectDir: string,
  packageJson: Record<string, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.writeFileString(
    path.join(projectDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
});

const installFakeVitePlusInstructions = Effect.fn("installFakeVitePlusInstructions")(function* (
  projectDir: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageDir = path.join(projectDir, "node_modules", "vite-plus");

  yield* fs.makeDirectory(packageDir, { recursive: true });
  yield* fs.writeFileString(path.join(packageDir, "AGENTS.md"), contents);
});

const writePackageVersion = Effect.fn("writeSyncTestPackageVersion")(function* (
  projectDir: string,
  packageName: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageDir = path.join(projectDir, "node_modules", ...packageName.split("/"));

  yield* fs.makeDirectory(packageDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ version })}\n`,
  );
});

const installFakeEffectTsgo = Effect.fn("installFakeEffectTsgo")(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* writePackageVersion(projectDir, "@effect/tsgo", EFFECT_TSGO_VERSION);
  yield* writePackageVersion(projectDir, "typescript", EFFECT_TSGO_TYPESCRIPT_VERSION);

  const platform = "test-platform";
  const typescriptPlatformPackage = `@typescript/typescript-${platform}`;
  const effectPlatformPackage = `@effect/tsgo-${platform}`;

  yield* writePackageVersion(projectDir, typescriptPlatformPackage, EFFECT_TSGO_TYPESCRIPT_VERSION);
  yield* writePackageVersion(projectDir, effectPlatformPackage, EFFECT_TSGO_VERSION);

  const platformLib = path.join(
    projectDir,
    "node_modules",
    "@typescript",
    `typescript-${platform}`,
    "lib",
  );
  const effectPlatformLib = path.join(
    projectDir,
    "node_modules",
    "@effect",
    `tsgo-${platform}`,
    "lib",
  );

  yield* fs.makeDirectory(platformLib, { recursive: true });
  yield* fs.makeDirectory(effectPlatformLib, { recursive: true });
  yield* fs.writeFileString(path.join(platformLib, "tsc"), "original\n");
  yield* fs.writeFileString(path.join(effectPlatformLib, "tsc"), "patched\n");

  const executable = path.join(projectDir, "node_modules", ".bin", "effect-tsgo");

  yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
  yield* fs.writeFileString(
    executable,
    `#!/bin/sh
set -eu
marker="$PWD/tsgo-patch-count.txt"
count=0
if [ -f "$marker" ]; then count="$(tr -d '\\n' < "$marker")"; fi
printf '%s' "$((count + 1))" > "$marker"
cp "$PWD/node_modules/${typescriptPlatformPackage}/lib/tsc" "$PWD/node_modules/${typescriptPlatformPackage}/lib/tsc.original"
cp "$PWD/node_modules/${effectPlatformPackage}/lib/tsc" "$PWD/node_modules/${typescriptPlatformPackage}/lib/tsc"
printf 'Verification succeeded.\\n'
`,
    { mode: 0o755 },
  );
});

const rawModeFileDigest = Effect.fn("rawModeFileDigest")(function* (value: string, mode: number) {
  const crypto = yield* Crypto.Crypto;
  const encoder = new TextEncoder();
  const frame = (input: string): Uint8Array => {
    const bytes = encoder.encode(input);
    const framed = new Uint8Array(4 + bytes.length);

    new DataView(framed.buffer).setUint32(0, bytes.length);
    framed.set(bytes, 4);

    return framed;
  };
  const frames = ["file-v1", String(mode), value].map(frame);
  const combined = new Uint8Array(frames.reduce((length, bytes) => length + bytes.length, 0));
  let offset = 0;

  for (const bytes of frames) {
    combined.set(bytes, offset);
    offset += bytes.length;
  }

  return `sha256:${Encoding.encodeHex(yield* crypto.digest("SHA-256", combined))}`;
});

const createInstructionProject = Effect.fn("createInstructionProject")(function* () {
  const path = yield* Path.Path;
  const projectDir = yield* createProject();

  yield* writeManifest(projectDir, { agentInstructionsEnabled: true });
  const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

  assert.strictEqual(result.exitCode, 0, result.output);

  return {
    instructionsPath: path.join(projectDir, "AGENTS.md"),
    projectDir,
    statePath: path.join(projectDir, ".dev-kit"),
  };
});

const createLockedInstructionFixture = Effect.fn("createLockedInstructionFixture")(function* (
  mode: number,
  toolVersion?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixture = yield* createInstructionProject();
  const oldContent = `${yield* fs.readFileString(fixture.instructionsPath)}old release\n`;

  yield* fs.writeFileString(fixture.instructionsPath, oldContent, { mode });
  yield* fs.chmod(fixture.instructionsPath, mode);
  const lockPath = path.join(fixture.projectDir, "dev-kit.lock.json");
  const lock = JSON.parse(yield* fs.readFileString(lockPath));
  const instructions = lock.outputs.find(
    (output: { resourceId: string }) => output.resourceId === "setup:agent-instructions",
  );

  assert.isDefined(instructions);
  if (toolVersion !== undefined) lock.toolVersion = toolVersion;
  instructions.digest = yield* rawModeFileDigest(oldContent, mode);
  yield* fs.writeFileString(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  yield* fs.remove(fixture.statePath, { force: true, recursive: true });

  return fixture;
});

describe("project apply", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("plans creates without writing project state", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        const result = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.match(result.output, /\+ copy effect-ts → \.agents\/skills\/effect-ts/);
        assert.notMatch(result.output, /copy effect-atom-data-fetching|copy effect-datetime/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".agents")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, "AGENTS.md")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".dev-kit")));
      }),
    );

    it.effect("creates locked owned skills and converges without rewriting metadata", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        const first = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(first.exitCode, 0, first.output);
        assert.match(first.output, /Dev kit ready 1 change/);
        assert.isTrue(
          yield* fs.exists(path.join(projectDir, ".agents", "skills", "effect-ts", "SKILL.md")),
        );

        const lockPath = path.join(projectDir, "dev-kit.lock.json");
        const statePath = path.join(projectDir, ".dev-kit", "state.json");
        const firstLock = yield* fs.readFileString(lockPath);
        const firstState = yield* fs.readFileString(statePath);
        const lock = JSON.parse(firstLock);

        assert.deepEqual(
          lock.outputs.map((output: { resourceId: string; path: string }) => [
            output.resourceId,
            output.path,
          ]),
          [["skill:effect-ts@agents", ".agents/skills/effect-ts"]],
        );

        const second = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(second.exitCode, 0, second.output);
        assert.match(second.output, /Dev kit up to date/);
        assert.strictEqual(yield* fs.readFileString(lockPath), firstLock);
        assert.strictEqual(yield* fs.readFileString(statePath), firstState);
      }),
    );

    it.effect("runs the Effect tsgo setup once with a hoisted npm toolchain", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* installFakeEffectTsgo(projectDir);
        yield* writeManifest(projectDir, { effectTsgoEnabled: true });
        const marker = path.join(projectDir, "tsgo-patch-count.txt");

        const planned = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.strictEqual(planned.exitCode, 0, planned.output);
        assert.match(
          planned.output,
          /TypeScript patch @effect\/tsgo@0\.24\.3 → typescript@7\.0\.2/,
        );
        assert.isFalse(yield* fs.exists(marker));

        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(applied.exitCode, 0, applied.output);
        assert.match(applied.output, /✓ Dev kit ready 2 changes/);
        assert.notMatch(applied.output, /Verification succeeded|Backed up original binary/);
        assert.strictEqual(yield* fs.readFileString(marker), "1");

        const lockPath = path.join(projectDir, "dev-kit.lock.json");
        const lock = JSON.parse(yield* fs.readFileString(lockPath));

        assert.deepEqual(lock.setup.effectTsgo, {
          effectTsgoVersion: EFFECT_TSGO_VERSION,
          typescriptPackage: "typescript",
          typescriptVersion: EFFECT_TSGO_TYPESCRIPT_VERSION,
        });

        const postinstall = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);

        assert.strictEqual(postinstall.exitCode, 0, postinstall.output);
        assert.match(postinstall.output, /Dev kit up to date/);
        assert.strictEqual(yield* fs.readFileString(marker), "1");

        lock.setup.effectTsgo.effectTsgoVersion = "0.0.0";
        yield* fs.writeFileString(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
        const mismatched = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);

        assert.notStrictEqual(mismatched.exitCode, 0);
        assert.match(mismatched.output, /manifest or packaged skills differ/);
      }),
    );

    it.effect("preserves and reports an unknown destination", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const destination = path.join(projectDir, ".agents", "skills", "effect-ts");

        yield* fs.makeDirectory(destination, { recursive: true });
        yield* fs.writeFileString(path.join(destination, "keep.txt"), "user content\n");

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /plan has 1 conflict:[\s\S]*\.agents\/skills\/effect-ts/);
        assert.strictEqual(
          yield* fs.readFileString(path.join(destination, "keep.txt")),
          "user content\n",
        );
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
      }),
    );

    it.effect("cleans only an unchanged owned skill when its target is disabled", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        const unrelated = path.join(projectDir, ".agents", "skills", "local-skill");

        yield* fs.makeDirectory(unrelated, { recursive: true });
        yield* fs.writeFileString(path.join(unrelated, "SKILL.md"), "local\n");
        yield* writeManifest(projectDir, { agentsEnabled: false });

        const planned = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.strictEqual(planned.exitCode, 0, planned.output);
        assert.match(planned.output, /− skill:effect-ts@agents/);
        assert.isTrue(yield* fs.exists(path.join(projectDir, ".agents", "skills", "effect-ts")));

        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(applied.exitCode, 0, applied.output);
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".agents", "skills", "effect-ts")));
        assert.strictEqual(yield* fs.readFileString(path.join(unrelated, "SKILL.md")), "local\n");
        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(path.join(projectDir, "dev-kit.lock.json"))).outputs,
          [],
        );
      }),
    );

    it.effect("preserves modified stale owned skills as conflicts", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        const skillDocument = path.join(projectDir, ".agents", "skills", "effect-ts", "SKILL.md");

        yield* fs.writeFileString(
          skillDocument,
          `${yield* fs.readFileString(skillDocument)}\nlocal edit\n`,
        );
        yield* writeManifest(projectDir, { agentsEnabled: false });

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /stale owned destination was modified/);
        assert.match(yield* fs.readFileString(skillDocument), /local edit/);
        assert.lengthOf(
          JSON.parse(yield* fs.readFileString(path.join(projectDir, "dev-kit.lock.json"))).outputs,
          1,
        );
      }),
    );

    it.effect("adopts an exact locked output when local state is absent", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        yield* fs.remove(path.join(projectDir, ".dev-kit"), {
          force: true,
          recursive: true,
        });

        const result = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.match(result.output, /Dev kit ready/);
        assert.isTrue(yield* fs.exists(path.join(projectDir, ".dev-kit", "state.json")));
      }),
    );

    it.effect("updates an unchanged pre-normalization lock without local state", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fixture = yield* createLockedInstructionFixture(0o600, "0.6.0");
        const result = yield* runDevKit(fixture.projectDir, [
          "apply",
          "--project-dir",
          fixture.projectDir,
        ]);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.notInclude(yield* fs.readFileString(fixture.instructionsPath), "old release");
      }),
    );

    it.effect("updates a locked output after packaged content changes without local state", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fixture = yield* createLockedInstructionFixture(0o644);
        const result = yield* runDevKit(fixture.projectDir, [
          "apply",
          "--project-dir",
          fixture.projectDir,
        ]);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.notInclude(yield* fs.readFileString(fixture.instructionsPath), "old release");
      }),
    );

    it.effect("preserves a locked output modified without local state", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fixture = yield* createInstructionProject();

        yield* fs.writeFileString(
          fixture.instructionsPath,
          `${yield* fs.readFileString(fixture.instructionsPath)}local edit\n`,
        );
        yield* fs.remove(fixture.statePath, { force: true, recursive: true });

        const result = yield* runDevKit(fixture.projectDir, [
          "apply",
          "--project-dir",
          fixture.projectDir,
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /destination exists but is not owned/);
        assert.include(yield* fs.readFileString(fixture.instructionsPath), "local edit");
      }),
    );

    it.effect("retains relative-link semantics for symlink targets", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* writeManifest(projectDir, { claudeEnabled: true });

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(result.exitCode, 0, result.output);
        const link = path.join(projectDir, ".claude", "skills", "effect-ts");

        assert.strictEqual(
          yield* fs.readLink(link),
          path.relative(
            path.dirname(link),
            path.join(projectDir, ".agents", "skills", "effect-ts"),
          ),
        );
      }),
    );

    it.effect("manages a dev-kit AGENTS.md wrapper and Claude link", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* writeManifest(projectDir, {
          agentInstructionsEnabled: true,
          claudeInstructionsEnabled: true,
        });

        const planned = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.strictEqual(planned.exitCode, 0, planned.output);
        assert.match(planned.output, /\+ copy templates\/AGENTS\.md → AGENTS\.md/);
        assert.match(planned.output, /\+ link AGENTS\.md → CLAUDE\.md/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, "AGENTS.md")));

        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(applied.exitCode, 0, applied.output);
        const instructions = yield* fs.readFileString(path.join(projectDir, "AGENTS.md"));

        assert.match(instructions, /This project uses `@danieljvdm\/dev-kit`/);
        assert.match(
          instructions,
          /node_modules\/@danieljvdm\/dev-kit\/skills\/dev-kit\/SKILL\.md/,
        );
        assert.notMatch(instructions, /VITE PLUS START/);
        assert.strictEqual(yield* fs.readLink(path.join(projectDir, "CLAUDE.md")), "AGENTS.md");

        const lockPath = path.join(projectDir, "dev-kit.lock.json");
        const statePath = path.join(projectDir, ".dev-kit", "state.json");
        const firstLock = yield* fs.readFileString(lockPath);
        const firstState = yield* fs.readFileString(statePath);
        const outputs = JSON.parse(firstLock).outputs;
        const agentOutput = outputs.find(
          (output: { resourceId: string }) => output.resourceId === "setup:agent-instructions",
        );

        assert.deepInclude(agentOutput, {
          resourceId: "setup:agent-instructions",
          path: "AGENTS.md",
          sourcePath: "templates/AGENTS.md",
          mode: "copy",
          kind: "file",
        });
        assert.isTrue(
          outputs.some(
            (output: { resourceId: string }) => output.resourceId === "setup:claude-instructions",
          ),
        );

        const converged = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);

        assert.strictEqual(converged.exitCode, 0, converged.output);
        assert.match(converged.output, /Dev kit up to date/);
        assert.strictEqual(yield* fs.readFileString(lockPath), firstLock);
        assert.strictEqual(yield* fs.readFileString(statePath), firstState);
      }),
    );

    it.effect("includes Vite+ instructions only for a direct dependency", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directProject = yield* createProject();

        yield* writeManifest(directProject, { agentInstructionsEnabled: true });
        yield* writeProjectPackage(directProject, {
          devDependencies: { "vite-plus": "0.2.6" },
        });
        const viteInstructions = "<!--VITE PLUS START-->\n\n# Vite+ Test\n\n<!--VITE PLUS END-->\n";

        yield* installFakeVitePlusInstructions(directProject, viteInstructions);

        const direct = yield* runDevKit(directProject, ["apply", "--project-dir", directProject]);

        assert.strictEqual(direct.exitCode, 0, direct.output);
        assert.isTrue(
          (yield* fs.readFileString(path.join(directProject, "AGENTS.md"))).endsWith(
            viteInstructions,
          ),
        );

        const transitiveProject = yield* createProject();

        yield* writeManifest(transitiveProject, { agentInstructionsEnabled: true });
        yield* writeProjectPackage(transitiveProject, { dependencies: {} });
        yield* installFakeVitePlusInstructions(transitiveProject, viteInstructions);
        const transitive = yield* runDevKit(transitiveProject, [
          "apply",
          "--project-dir",
          transitiveProject,
        ]);

        assert.strictEqual(transitive.exitCode, 0, transitive.output);
        assert.notMatch(
          yield* fs.readFileString(path.join(transitiveProject, "AGENTS.md")),
          /VITE PLUS START/,
        );
      }),
    );

    it.effect("requires installed Vite+ instructions for a declared dependency", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* writeManifest(projectDir, { agentInstructionsEnabled: true });
        yield* writeProjectPackage(projectDir, { dependencies: { "vite-plus": "0.2.6" } });

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(
          result.output,
          /Vite\+ is a direct dependency.*node_modules\/vite-plus\/AGENTS\.md/,
        );
        assert.isFalse(yield* fs.exists(path.join(projectDir, "AGENTS.md")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
      }),
    );

    it.effect("preserves an unowned AGENTS.md wrapper destination", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* fs.writeFileString(path.join(projectDir, "AGENTS.md"), "custom\n");
        yield* writeManifest(projectDir, { agentInstructionsEnabled: true });

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /AGENTS\.md: destination exists but is not owned/);
        assert.strictEqual(
          yield* fs.readFileString(path.join(projectDir, "AGENTS.md")),
          "custom\n",
        );
      }),
    );

    it.effect("updates and removes only an unchanged owned AGENTS.md wrapper", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* writeManifest(projectDir, { agentInstructionsEnabled: true });
        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );

        yield* writeProjectPackage(projectDir, { devDependencies: { "vite-plus": "0.2.6" } });
        yield* installFakeVitePlusInstructions(
          projectDir,
          "<!--VITE PLUS START-->\nupdated\n<!--VITE PLUS END-->\n",
        );
        const updated = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(updated.exitCode, 0, updated.output);
        assert.match(yield* fs.readFileString(path.join(projectDir, "AGENTS.md")), /updated/);

        yield* writeManifest(projectDir);
        const removed = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(removed.exitCode, 0, removed.output);
        assert.isFalse(yield* fs.exists(path.join(projectDir, "AGENTS.md")));
      }),
    );

    it.effect("preserves a modified owned AGENTS.md wrapper", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* writeManifest(projectDir, { agentInstructionsEnabled: true });
        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        yield* fs.writeFileString(path.join(projectDir, "AGENTS.md"), "customized\n");
        yield* writeManifest(projectDir);

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /AGENTS\.md: stale owned destination was modified/);
        assert.strictEqual(
          yield* fs.readFileString(path.join(projectDir, "AGENTS.md")),
          "customized\n",
        );
      }),
    );

    it.effect("rejects Vite+ instruction drift in locked mode", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* writeManifest(projectDir, { agentInstructionsEnabled: true });
        yield* writeProjectPackage(projectDir, { devDependencies: { "vite-plus": "0.2.6" } });
        yield* installFakeVitePlusInstructions(projectDir, "first\n");
        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        yield* installFakeVitePlusInstructions(projectDir, "second\n");

        const result = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /packaged skills differ from dev-kit\.lock\.json/);
        assert.match(yield* fs.readFileString(path.join(projectDir, "AGENTS.md")), /first/);
        assert.notMatch(yield* fs.readFileString(path.join(projectDir, "AGENTS.md")), /second/);
      }),
    );

    it.effect("does not remove an AGENTS.md wrapper while Claude still links to it", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* writeManifest(projectDir, {
          agentInstructionsEnabled: true,
          claudeInstructionsEnabled: true,
        });
        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        yield* writeManifest(projectDir, { claudeInstructionsEnabled: true });

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(
          result.output,
          /cannot disable agentInstructions while claudeInstructions still links/,
        );
        assert.isTrue(yield* fs.exists(path.join(projectDir, "AGENTS.md")));
        assert.strictEqual(yield* fs.readLink(path.join(projectDir, "CLAUDE.md")), "AGENTS.md");
      }),
    );

    it.effect("manages a portable CLAUDE.md link to AGENTS.md", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* fs.writeFileString(path.join(projectDir, "AGENTS.md"), "# Instructions\n");
        yield* writeManifest(projectDir, { claudeInstructionsEnabled: true });

        const planned = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.strictEqual(planned.exitCode, 0, planned.output);
        assert.match(planned.output, /\+ link AGENTS\.md → CLAUDE\.md/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, "CLAUDE.md")));

        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(applied.exitCode, 0, applied.output);
        assert.strictEqual(yield* fs.readLink(path.join(projectDir, "CLAUDE.md")), "AGENTS.md");
        const lockPath = path.join(projectDir, "dev-kit.lock.json");
        const statePath = path.join(projectDir, ".dev-kit", "state.json");
        const firstLock = yield* fs.readFileString(lockPath);
        const firstState = yield* fs.readFileString(statePath);
        const instructionOutput = JSON.parse(firstLock).outputs.find(
          (output: { resourceId: string }) => output.resourceId === "setup:claude-instructions",
        );

        assert.deepEqual(instructionOutput, {
          resourceId: "setup:claude-instructions",
          path: "CLAUDE.md",
          sourcePath: "AGENTS.md",
          mode: "symlink",
          kind: "symlink",
          digest: instructionOutput.digest,
        });

        const converged = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);

        assert.strictEqual(converged.exitCode, 0, converged.output);
        assert.match(converged.output, /Dev kit up to date/);
        assert.strictEqual(yield* fs.readFileString(lockPath), firstLock);
        assert.strictEqual(yield* fs.readFileString(statePath), firstState);
      }),
    );

    it.effect("requires AGENTS.md before managing Claude instructions", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* writeManifest(projectDir, { claudeInstructionsEnabled: true });

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /source is not a regular file: AGENTS\.md/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, "CLAUDE.md")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
      }),
    );

    it.effect("preserves an unowned CLAUDE.md", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* fs.writeFileString(path.join(projectDir, "AGENTS.md"), "agents\n");
        yield* fs.writeFileString(path.join(projectDir, "CLAUDE.md"), "claude\n");
        yield* writeManifest(projectDir, { claudeInstructionsEnabled: true });

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /CLAUDE\.md: destination exists but is not owned/);
        assert.strictEqual(
          yield* fs.readFileString(path.join(projectDir, "CLAUDE.md")),
          "claude\n",
        );
      }),
    );

    it.effect("does not adopt an unowned exact Claude instructions link", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* fs.writeFileString(path.join(projectDir, "AGENTS.md"), "agents\n");
        yield* fs.symlink("AGENTS.md", path.join(projectDir, "CLAUDE.md"));
        yield* writeManifest(projectDir, { claudeInstructionsEnabled: true });

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /CLAUDE\.md: destination exists but is not owned/);
        assert.strictEqual(yield* fs.readLink(path.join(projectDir, "CLAUDE.md")), "AGENTS.md");
      }),
    );

    it.effect("removes only an unchanged owned Claude instructions link", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* fs.writeFileString(path.join(projectDir, "AGENTS.md"), "agents\n");
        yield* writeManifest(projectDir, { claudeInstructionsEnabled: true });
        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );

        yield* writeManifest(projectDir);
        const planned = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.strictEqual(planned.exitCode, 0, planned.output);
        assert.match(planned.output, /− setup:claude-instructions → CLAUDE\.md/);
        const removed = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(removed.exitCode, 0, removed.output);
        assert.isFalse(yield* fs.exists(path.join(projectDir, "CLAUDE.md")));
      }),
    );

    it.effect("preserves a modified owned Claude instructions link", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* fs.writeFileString(path.join(projectDir, "AGENTS.md"), "agents\n");
        yield* writeManifest(projectDir, { claudeInstructionsEnabled: true });
        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        yield* fs.remove(path.join(projectDir, "CLAUDE.md"));
        yield* fs.symlink("OTHER.md", path.join(projectDir, "CLAUDE.md"));
        yield* writeManifest(projectDir);

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /CLAUDE\.md: stale owned destination was modified/);
        assert.strictEqual(yield* fs.readLink(path.join(projectDir, "CLAUDE.md")), "OTHER.md");
      }),
    );

    it.effect("rejects manifest drift in locked mode without cleanup", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        yield* writeManifest(projectDir, { agentsEnabled: false });

        const result = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /manifest or packaged skills differ/);
        assert.isTrue(yield* fs.exists(path.join(projectDir, ".agents", "skills", "effect-ts")));
        assert.lengthOf(
          JSON.parse(yield* fs.readFileString(path.join(projectDir, "dev-kit.lock.json"))).outputs,
          1,
        );
      }),
    );

    it.effect("migrates local ownership state from a previously applied lock", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const nextProjectDir = yield* createProject();

        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        yield* writeManifest(projectDir, { agentsEnabled: false });
        yield* writeManifest(nextProjectDir, { agentsEnabled: false });
        assert.strictEqual(
          (yield* runDevKit(nextProjectDir, ["apply", "--project-dir", nextProjectDir])).exitCode,
          0,
        );
        yield* fs.copyFile(
          path.join(nextProjectDir, "dev-kit.lock.json"),
          path.join(projectDir, "dev-kit.lock.json"),
        );

        const result = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.match(result.output, /Dev kit ready 1 change/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".agents", "skills", "effect-ts")));
        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(path.join(projectDir, ".dev-kit", "state.json")))
            .outputs,
          [],
        );
      }),
    );

    it.effect("rejects lockfile paths overlapping metadata or managed outputs", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        for (const lockfile of [
          ".dev-kit/state.json",
          ".agents/skills/effect-ts/dev-kit.lock.json",
        ]) {
          const projectDir = yield* createProject();
          const result = yield* runDevKit(projectDir, [
            "apply",
            "--lockfile",
            lockfile,
            "--project-dir",
            projectDir,
          ]);

          assert.notStrictEqual(result.exitCode, 0);
          assert.match(result.output, /overlaps/);
          assert.isFalse(yield* fs.exists(path.join(projectDir, ".agents")));
        }
      }),
    );

    it.effect("does not adopt a pre-existing exact tree without a lock", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const root = yield* repositoryRoot();
        const destination = path.join(projectDir, ".agents", "skills", "effect-ts");

        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fs.copy(path.join(root, "skills", "effect-ts"), destination);

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /destination exists but is not owned/);
      }),
    );

    it.effect("refuses to mutate while another apply lock exists", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const processLock = path.join(projectDir, ".dev-kit", "apply.lock");

        yield* fs.makeDirectory(processLock, { recursive: true });
        yield* fs.writeFileString(path.join(processLock, "owner.json"), '{"token":"other"}\n');

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /another dev-kit operation may be active/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".agents")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
        assert.strictEqual(
          yield* fs.readFileString(path.join(processLock, "owner.json")),
          '{"token":"other"}\n',
        );
      }),
    );

    it.effect("rolls back installed outputs after a late apply failure", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const blockedParent = path.join(projectDir, "blocked");

        yield* fs.writeFileString(blockedParent, "not a directory\n");

        const result = yield* runDevKit(projectDir, [
          "apply",
          "--lockfile",
          "blocked/dev-kit.lock.json",
          "--project-dir",
          projectDir,
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".agents", "skills", "effect-ts")));
        assert.strictEqual(yield* fs.readFileString(blockedParent), "not a directory\n");
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".dev-kit", "state.json")));
        assert.isFalse(yield* fs.exists(path.join(projectDir, ".dev-kit", "apply.lock")));
      }),
    );

    it.effect("rejects symlink ancestors without touching their targets", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const externalDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-external-test-",
        });

        yield* fs.writeFileString(path.join(externalDir, "keep.txt"), "external content\n");
        yield* fs.symlink(externalDir, path.join(projectDir, ".agents"));

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /ancestor is a symlink/);
        assert.strictEqual(
          yield* fs.readFileString(path.join(externalDir, "keep.txt")),
          "external content\n",
        );
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
      }),
    );
  });
});
