import { Crypto, Effect, Encoding, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { printStatus, withSpinner } from "./cli-ui.ts";
import { acquireProjectProcessLock } from "./project-process-lock.ts";
import { isTypeScriptPackageName } from "./typescript-package-name.ts";

export const EFFECT_TSGO_VERSION = "0.33.0";
export const EFFECT_TSGO_TYPESCRIPT_VERSION = "7.0.2";
export const EFFECT_TSGO_PLUGIN_NAME = "@effect/language-service";

export type EffectTsgoDiagnosticSeverity = "off" | "error" | "warning" | "message" | "suggestion";

export type EffectTsgoPluginConfig = {
  readonly name: typeof EFFECT_TSGO_PLUGIN_NAME;
  readonly diagnosticSeverity: Readonly<Record<string, EffectTsgoDiagnosticSeverity>>;
  readonly overrides: ReadonlyArray<{
    readonly include: ReadonlyArray<string>;
    readonly options: {
      readonly diagnosticSeverity: Readonly<Record<string, EffectTsgoDiagnosticSeverity>>;
    };
  }>;
};

/** Recommended diagnostics for projects using the Effect TypeScript-Go plugin. */
export const recommendedEffectTsgoPlugin = {
  name: EFFECT_TSGO_PLUGIN_NAME,
  diagnosticSeverity: {
    anyUnknownInErrorContext: "warning",
    instanceOfSchema: "suggestion",
    nestedEffectGenYield: "suggestion",
    newSchemaClass: "suggestion",
    preferSchemaTypeProperty: "suggestion",
    unsafeEffectTypeAssertion: "warning",
  },
  overrides: [
    {
      include: ["src/**/*.ts"],
      options: {
        diagnosticSeverity: {
          nodeBuiltinImport: "warning",
          preferSchemaOverJson: "suggestion",
        },
      },
    },
  ],
} as const satisfies EffectTsgoPluginConfig;

export type EffectTsgoPatchOptions = {
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly projectDir?: string;
  readonly typescriptPackage?: string;
};

export type EffectTsgoPatchPlan = {
  readonly alreadyPatched: boolean;
  readonly unpatchArgs?: ReadonlyArray<string>;
  readonly projectDir: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly effectTsgoVersion: string;
  readonly typescriptPackage: string;
  readonly typescriptVersion: string;
};

export class EffectTsgoDependencyError extends Schema.TaggedError<EffectTsgoDependencyError>()(
  "EffectTsgoDependencyError",
  {
    packageName: Schema.String,
    expectedVersion: Schema.String,
    actualVersion: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return this.actualVersion === undefined
      ? `${this.packageName}@${this.expectedVersion} must be installed before patching`
      : `${this.packageName}@${this.actualVersion} is installed; dev-kit requires ${this.packageName}@${this.expectedVersion}`;
  }
}

export class EffectTsgoPatchCommandError extends Schema.TaggedError<EffectTsgoPatchCommandError>()(
  "EffectTsgoPatchCommandError",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    output: Schema.String,
  },
) {
  override get message() {
    return this.output.length > 0
      ? `${this.command} exited with code ${this.exitCode}: ${this.output}`
      : `${this.command} exited with code ${this.exitCode}`;
  }
}

export class InvalidEffectTsgoPackageNameError extends Schema.TaggedError<InvalidEffectTsgoPackageNameError>()(
  "InvalidEffectTsgoPackageNameError",
  { packageName: Schema.String },
) {
  override get message() {
    return `invalid native TypeScript package name: ${this.packageName}`;
  }
}

const PackageVersionSchema = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

const packagePath = (path: Path.Path, projectDir: string, packageName: string): string =>
  path.join(projectDir, "node_modules", ...packageName.split("/"), "package.json");

const readExactPackageVersion = Effect.fn("readExactEffectTsgoPackageVersion")(function* (
  projectDir: string,
  packageName: string,
  expectedVersion: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = packagePath(path, projectDir, packageName);
  const contents = yield* fs
    .readFileString(manifestPath)
    .pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.fail(EffectTsgoDependencyError.make({ packageName, expectedVersion })),
      ),
    );
  const manifest = yield* Schema.decodeEffect(PackageVersionSchema)(contents).pipe(
    Effect.mapError(() => EffectTsgoDependencyError.make({ packageName, expectedVersion })),
  );

  if (manifest.version !== expectedVersion) {
    return yield* EffectTsgoDependencyError.make({
      packageName,
      expectedVersion,
      actualVersion: manifest.version,
    });
  }

  return manifest.version;
});

const resolveEffectTsgoExecutable = Effect.fn("resolveEffectTsgoExecutable")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const binDir = path.join(projectDir, "node_modules", ".bin");
  const candidates =
    path.sep === "\\"
      ? [path.join(binDir, "effect-tsgo.cmd"), path.join(binDir, "effect-tsgo")]
      : [path.join(binDir, "effect-tsgo"), path.join(binDir, "effect-tsgo.cmd")];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) return candidate;
  }

  return yield* EffectTsgoDependencyError.make({
    packageName: "@effect/tsgo",
    expectedVersion: EFFECT_TSGO_VERSION,
  });
});

const digestFileContents = Effect.fn("digestEffectTsgoFileContents")(function* (filePath: string) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;

  return Encoding.encodeHex(yield* crypto.digest("SHA-256", yield* fs.readFile(filePath)));
});

const findNodeModulesRoot = (path: Path.Path, packageJsonPath: string): string | undefined => {
  let current = path.dirname(packageJsonPath);

  while (true) {
    if (path.basename(current) === "node_modules") return current;
    const parent = path.dirname(current);

    if (parent === current) return undefined;
    current = parent;
  }
};

const inspectEffectTsgoPatch = Effect.fn("inspectEffectTsgoPatch")(function* (
  projectDir: string,
  typescriptPackage: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const typescriptPackageJson = yield* fs.realPath(
    packagePath(path, projectDir, typescriptPackage),
  );
  const effectTsgoPackageJson = yield* fs.realPath(packagePath(path, projectDir, "@effect/tsgo"));
  const typescriptNodeModules = findNodeModulesRoot(path, typescriptPackageJson);
  const effectNodeModules = findNodeModulesRoot(path, effectTsgoPackageJson);

  if (typescriptNodeModules === undefined || effectNodeModules === undefined) {
    return { alreadyPatched: false, hasBackup: false };
  }

  const typescriptScope = path.join(typescriptNodeModules, "@typescript");
  const effectScope = path.join(effectNodeModules, "@effect");

  if (!(yield* fs.exists(typescriptScope)) || !(yield* fs.exists(effectScope))) {
    return { alreadyPatched: false, hasBackup: false };
  }

  const executableName = path.sep === "\\" ? "tsc.exe" : "tsc";
  const effectExecutableNames =
    path.sep === "\\" ? ["tsc.exe", "tsc-next.exe"] : ["tsc", "tsc-next"];
  let hasBackup = false;

  for (const entry of yield* fs.readDirectory(typescriptScope)) {
    if (!entry.startsWith("typescript-")) continue;
    const platform = entry.slice("typescript-".length);
    const installedPath = path.join(typescriptScope, entry, "lib", executableName);

    if (yield* fs.exists(`${installedPath}.original`)) hasBackup = true;
    if (!(yield* fs.exists(installedPath))) continue;
    const installedDigest = yield* digestFileContents(installedPath);

    for (const effectExecutableName of effectExecutableNames) {
      const effectBinaryPath = path.join(
        effectScope,
        `tsgo-${platform}`,
        "lib",
        effectExecutableName,
      );

      if (
        (yield* fs.exists(effectBinaryPath)) &&
        installedDigest === (yield* digestFileContents(effectBinaryPath))
      ) {
        return { alreadyPatched: true, hasBackup };
      }
    }
  }

  return { alreadyPatched: false, hasBackup };
});

export const planEffectTsgoPatch = Effect.fn("planEffectTsgoPatch")(function* (
  options: EffectTsgoPatchOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = yield* fs.realPath(path.resolve(options.projectDir ?? "."));
  const typescriptPackage = options.typescriptPackage ?? "typescript";

  if (!isTypeScriptPackageName(typescriptPackage)) {
    return yield* InvalidEffectTsgoPackageNameError.make({ packageName: typescriptPackage });
  }
  const effectTsgoVersion = yield* readExactPackageVersion(
    projectDir,
    "@effect/tsgo",
    EFFECT_TSGO_VERSION,
  );
  const typescriptVersion = yield* readExactPackageVersion(
    projectDir,
    typescriptPackage,
    EFFECT_TSGO_TYPESCRIPT_VERSION,
  );
  const executable = yield* resolveEffectTsgoExecutable(projectDir);
  const patchState = yield* inspectEffectTsgoPatch(projectDir, typescriptPackage);
  const typescriptPackageArgs =
    typescriptPackage === "typescript" ? [] : ["--typescript-package", typescriptPackage];

  return {
    alreadyPatched: patchState.alreadyPatched,
    ...(patchState.hasBackup && !patchState.alreadyPatched
      ? { unpatchArgs: ["unpatch", "--typescript", ...typescriptPackageArgs] }
      : {}),
    projectDir,
    executable,
    args: [
      "patch",
      "--typescript",
      ...(options.force ? ["--force"] : []),
      ...typescriptPackageArgs,
    ],
    effectTsgoVersion,
    typescriptPackage,
    typescriptVersion,
  } satisfies EffectTsgoPatchPlan;
});

const runEffectTsgoCommand = Effect.fn("runEffectTsgoCommand")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  projectDir: string,
) {
  const child = yield* ChildProcess.make(executable, args, {
    cwd: projectDir,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [output, exitCode] = yield* Effect.all([
    Stream.mkString(Stream.decodeText(child.all)),
    child.exitCode,
  ]);
  const trimmed = output.trim();

  if (exitCode !== 0) {
    return yield* EffectTsgoPatchCommandError.make({
      command: [executable, ...args].join(" "),
      exitCode,
      output: trimmed,
    });
  }
});

export const applyEffectTsgoPatchPlan = Effect.fn("applyEffectTsgoPatchPlan")(function* (
  plan: EffectTsgoPatchPlan,
) {
  if (plan.alreadyPatched) return;
  if (plan.unpatchArgs !== undefined) {
    yield* runEffectTsgoCommand(plan.executable, plan.unpatchArgs, plan.projectDir);
  }
  yield* runEffectTsgoCommand(plan.executable, plan.args, plan.projectDir);
});

export const patchEffectTsgo = Effect.fn("patchEffectTsgo")(function* (
  options: EffectTsgoPatchOptions = {},
) {
  const plan = yield* planEffectTsgoPatch(options);
  const detail = `@effect/tsgo@${plan.effectTsgoVersion} → ${plan.typescriptPackage}@${plan.typescriptVersion}`;

  if (options.dryRun) {
    yield* printStatus(
      plan.alreadyPatched ? "success" : "plan",
      plan.alreadyPatched ? "TypeScript patch up to date" : "Would patch TypeScript",
      detail,
    );

    return plan;
  }

  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* acquireProjectProcessLock(plan.projectDir);
      if (plan.alreadyPatched) {
        yield* printStatus("success", "TypeScript patch up to date", detail);

        return plan;
      }
      yield* withSpinner("Patching TypeScript", applyEffectTsgoPatchPlan(plan));
      yield* printStatus("success", "TypeScript patched", detail);

      return plan;
    }),
  );
});
