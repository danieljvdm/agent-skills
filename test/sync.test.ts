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
  readonly devKitEnabled?: boolean;
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
        include: ["effect", ...(options.devKitEnabled ? ["dev-kit"] : [])],
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
        assert.match(
          result.output,
          /\+ copy build-effect-apis → \.agents\/skills\/build-effect-apis/,
        );
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
        assert.match(first.output, /Dev kit ready 2 changes/);
        assert.isTrue(
          yield* fs.exists(
            path.join(projectDir, ".agents", "skills", "build-effect-apis", "SKILL.md"),
          ),
        );
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
          [
            ["skill:build-effect-apis@agents", ".agents/skills/build-effect-apis"],
            ["skill:effect-ts@agents", ".agents/skills/effect-ts"],
          ],
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
        assert.include(
          planned.output,
          `TypeScript patch @effect/tsgo@${EFFECT_TSGO_VERSION} → typescript@${EFFECT_TSGO_TYPESCRIPT_VERSION}`,
        );
        assert.isFalse(yield* fs.exists(marker));

        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(applied.exitCode, 0, applied.output);
        assert.match(applied.output, /✓ Dev kit ready 3 changes/);
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
        assert.match(planned.output, /− skill:build-effect-apis@agents/);
        assert.match(planned.output, /− skill:effect-ts@agents/);
        assert.isTrue(
          yield* fs.exists(path.join(projectDir, ".agents", "skills", "build-effect-apis")),
        );
        assert.isTrue(yield* fs.exists(path.join(projectDir, ".agents", "skills", "effect-ts")));

        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(applied.exitCode, 0, applied.output);
        assert.isFalse(
          yield* fs.exists(path.join(projectDir, ".agents", "skills", "build-effect-apis")),
        );
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
          2,
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

    it.effect("does not adopt exact managed sections without a receipt or lock", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* createInstructionProject();

        yield* fs.remove(path.join(fixture.projectDir, "dev-kit.lock.json"));
        yield* fs.remove(fixture.statePath, { recursive: true });
        yield* fs.remove(path.join(fixture.projectDir, ".agents"), { recursive: true });

        const result = yield* runDevKit(fixture.projectDir, [
          "apply",
          "--project-dir",
          fixture.projectDir,
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /managed instruction sections exist but are not owned/);
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

    it.effect(
      "preserves handwritten content added outside managed sections without local state",
      () =>
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

          assert.strictEqual(result.exitCode, 0, result.output);
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

    it.effect("manages Dev Kit AGENTS.md sections and a Claude link", () =>
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

    it.effect("points agent instructions at the managed Dev Kit skill", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* writeManifest(projectDir, {
          agentInstructionsEnabled: true,
          devKitEnabled: true,
        });

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        const instructions = yield* fs.readFileString(path.join(projectDir, "AGENTS.md"));

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.include(instructions, ".agents/skills/dev-kit/SKILL.md");
        assert.notInclude(instructions, "node_modules/");
      }),
    );

    it.effect("routes non-Vite quality commands through package scripts", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* writeManifest(projectDir, { agentInstructionsEnabled: true });
        yield* writeProjectPackage(projectDir, {
          packageManager: "bun@1.3.14",
          scripts: {
            check: "project check",
            fmt: "project fmt",
            format: "project format",
            lint: "project lint",
            test: "project test",
            "test:unit": "project unit tests",
            typecheck: "project typecheck",
          },
        });

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        const instructions = yield* fs.readFileString(path.join(projectDir, "AGENTS.md"));

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.include(instructions, "Bun is the package-script runner");
        assert.include(instructions, "Install dependencies with Bun: `bun install`");
        assert.include(instructions, "Full validation: `bun run check`");
        assert.include(instructions, "Format: `bun run format`");
        assert.include(instructions, "Script `fmt`: `bun run fmt`");
        assert.include(instructions, "Lint: `bun run lint`");
        assert.include(instructions, "Tests: `bun run test`");
        assert.include(instructions, "Script `test:unit`: `bun run test:unit`");
        assert.include(instructions, "Typecheck: `bun run typecheck`");
        assert.include(instructions, "invoke underlying tools such as `tsc`");
      }),
    );

    it.effect("detects the dependency installer without changing the Bun script runner", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* writeManifest(projectDir, { agentInstructionsEnabled: true });
        yield* writeProjectPackage(projectDir, { scripts: { test: "project test" } });
        yield* fs.writeFileString(
          path.join(projectDir, "pnpm-lock.yaml"),
          "lockfileVersion: '9.0'\n",
        );

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(result.exitCode, 0, result.output);
        const instructions = yield* fs.readFileString(path.join(projectDir, "AGENTS.md"));

        assert.include(instructions, "Bun is the package-script runner");
        assert.include(instructions, "Install dependencies with pnpm: `pnpm install`");
        assert.include(instructions, "Tests: `bun run test`");
        assert.notInclude(instructions, "bun run typecheck");
        assert.include(instructions, "does not choose the package manager");
      }),
    );

    it.effect("synthesizes non-conflicting Vite+ guidance only for a direct dependency", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directProject = yield* createProject();

        yield* writeManifest(directProject, { agentInstructionsEnabled: true });
        yield* writeProjectPackage(directProject, {
          devDependencies: { "vite-plus": "0.2.6" },
          scripts: { check: "project check", typecheck: "project typecheck" },
        });

        const direct = yield* runDevKit(directProject, ["apply", "--project-dir", directProject]);

        assert.strictEqual(direct.exitCode, 0, direct.output);
        const directInstructions = yield* fs.readFileString(path.join(directProject, "AGENTS.md"));

        assert.include(directInstructions, "Vite+ is the unified toolchain and command authority");
        assert.include(directInstructions, "Vite+ is distinct from Vite");
        assert.include(directInstructions, "Run `vp help`");
        assert.include(directInstructions, "`node_modules/vite-plus/docs`");
        assert.include(directInstructions, "https://viteplus.dev/guide/");
        assert.include(directInstructions, "Install dependencies: `vp install`");
        assert.include(directInstructions, "Full validation: `vp run check`");
        assert.include(directInstructions, "Typecheck only: `vp run typecheck`");
        assert.include(directInstructions, "Tests only: `vp test`");
        assert.include(directInstructions, "run `vp env doctor`");
        assert.include(directInstructions, "Do not use `bun run`, `npm run`, `pnpm run`");
        assert.notInclude(directInstructions, "VITE PLUS START");

        const transitiveProject = yield* createProject();

        yield* writeManifest(transitiveProject, { agentInstructionsEnabled: true });
        yield* writeProjectPackage(transitiveProject, { dependencies: {} });
        const transitive = yield* runDevKit(transitiveProject, [
          "apply",
          "--project-dir",
          transitiveProject,
        ]);

        assert.strictEqual(transitive.exitCode, 0, transitive.output);
        const transitiveInstructions = yield* fs.readFileString(
          path.join(transitiveProject, "AGENTS.md"),
        );

        assert.include(transitiveInstructions, "Bun is the package-script runner");
        assert.notInclude(transitiveInstructions, "Vite+ is the unified toolchain");
      }),
    );

    it.effect("does not import installed Vite+ instructions", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* writeManifest(projectDir, { agentInstructionsEnabled: true });
        yield* writeProjectPackage(projectDir, {
          devDependencies: { "vite-plus": "0.2.6" },
        });
        yield* installFakeVitePlusInstructions(
          projectDir,
          "unmarked upstream guidance\nRun npm run everything.\n<!--VITE PLUS START-->",
        );

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        const instructions = yield* fs.readFileString(path.join(projectDir, "AGENTS.md"));

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.include(instructions, "Vite+ is the unified toolchain");
        assert.notInclude(instructions, "unmarked upstream guidance");
        assert.notInclude(instructions, "npm run everything");
        assert.notInclude(instructions, "VITE PLUS START");
      }),
    );

    it.effect("removes a legacy owned Vite+ section while preserving handwritten guidance", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const instructionsPath = path.join(projectDir, "AGENTS.md");
        const lockPath = path.join(projectDir, "dev-kit.lock.json");
        const statePath = path.join(projectDir, ".dev-kit", "state.json");
        const handwritten = "# Project guidance\n\nKeep this.\n";

        yield* fs.writeFileString(instructionsPath, handwritten);
        yield* writeManifest(projectDir, { agentInstructionsEnabled: true });
        yield* writeProjectPackage(projectDir, { dependencies: { "vite-plus": "0.2.6" } });
        const initial = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(initial.exitCode, 0, initial.output);
        const current = yield* fs.readFileString(instructionsPath);
        const devEnd = current.indexOf("<!-- DEV KIT END -->") + "<!-- DEV KIT END -->".length;
        const devSection = current.slice(0, devEnd);
        const legacySection =
          "<!--VITE PLUS START-->\n\n# Legacy Vite+ guidance\n\n<!--VITE PLUS END-->";
        const legacyManagedContent = `${legacySection}\n\n${devSection.trim()}\n`;
        const legacyDigest = yield* rawModeFileDigest(legacyManagedContent, 0o644);
        const lock = JSON.parse(yield* fs.readFileString(lockPath)) as {
          outputs: Array<{ resourceId: string; digest: string }>;
        };
        const state = JSON.parse(yield* fs.readFileString(statePath)) as {
          outputs: Array<{ resourceId: string; digest: string }>;
        };

        for (const document of [lock, state]) {
          const output = document.outputs.find(
            (candidate) => candidate.resourceId === "setup:agent-instructions",
          );

          assert.isDefined(output);
          output.digest = legacyDigest;
        }
        yield* fs.writeFileString(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
        yield* fs.writeFileString(statePath, `${JSON.stringify(state, null, 2)}\n`);
        yield* fs.writeFileString(instructionsPath, `${legacySection}\n\n${current}`);

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);
        const migrated = yield* fs.readFileString(instructionsPath);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.notInclude(migrated, "VITE PLUS START");
        assert.notInclude(migrated, "Legacy Vite+ guidance");
        assert.include(migrated, "Vite+ is the unified toolchain");
        assert.isTrue(migrated.endsWith(handwritten));
      }),
    );

    it.effect("adds managed instructions to an existing handwritten AGENTS.md", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const handwritten = "# Project guidance\n\nKeep this.\n";

        yield* fs.writeFileString(path.join(projectDir, "AGENTS.md"), handwritten);
        yield* fs.chmod(path.join(projectDir, "AGENTS.md"), 0o600);
        yield* writeManifest(projectDir, { agentInstructionsEnabled: true });

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(result.exitCode, 0, result.output);
        const instructions = yield* fs.readFileString(path.join(projectDir, "AGENTS.md"));

        assert.isTrue(instructions.startsWith("<!-- DEV KIT START -->"));
        assert.isTrue(instructions.endsWith(handwritten));
        assert.include(instructions, "## Project command policy");
        assert.strictEqual(
          (yield* fs.stat(path.join(projectDir, "AGENTS.md"))).mode & 0o777,
          0o600,
        );
      }),
    );

    it.effect("refuses ambiguous managed instruction markers", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const ambiguous = "<!-- DEV KIT START -->\ncustom\n";

        yield* fs.writeFileString(path.join(projectDir, "AGENTS.md"), ambiguous);
        yield* writeManifest(projectDir, { agentInstructionsEnabled: true });

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /expected exactly one.*DEV KIT START.*DEV KIT END/);
        assert.strictEqual(yield* fs.readFileString(path.join(projectDir, "AGENTS.md")), ambiguous);
        assert.isFalse(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
      }),
    );

    it.effect("removes only managed sections when agent instructions are disabled", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();
        const handwritten = "# Project guidance\n\nKeep this.\n";

        yield* fs.writeFileString(path.join(projectDir, "AGENTS.md"), handwritten);
        yield* fs.chmod(path.join(projectDir, "AGENTS.md"), 0o600);
        yield* writeManifest(projectDir, { agentInstructionsEnabled: true });
        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        const amended = `Important.\n\n${handwritten}`;

        yield* fs.writeFileString(
          path.join(projectDir, "AGENTS.md"),
          (yield* fs.readFileString(path.join(projectDir, "AGENTS.md"))).replace(
            handwritten,
            amended,
          ),
        );
        yield* writeManifest(projectDir);

        const removed = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(removed.exitCode, 0, removed.output);
        assert.strictEqual(yield* fs.readFileString(path.join(projectDir, "AGENTS.md")), amended);
        assert.strictEqual(
          (yield* fs.stat(path.join(projectDir, "AGENTS.md"))).mode & 0o777,
          0o600,
        );
      }),
    );

    it.effect("preserves handwritten trailing whitespace after managed section cleanup", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        for (const handwritten of [
          "# Handwritten",
          "# Handwritten\n",
          "# Handwritten\n\n",
          "# Handwritten\n\n\n",
          "# Handwritten\r\n\r\n",
        ]) {
          const projectDir = yield* createProject();

          yield* fs.writeFileString(path.join(projectDir, "AGENTS.md"), handwritten);
          yield* writeManifest(projectDir, { agentInstructionsEnabled: true });
          assert.strictEqual(
            (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
            0,
          );
          if (handwritten === "# Handwritten\n\n\n") {
            yield* writeProjectPackage(projectDir, {
              devDependencies: { "vite-plus": "0.2.6" },
            });
            const updated = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

            assert.strictEqual(updated.exitCode, 0, updated.output);
            assert.isTrue(
              (yield* fs.readFileString(path.join(projectDir, "AGENTS.md"))).endsWith(handwritten),
            );
          }
          yield* writeManifest(projectDir);

          const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

          assert.strictEqual(result.exitCode, 0, result.output);
          assert.strictEqual(
            yield* fs.readFileString(path.join(projectDir, "AGENTS.md")),
            handwritten,
          );
        }
      }),
    );

    it.effect("updates and removes an unchanged managed-only AGENTS.md", () =>
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
        const updated = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(updated.exitCode, 0, updated.output);
        assert.include(
          yield* fs.readFileString(path.join(projectDir, "AGENTS.md")),
          "Vite+ is the unified toolchain",
        );

        yield* writeManifest(projectDir);
        const removed = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(removed.exitCode, 0, removed.output);
        assert.isFalse(yield* fs.exists(path.join(projectDir, "AGENTS.md")));
      }),
    );

    it.effect("preserves an AGENTS.md whose managed sections were removed", () =>
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

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.strictEqual(
          yield* fs.readFileString(path.join(projectDir, "AGENTS.md")),
          "customized\n",
        );
      }),
    );

    it.effect("refuses to remove modified managed instruction sections", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* writeManifest(projectDir, { agentInstructionsEnabled: true });
        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        const instructionsPath = path.join(projectDir, "AGENTS.md");

        yield* fs.writeFileString(
          instructionsPath,
          (yield* fs.readFileString(instructionsPath)).replace("# Dev Kit", "# Customized"),
        );
        yield* writeManifest(projectDir);

        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /managed instruction sections were modified/);
        assert.include(yield* fs.readFileString(instructionsPath), "# Customized");
      }),
    );

    it.effect("ignores installed Vite+ instruction drift in locked mode", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createProject();

        yield* writeManifest(projectDir, { agentInstructionsEnabled: true });
        yield* writeProjectPackage(projectDir, { devDependencies: { "vite-plus": "0.2.6" } });
        yield* installFakeVitePlusInstructions(projectDir, "first generic instructions\n");
        assert.strictEqual(
          (yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir])).exitCode,
          0,
        );
        const first = yield* fs.readFileString(path.join(projectDir, "AGENTS.md"));

        yield* installFakeVitePlusInstructions(projectDir, "second contradictory instructions\n");

        const result = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.match(result.output, /Dev kit up to date/);
        assert.strictEqual(yield* fs.readFileString(path.join(projectDir, "AGENTS.md")), first);
      }),
    );

    it.effect("does not remove a managed-only AGENTS.md while Claude still links to it", () =>
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

    it.effect(
      "removes managed sections while Claude keeps linking to handwritten instructions",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const projectDir = yield* createProject();

          yield* fs.writeFileString(path.join(projectDir, "AGENTS.md"), "# Handwritten\n");
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

          assert.strictEqual(result.exitCode, 0, result.output);
          assert.strictEqual(
            yield* fs.readFileString(path.join(projectDir, "AGENTS.md")),
            "# Handwritten\n",
          );
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
          2,
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
        assert.match(result.output, /Dev kit ready 2 changes/);
        assert.isFalse(
          yield* fs.exists(path.join(projectDir, ".agents", "skills", "build-effect-apis")),
        );
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
