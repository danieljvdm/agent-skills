import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { EFFECT_TSGO_TYPESCRIPT_VERSION, EFFECT_TSGO_VERSION } from "../src/effect-tsgo.ts";
import {
  VITE_PLUS_CONFIG_PATH,
  VITE_PLUS_CONFIG_TEMPLATE,
  VITE_PLUS_GITHUB_ACTIONS_PATH,
  VITE_PLUS_GITHUB_ACTIONS_TEMPLATE,
} from "../src/vite-plus-quality.ts";
import { repositoryRoot, runCommandSuccess, runDevKit } from "./test-platform.ts";

const writePackageVersion = Effect.fn("writeQualityTestPackageVersion")(function* (
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

const installSupportedToolchain = Effect.fn("installQualityTestToolchain")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* writePackageVersion(projectDir, "@effect/tsgo", EFFECT_TSGO_VERSION);
  yield* writePackageVersion(projectDir, "typescript", EFFECT_TSGO_TYPESCRIPT_VERSION);
  const platform = "test-platform";
  const typescriptPlatformPackage = `@typescript/typescript-${platform}`;
  const effectPlatformPackage = `@effect/tsgo-${platform}`;

  yield* writePackageVersion(projectDir, typescriptPlatformPackage, EFFECT_TSGO_TYPESCRIPT_VERSION);
  yield* writePackageVersion(projectDir, effectPlatformPackage, EFFECT_TSGO_VERSION);
  const typescriptLib = path.join(
    projectDir,
    "node_modules",
    "@typescript",
    `typescript-${platform}`,
    "lib",
  );
  const effectLib = path.join(projectDir, "node_modules", "@effect", `tsgo-${platform}`, "lib");

  yield* fs.makeDirectory(typescriptLib, { recursive: true });
  yield* fs.makeDirectory(effectLib, { recursive: true });
  yield* fs.writeFileString(path.join(typescriptLib, "tsc"), "original\n");
  yield* fs.writeFileString(path.join(effectLib, "tsc"), "patched\n");
  const binDir = path.join(projectDir, "node_modules", ".bin");

  yield* fs.makeDirectory(binDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(binDir, "effect-tsgo"),
    `#!/bin/sh
set -eu
cp "$PWD/node_modules/${effectPlatformPackage}/lib/tsc" "$PWD/node_modules/${typescriptPlatformPackage}/lib/tsc"
`,
    { mode: 0o755 },
  );
  yield* fs.writeFileString(path.join(binDir, "vp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});

const writeFixture = Effect.fn("writeQualityTestFixture")(function* (
  projectDir: string,
  options: {
    readonly quality?: boolean;
    readonly effectTsgo?: boolean;
    readonly packageScripts?: Readonly<Record<string, string>>;
    readonly completeDependencies?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const completeDependencies = options.completeDependencies ?? true;

  yield* fs.writeFileString(
    path.join(projectDir, "dev-kit.jsonc"),
    `${JSON.stringify(
      {
        include: [],
        setup: {
          effectTsgo: { enabled: options.effectTsgo ?? true },
          vitePlus: { quality: { enabled: options.quality ?? true } },
        },
        targets: { agents: { enabled: false } },
      },
      null,
      2,
    )}\n`,
  );
  yield* fs.writeFileString(
    path.join(projectDir, "package.json"),
    `${JSON.stringify(
      {
        name: "quality-fixture",
        scripts: options.packageScripts ?? {},
        dependencies: completeDependencies
          ? { "@danieljvdm/dev-kit": "0.6.0", effect: "4.0.0-beta.102" }
          : {},
        devDependencies: completeDependencies
          ? {
              "@effect/tsgo": EFFECT_TSGO_VERSION,
              typescript: EFFECT_TSGO_TYPESCRIPT_VERSION,
              "vite-plus": "0.2.6",
            }
          : { "vite-plus": "0.2.6" },
      },
      null,
      2,
    )}\n`,
  );
});

const createFixture = Effect.fn("createQualityTestFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-quality-test-" });

  yield* runCommandSuccess(projectDir, "git", ["init", "--initial-branch", "main"]);
  yield* writeFixture(projectDir);
  yield* installSupportedToolchain(projectDir);

  return projectDir;
});

describe("Vite+ quality setup", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("does nothing until the repository opts in", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createFixture();

        yield* writeFixture(projectDir, { quality: false });
        const result = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.notMatch(result.output, /templates\/vite-plus/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, VITE_PLUS_CONFIG_PATH)));
        assert.isFalse(yield* fs.exists(path.join(projectDir, VITE_PLUS_GITHUB_ACTIONS_PATH)));
      }),
    );

    it.effect("plans, owns, locks, and removes the canonical quality files", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createFixture();
        const root = yield* repositoryRoot();
        const planned = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.strictEqual(planned.exitCode, 0, planned.output);
        assert.match(planned.output, /copy templates\/vite-plus\/github-actions-check\.yml/);
        assert.match(planned.output, /copy templates\/vite-plus\/vite\.config\.ts/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, VITE_PLUS_CONFIG_PATH)));
        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(applied.exitCode, 0, applied.output);
        assert.strictEqual(
          yield* fs.readFileString(path.join(projectDir, VITE_PLUS_CONFIG_PATH)),
          yield* fs.readFileString(path.join(root, VITE_PLUS_CONFIG_TEMPLATE)),
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(projectDir, VITE_PLUS_GITHUB_ACTIONS_PATH)),
          yield* fs.readFileString(path.join(root, VITE_PLUS_GITHUB_ACTIONS_TEMPLATE)),
        );
        const lock = JSON.parse(
          yield* fs.readFileString(path.join(projectDir, "dev-kit.lock.json")),
        );

        assert.deepEqual(
          lock.outputs.map((output: { resourceId: string; path: string }) => [
            output.resourceId,
            output.path,
          ]),
          [
            ["setup:vite-plus-github-actions", VITE_PLUS_GITHUB_ACTIONS_PATH],
            ["setup:vite-plus-config", VITE_PLUS_CONFIG_PATH],
          ],
        );
        const converged = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);

        assert.strictEqual(converged.exitCode, 0, converged.output);
        yield* writeFixture(projectDir, { quality: false });
        const removed = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(removed.exitCode, 0, removed.output);
        assert.isFalse(yield* fs.exists(path.join(projectDir, VITE_PLUS_CONFIG_PATH)));
        assert.isFalse(yield* fs.exists(path.join(projectDir, VITE_PLUS_GITHUB_ACTIONS_PATH)));
      }),
    );

    it.effect("preserves an unsupported existing Vite config", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createFixture();
        const custom = "export default { custom: true };\n";

        yield* fs.writeFileString(path.join(projectDir, VITE_PLUS_CONFIG_PATH), custom);
        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /vite\.config\.ts: destination exists but is not owned/);
        assert.strictEqual(
          yield* fs.readFileString(path.join(projectDir, VITE_PLUS_CONFIG_PATH)),
          custom,
        );
        assert.isFalse(yield* fs.exists(path.join(projectDir, VITE_PLUS_GITHUB_ACTIONS_PATH)));
      }),
    );

    it.effect("adopts exact canonical files without overwriting them", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createFixture();
        const root = yield* repositoryRoot();

        for (const [destination, template] of [
          [VITE_PLUS_CONFIG_PATH, VITE_PLUS_CONFIG_TEMPLATE],
          [VITE_PLUS_GITHUB_ACTIONS_PATH, VITE_PLUS_GITHUB_ACTIONS_TEMPLATE],
        ] as const) {
          const destinationPath = path.join(projectDir, destination);

          yield* fs.makeDirectory(path.dirname(destinationPath), { recursive: true });
          yield* fs.writeFileString(
            destinationPath,
            yield* fs.readFileString(path.join(root, template)),
          );
        }
        const planned = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.strictEqual(planned.exitCode, 0, planned.output);
        assert.match(planned.output, /github-actions-check\.yml.*\(adopt\)/);
        assert.match(planned.output, /vite\.config\.ts.*\(adopt\)/);
        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(applied.exitCode, 0, applied.output);
        assert.isTrue(yield* fs.exists(path.join(projectDir, "dev-kit.lock.json")));
      }),
    );

    it.effect("preserves modified owned files when quality setup is disabled", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createFixture();
        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(applied.exitCode, 0, applied.output);
        const configPath = path.join(projectDir, VITE_PLUS_CONFIG_PATH);
        const modified = `${yield* fs.readFileString(configPath)}// user change\n`;

        yield* fs.writeFileString(configPath, modified);
        yield* writeFixture(projectDir, { quality: false });
        const result = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.output, /stale owned destination was modified/);
        assert.strictEqual(yield* fs.readFileString(configPath), modified);
        assert.isTrue(yield* fs.exists(path.join(projectDir, VITE_PLUS_GITHUB_ACTIONS_PATH)));
      }),
    );

    it.effect("rejects repositories that did not opt into or cannot support the setup", () =>
      Effect.gen(function* () {
        const projectDir = yield* createFixture();

        yield* writeFixture(projectDir, { effectTsgo: false });
        const disabled = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.notStrictEqual(disabled.exitCode, 0);
        assert.match(disabled.output, /requires setup\.effectTsgo\.enabled/);
        yield* writeFixture(projectDir, { completeDependencies: false });
        const unsupported = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.notStrictEqual(unsupported.exitCode, 0);
        assert.match(unsupported.output, /requires direct dependencies/);
        yield* writeFixture(projectDir, { packageScripts: { check: "custom" } });
        const conflicting = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.notStrictEqual(conflicting.exitCode, 0);
        assert.match(conflicting.output, /conflict with package scripts: check/);
      }),
    );
  });
});
