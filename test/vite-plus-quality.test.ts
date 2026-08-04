import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import semver from "semver";

import { EFFECT_TSGO_TYPESCRIPT_VERSION, EFFECT_TSGO_VERSION } from "../src/effect-tsgo.ts";
import { VITE_PLUS_SUPPORTED_RANGE, VITE_PLUS_TESTED_VERSION } from "../src/tool-metadata.ts";
import {
  renderVitePlusConfigTemplate,
  renderVitePlusWorkflowTemplate,
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
  yield* writePackageVersion(projectDir, "vite-plus", VITE_PLUS_TESTED_VERSION);
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
    readonly typecheckStrategy?: "single-project" | "workspace";
    readonly typecheckConcurrency?: number;
    readonly workspaces?: ReadonlyArray<string>;
    readonly projectReferences?: boolean;
    readonly workspacePackages?: ReadonlyArray<string>;
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
          vitePlus: {
            quality: {
              enabled: options.quality ?? true,
              typecheck: {
                strategy: options.typecheckStrategy ?? "single-project",
                ...(options.typecheckConcurrency === undefined
                  ? {}
                  : { concurrency: options.typecheckConcurrency }),
                ...(options.workspacePackages === undefined
                  ? {}
                  : { packages: options.workspacePackages }),
              },
            },
          },
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
        ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
        dependencies: completeDependencies
          ? { "@danieljvdm/dev-kit": "0.6.0", effect: "4.0.0-beta.102" }
          : {},
        devDependencies: completeDependencies
          ? {
              "@effect/tsgo": EFFECT_TSGO_VERSION,
              typescript: EFFECT_TSGO_TYPESCRIPT_VERSION,
              "vite-plus": VITE_PLUS_TESTED_VERSION,
            }
          : { "vite-plus": VITE_PLUS_TESTED_VERSION },
      },
      null,
      2,
    )}\n`,
  );
  yield* fs.writeFileString(
    path.join(projectDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: { noEmit: true },
        ...(options.projectReferences ? { references: [{ path: "./packages/example" }] } : {}),
      },
      null,
      2,
    )}\n`,
  );
});

const writeWorkspacePackage = Effect.fn("writeQualityWorkspacePackage")(function* (
  projectDir: string,
  packageDir: string,
  options: {
    readonly typecheck?: boolean;
    readonly dependencies?: Readonly<Record<string, string>>;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.join(projectDir, packageDir);

  yield* fs.makeDirectory(absolute, { recursive: true });
  yield* fs.writeFileString(
    path.join(absolute, "package.json"),
    `${JSON.stringify(
      {
        name: `@fixture/${path.basename(packageDir)}`,
        scripts: options.typecheck === false ? {} : { typecheck: "tsc --noEmit" },
        dependencies: options.dependencies ?? {},
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
    it.effect("tests a Vite+ version inside the advertised peer range", () =>
      Effect.sync(() => {
        assert.isTrue(semver.satisfies(VITE_PLUS_TESTED_VERSION, VITE_PLUS_SUPPORTED_RANGE));
      }),
    );

    it.effect("does nothing until the repository opts in", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createFixture();

        yield* writeFixture(projectDir, {
          quality: false,
          typecheckStrategy: "workspace",
          typecheckConcurrency: 0,
          projectReferences: true,
        });
        yield* writePackageVersion(projectDir, "vite-plus", "0.3.0");
        const result = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.notMatch(result.output, /templates\/vite-plus/);
        assert.isFalse(yield* fs.exists(path.join(projectDir, VITE_PLUS_CONFIG_PATH)));
        assert.isFalse(yield* fs.exists(path.join(projectDir, VITE_PLUS_GITHUB_ACTIONS_PATH)));
      }),
    );

    it.effect("generates one frozen install followed by locked Dev Kit convergence", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* repositoryRoot();
        const workflow = yield* fs.readFileString(
          path.join(root, VITE_PLUS_GITHUB_ACTIONS_TEMPLATE),
        );

        assert.strictEqual((workflow.match(/run-install:/g) ?? []).length, 1);
        assert.strictEqual((workflow.match(/run:\s+vp install/g) ?? []).length, 0);
        assert.include(
          workflow,
          "voidzero-dev/setup-vp@143f5f385f39b1b753ffed1a01ad443811855c8b # v1.16.1",
        );
        assert.notMatch(workflow, /^\s+version:/m);
        assert.include(workflow, 'args: ["--frozen-lockfile", "--ignore-scripts"]');
        assert.include(workflow, "run: vp exec dev-kit apply --locked");
        assert.isBelow(workflow.indexOf("run-install:"), workflow.indexOf("apply --locked"));
        assert.notMatch(workflow, /dev-kit apply(?! --locked)/);
        assert.include(
          renderVitePlusWorkflowTemplate(workflow, "./bin/dev-kit.mjs apply --locked"),
          "run: ./bin/dev-kit.mjs apply --locked",
        );
      }),
    );

    it.effect("fails closed when a generated template marker drifts", () =>
      Effect.sync(() => {
        assert.throws(
          () =>
            renderVitePlusConfigTemplate("export default {};\n", {
              strategy: "workspace",
              concurrency: 4,
              packages: ["packages/core"],
            }),
          /expected exactly one generated template marker/,
        );
        assert.throws(
          () =>
            renderVitePlusConfigTemplate(
              '      typecheck: "tsc --noEmit",\n      typecheck: "tsc --noEmit",\n',
              {
                strategy: "workspace",
                concurrency: 4,
                packages: ["packages/core"],
              },
            ),
          /expected exactly one generated template marker/,
        );
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
          renderVitePlusConfigTemplate(
            yield* fs.readFileString(path.join(root, VITE_PLUS_CONFIG_TEMPLATE)),
            { strategy: "single-project", concurrency: 4, packages: [] },
          ),
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

    it.effect("converges a fresh CI checkout from the committed lock and patch", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createFixture();
        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(applied.exitCode, 0, applied.output);
        yield* fs.remove(path.join(projectDir, ".dev-kit"), { recursive: true, force: true });
        const compilerPath = path.join(
          projectDir,
          "node_modules",
          "@typescript",
          "typescript-test-platform",
          "lib",
          "tsc",
        );

        yield* fs.writeFileString(compilerPath, "original\n");
        const locked = yield* runDevKit(projectDir, [
          "apply",
          "--locked",
          "--project-dir",
          projectDir,
        ]);

        assert.strictEqual(locked.exitCode, 0, locked.output);
        assert.strictEqual(yield* fs.readFileString(compilerPath), "patched\n");
        assert.isTrue(yield* fs.exists(path.join(projectDir, ".dev-kit", "state.json")));
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

    it.effect("rejects installed Vite+ versions outside Dev Kit's peer range", () =>
      Effect.gen(function* () {
        const projectDir = yield* createFixture();

        for (const version of ["0.2.5", "0.3.0"]) {
          yield* writePackageVersion(projectDir, "vite-plus", version);
          const result = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

          assert.notStrictEqual(result.exitCode, 0);
          assert.include(result.output, `installed vite-plus ${version} is incompatible`);
          assert.include(result.output, `supported range: ${VITE_PLUS_SUPPORTED_RANGE}`);
        }
      }),
    );

    it.effect("rejects incomplete installed Vite+ package state", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createFixture();
        const packageDir = path.join(projectDir, "node_modules", "vite-plus");

        yield* fs.remove(packageDir, { recursive: true, force: true });
        const missingPackage = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.notStrictEqual(missingPackage.exitCode, 0);
        assert.match(missingPackage.output, /node_modules\/vite-plus\/package\.json is missing/);
        yield* writePackageVersion(projectDir, "vite-plus", VITE_PLUS_TESTED_VERSION);
        yield* fs.remove(path.join(projectDir, "node_modules", ".bin", "vp"), { force: true });
        const missingBinary = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.notStrictEqual(missingBinary.exitCode, 0);
        assert.match(missingBinary.output, /node_modules\/\.bin\/vp is missing/);
      }),
    );

    it.effect("renders explicit Vite+-native workspace typechecking", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createFixture();

        yield* writeFixture(projectDir, {
          typecheckStrategy: "workspace",
          typecheckConcurrency: 6,
          workspaces: ["apps/*", "packages/*"],
          workspacePackages: ["packages/core", "apps/web"],
          projectReferences: true,
        });
        yield* writeWorkspacePackage(projectDir, "packages/core");
        yield* writeWorkspacePackage(projectDir, "apps/web", {
          dependencies: { "@fixture/core": "workspace:*" },
        });
        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(applied.exitCode, 0, applied.output);
        const config = yield* fs.readFileString(path.join(projectDir, VITE_PLUS_CONFIG_PATH));

        assert.include(
          config,
          "command: \"vp run --cache --concurrency-limit 6 --filter './packages/core' --filter './apps/web' --fail-if-no-match typecheck\"",
        );
        assert.include(config, "cache: false");
        assert.include(
          config,
          'check: ["vp fmt --check", "vp lint", "vp test", "vp run typecheck"]',
        );
        yield* writeFixture(projectDir);
        const switched = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(switched.exitCode, 0, switched.output);
        assert.include(
          yield* fs.readFileString(path.join(projectDir, VITE_PLUS_CONFIG_PATH)),
          'typecheck: "tsc --noEmit"',
        );
      }),
    );

    it.effect("validates workspace and project-reference typecheck topology", () =>
      Effect.gen(function* () {
        const projectDir = yield* createFixture();

        yield* writeFixture(projectDir, {
          typecheckStrategy: "workspace",
          workspacePackages: ["packages/core"],
        });
        const noWorkspace = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.notStrictEqual(noWorkspace.exitCode, 0);
        assert.match(
          noWorkspace.output,
          /workspace typechecking requires package\.json workspaces/,
        );
        yield* writeFixture(projectDir, {
          typecheckStrategy: "workspace",
          workspaces: ["packages/*"],
        });
        const noPackages = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.notStrictEqual(noPackages.exitCode, 0);
        assert.match(noPackages.output, /requires explicit package directories/);
        yield* writeFixture(projectDir, {
          typecheckStrategy: "workspace",
          workspaces: ["packages/*"],
          workspacePackages: ["packages/core"],
        });
        yield* writeWorkspacePackage(projectDir, "packages/core", { typecheck: false });
        const missingTask = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.notStrictEqual(missingTask.exitCode, 0);
        assert.match(missingTask.output, /workspace package requires a typecheck script/);
        yield* writeFixture(projectDir, { projectReferences: true });
        const implicitReferences = yield* runDevKit(projectDir, [
          "plan",
          "--project-dir",
          projectDir,
        ]);

        assert.notStrictEqual(implicitReferences.exitCode, 0);
        assert.match(implicitReferences.output, /does not support tsconfig project references/);
        yield* writeFixture(projectDir, { typecheckConcurrency: 0 });
        const invalidConcurrency = yield* runDevKit(projectDir, [
          "plan",
          "--project-dir",
          projectDir,
        ]);

        assert.notStrictEqual(invalidConcurrency.exitCode, 0);
        assert.match(invalidConcurrency.output, /concurrency must be between 1 and 32/);
      }),
    );
  });
});
