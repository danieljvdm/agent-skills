import { Console, Crypto, Effect, Encoding, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { acquireProjectProcessLock } from "./project-process-lock.ts";

export const EFFECT_TSGO_VERSION = "0.24.3";
export const EFFECT_TSGO_TYPESCRIPT_VERSION = "7.0.2";
export const EFFECT_TSGO_PLUGIN_NAME = "@effect/language-service";

export type EffectTsgoPatchOptions = {
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly projectDir?: string;
  readonly typescriptPackage?: string;
};

export type EffectTsgoPatchPlan = {
  readonly alreadyPatched: boolean;
  readonly projectDir: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly effectTsgoVersion: string;
  readonly typescriptPackage: string;
  readonly typescriptVersion: string;
};

export class EffectTsgoDependencyError extends Schema.TaggedErrorClass<EffectTsgoDependencyError>()(
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

export class EffectTsgoPatchCommandError extends Schema.TaggedErrorClass<EffectTsgoPatchCommandError>()(
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

const PackageVersionSchema = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String }),
);

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
  const contents = yield* fs.readFileString(manifestPath).pipe(
    Effect.catchReason(
      "PlatformError",
      "NotFound",
      () => Effect.fail(new EffectTsgoDependencyError({ packageName, expectedVersion })),
    ),
  );
  const manifest = yield* Schema.decodeUnknownEffect(PackageVersionSchema)(contents).pipe(
    Effect.mapError(() =>
      new EffectTsgoDependencyError({ packageName, expectedVersion }),
    ),
  );
  if (manifest.version !== expectedVersion) {
    return yield* new EffectTsgoDependencyError({
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
  const candidates = path.sep === "\\"
    ? [path.join(binDir, "effect-tsgo.cmd"), path.join(binDir, "effect-tsgo")]
    : [path.join(binDir, "effect-tsgo"), path.join(binDir, "effect-tsgo.cmd")];
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) return candidate;
  }
  return yield* new EffectTsgoDependencyError({
    packageName: "@effect/tsgo",
    expectedVersion: EFFECT_TSGO_VERSION,
  });
});

const digestFileContents = Effect.fn("digestEffectTsgoFileContents")(function* (
  filePath: string,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  return Encoding.encodeHex(yield* crypto.digest("SHA-256", yield* fs.readFile(filePath)));
});

const isEffectTsgoPatched = Effect.fn("isEffectTsgoPatched")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scopeDir = path.join(projectDir, "node_modules", "@typescript");
  if (!(yield* fs.exists(scopeDir))) return false;
  const entries = yield* fs.readDirectory(scopeDir);
  const executableName = path.sep === "\\" ? "tsc.exe" : "tsc";
  const effectExecutableNames = path.sep === "\\"
    ? ["tsc.exe", "tsc-next.exe"]
    : ["tsc", "tsc-next"];
  for (const entry of entries) {
    if (!entry.startsWith("typescript-")) continue;
    const platform = entry.slice("typescript-".length);
    const installedPath = path.join(scopeDir, entry, "lib", executableName);
    if (!(yield* fs.exists(installedPath))) continue;
    const installedDigest = yield* digestFileContents(installedPath);
    for (const effectExecutableName of effectExecutableNames) {
      const effectBinaryPath = path.join(
        projectDir,
        "node_modules",
        "@effect",
        `tsgo-${platform}`,
        "lib",
        effectExecutableName,
      );
      if (
        (yield* fs.exists(effectBinaryPath)) &&
        installedDigest === (yield* digestFileContents(effectBinaryPath))
      ) {
        return true;
      }
    }
  }
  return false;
});

export const planEffectTsgoPatch = Effect.fn("planEffectTsgoPatch")(function* (
  options: EffectTsgoPatchOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = yield* fs.realPath(path.resolve(options.projectDir ?? "."));
  const typescriptPackage = options.typescriptPackage ?? "typescript";
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
  return {
    alreadyPatched: yield* isEffectTsgoPatched(projectDir),
    projectDir,
    executable,
    args: [
      "patch",
      ...(options.force ? ["--force"] : []),
      ...(typescriptPackage === "typescript"
        ? []
        : ["--typescript-package", typescriptPackage]),
    ],
    effectTsgoVersion,
    typescriptPackage,
    typescriptVersion,
  } satisfies EffectTsgoPatchPlan;
});

export const applyEffectTsgoPatchPlan = Effect.fn("applyEffectTsgoPatchPlan")(function* (
  plan: EffectTsgoPatchPlan,
) {
  if (plan.alreadyPatched) {
    yield* Console.log("Effect TypeScript-Go is already patched.");
    return;
  }
  const child = yield* ChildProcess.make(plan.executable, plan.args, {
    cwd: plan.projectDir,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [output, exitCode] = yield* Effect.all([
    Stream.mkString(Stream.decodeText(child.all)),
    child.exitCode,
  ]);
  const trimmed = output.trim();
  if (exitCode !== 0) {
    return yield* new EffectTsgoPatchCommandError({
      command: [plan.executable, ...plan.args].join(" "),
      exitCode,
      output: trimmed,
    });
  }
  if (trimmed.length > 0) yield* Console.log(trimmed);
});

export const patchEffectTsgo = Effect.fn("patchEffectTsgo")(function* (
  options: EffectTsgoPatchOptions = {},
) {
  const plan = yield* planEffectTsgoPatch(options);
  if (options.dryRun) {
    yield* Console.log(
      plan.alreadyPatched
        ? "Effect TypeScript-Go is already patched."
        : `Would run ${[plan.executable, ...plan.args].join(" ")} with @effect/tsgo@${plan.effectTsgoVersion} and ${plan.typescriptPackage}@${plan.typescriptVersion}`,
    );
    return plan;
  }

  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* acquireProjectProcessLock(plan.projectDir);
      yield* applyEffectTsgoPatchPlan(plan);
      return plan;
    }),
  );
});
