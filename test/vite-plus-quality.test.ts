import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import semver from "semver";

import { EFFECT_TSGO_TYPESCRIPT_VERSION, EFFECT_TSGO_VERSION } from "../src/effect-tsgo.ts";
import { VITE_PLUS_SUPPORTED_RANGE, VITE_PLUS_TESTED_VERSION } from "../src/tool-metadata.ts";
import {
  renderVitePlusWorkflowTemplate,
  VITE_PLUS_GITHUB_ACTIONS_PATH,
  VITE_PLUS_GITHUB_ACTIONS_TEMPLATE,
} from "../src/vite-plus-quality.ts";
import { repositoryRoot, runCommandSuccess, runDevKit } from "./test-platform.ts";

const VITE_CONFIG_PATH = "vite.config.ts";

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
    readonly workflow?: boolean;
    readonly effectTsgo?: boolean;
    readonly completeDependencies?: boolean;
    readonly beforeChecks?: ReadonlyArray<{
      readonly name: string;
      readonly run: ReadonlyArray<string>;
    }>;
    readonly workflowTypecheck?: ReadonlyArray<string>;
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
              workflow: {
                enabled: options.workflow ?? true,
                ...(options.beforeChecks === undefined
                  ? {}
                  : { beforeChecks: options.beforeChecks }),
                ...(options.workflowTypecheck === undefined
                  ? {}
                  : { typecheck: options.workflowTypecheck }),
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
        dependencies: completeDependencies
          ? { "@danieljvdm/dev-kit": "0.11.3", effect: "4.0.0-beta.102" }
          : {},
        devDependencies: completeDependencies
          ? {
              "@effect/tsgo": EFFECT_TSGO_VERSION,
              typescript: EFFECT_TSGO_TYPESCRIPT_VERSION,
              "vite-plus": VITE_PLUS_TESTED_VERSION,
            }
          : {},
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

    it.effect("manages the workflow while preserving a project-owned Vite config", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createFixture();
        const customConfig = "export default { custom: true };\n";

        yield* fs.writeFileString(path.join(projectDir, VITE_CONFIG_PATH), customConfig);
        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(applied.exitCode, 0, applied.output);
        assert.strictEqual(
          yield* fs.readFileString(path.join(projectDir, VITE_CONFIG_PATH)),
          customConfig,
        );
        assert.isTrue(yield* fs.exists(path.join(projectDir, VITE_PLUS_GITHUB_ACTIONS_PATH)));
        const lock = JSON.parse(
          yield* fs.readFileString(path.join(projectDir, "dev-kit.lock.json")),
        );

        assert.deepEqual(
          lock.outputs.map((output: { resourceId: string }) => output.resourceId),
          ["setup:vite-plus-github-actions"],
        );
      }),
    );

    it.effect("renders custom preparation and typecheck commands", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createFixture();

        yield* writeFixture(projectDir, {
          beforeChecks: [
            {
              name: "Install media tools",
              run: ["sudo apt-get update", "sudo apt-get install --yes ffmpeg"],
            },
          ],
          workflowTypecheck: ["vp run -F './apps/*' check", "vp exec tsc -p scripts/tsconfig.json"],
        });
        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(applied.exitCode, 0, applied.output);
        const workflow = yield* fs.readFileString(
          path.join(projectDir, VITE_PLUS_GITHUB_ACTIONS_PATH),
        );

        assert.include(workflow, '- name: "Install media tools"');
        assert.include(workflow, "sudo apt-get install --yes ffmpeg");
        assert.include(workflow, "vp run -F './apps/*' check");
        assert.include(workflow, "vp exec tsc -p scripts/tsconfig.json");
      }),
    );

    it.effect("generates one frozen install followed by locked convergence", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* repositoryRoot();
        const workflow = yield* fs.readFileString(
          path.join(root, VITE_PLUS_GITHUB_ACTIONS_TEMPLATE),
        );

        assert.strictEqual((workflow.match(/run-install:/g) ?? []).length, 1);
        assert.include(workflow, "oven-sh/setup-bun@v2");
        assert.include(workflow, "voidzero-dev/setup-vp@v1.16.1");
        assert.include(workflow, 'args: ["--frozen-lockfile", "--ignore-scripts"]');
        assert.include(workflow, "apply --locked");
        assert.include(
          renderVitePlusWorkflowTemplate(workflow, {
            devKitCommand: "./bin/dev-kit.mjs apply --locked",
          }),
          "run: ./bin/dev-kit.mjs apply --locked",
        );
      }),
    );

    it.effect("fails closed when a workflow template marker drifts", () =>
      Effect.sync(() => {
        assert.throws(
          () =>
            renderVitePlusWorkflowTemplate(
              "run: bun ./node_modules/@danieljvdm/dev-kit/bin/dev-kit.mjs apply --locked\n",
              {
                workflow: {
                  beforeChecks: [{ name: "Prepare", run: ["true"] }],
                  typecheck: ["vp run typecheck"],
                },
              },
            ),
          /expected exactly one generated template marker/,
        );
      }),
    );

    it.effect("removes only the workflow when disabled", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* createFixture();
        const customConfig = "export default { custom: true };\n";

        yield* fs.writeFileString(path.join(projectDir, VITE_CONFIG_PATH), customConfig);
        const applied = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(applied.exitCode, 0, applied.output);
        yield* writeFixture(projectDir, { workflow: false });
        const removed = yield* runDevKit(projectDir, ["apply", "--project-dir", projectDir]);

        assert.strictEqual(removed.exitCode, 0, removed.output);
        assert.isFalse(yield* fs.exists(path.join(projectDir, VITE_PLUS_GITHUB_ACTIONS_PATH)));
        assert.strictEqual(
          yield* fs.readFileString(path.join(projectDir, VITE_CONFIG_PATH)),
          customConfig,
        );
      }),
    );

    it.effect("rejects unsupported workflow repositories", () =>
      Effect.gen(function* () {
        const projectDir = yield* createFixture();

        yield* writeFixture(projectDir, { effectTsgo: false });
        const disabled = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.notStrictEqual(disabled.exitCode, 0);
        assert.match(disabled.output, /requires setup\.effectTsgo\.enabled/);
        yield* writeFixture(projectDir, { completeDependencies: false });
        const unsupported = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.notStrictEqual(unsupported.exitCode, 0);
        assert.match(unsupported.output, /direct project dependency|requires direct dependencies/);
      }),
    );

    it.effect("rejects Vite+ versions outside the peer range", () =>
      Effect.gen(function* () {
        const projectDir = yield* createFixture();

        yield* writePackageVersion(projectDir, "vite-plus", "0.3.0");
        const result = yield* runDevKit(projectDir, ["plan", "--project-dir", projectDir]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.include(result.output, "installed vite-plus 0.3.0 is incompatible");
      }),
    );
  });
});
