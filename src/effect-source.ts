import { Config, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { printStatus, withSpinner } from "./cli-ui.ts";
import { observeSymbolicLink } from "./node-symbolic-link.ts";
import { acquireProjectProcessLock } from "./project-process-lock.ts";
import { isTypeScriptPackageName } from "./typescript-package-name.ts";

export const DEFAULT_EFFECT_REPOSITORY = "https://github.com/Effect-TS/effect.git";
export const DEFAULT_EFFECT_SOURCE_PATH = ".repos/effect";

export type EffectSourceOptions = {
  readonly dryRun?: boolean;
  readonly packageName?: string;
  readonly path?: string;
  readonly projectDir?: string;
  readonly repository?: string;
};

export type EffectSourcePlan = {
  readonly action: "sync" | "unchanged" | "skipped";
  readonly checkoutDir: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly path: string;
  readonly projectDir: string;
  readonly repository: string;
  readonly tag: string;
};

const EffectSourcePlanJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    action: Schema.Literals(["sync", "unchanged", "skipped"]),
    checkoutDir: Schema.String,
    packageName: Schema.String,
    packageVersion: Schema.String,
    path: Schema.String,
    projectDir: Schema.String,
    repository: Schema.String,
    tag: Schema.String,
  }),
);

export class EffectSourceDependencyError extends Schema.TaggedErrorClass<EffectSourceDependencyError>()(
  "EffectSourceDependencyError",
  { packageName: Schema.String },
) {
  override get message() {
    return `${this.packageName} must be installed before syncing its Effect source checkout`;
  }
}

export class EffectSourceCheckoutError extends Schema.TaggedErrorClass<EffectSourceCheckoutError>()(
  "EffectSourceCheckoutError",
  { message: Schema.String },
) {}

class EffectSourceCommandError extends Schema.TaggedErrorClass<EffectSourceCommandError>()(
  "EffectSourceCommandError",
  { command: Schema.String, exitCode: Schema.Int, output: Schema.String },
) {
  override get message() {
    return this.output.length > 0
      ? `${this.command} exited with code ${this.exitCode}: ${this.output}`
      : `${this.command} exited with code ${this.exitCode}`;
  }
}

const PackageVersionSchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String.check(Schema.isPattern(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/)),
  }),
);

const runCommand = Effect.fn("runEffectSourceCommand")(function* (
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const child = yield* ChildProcess.make(command, args, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [output, exitCode] = yield* Effect.all([
    Stream.mkString(Stream.decodeText(child.all)),
    child.exitCode,
  ]);
  const trimmed = output.trim();

  if (exitCode !== 0) {
    return yield* EffectSourceCommandError.make({
      command: [command, ...args].join(" "),
      exitCode,
      output: trimmed,
    });
  }

  return trimmed;
});

const runGit = (cwd: string, args: ReadonlyArray<string>) => runCommand(cwd, "git", args);

const readPackageVersion = Effect.fn("readEffectSourcePackageVersion")(function* (
  projectDir: string,
  packageName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(
    projectDir,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  const contents = yield* fs
    .readFileString(manifestPath)
    .pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.fail(EffectSourceDependencyError.make({ packageName })),
      ),
    );

  return yield* Schema.decodeEffect(PackageVersionSchema)(contents).pipe(
    Effect.mapError(() => EffectSourceDependencyError.make({ packageName })),
    Effect.map((manifest) => manifest.version),
  );
});

const resolveCheckoutPath = Effect.fn("resolveEffectSourceCheckoutPath")(function* (
  projectDir: string,
  candidate: string,
) {
  const path = yield* Path.Path;

  if (candidate.length === 0 || path.isAbsolute(candidate)) {
    return yield* EffectSourceCheckoutError.make({
      message: `Effect source path must be a non-empty project-relative path: ${candidate}`,
    });
  }
  const checkoutDir = path.resolve(projectDir, candidate);
  const relative = path.relative(projectDir, checkoutDir);

  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return yield* EffectSourceCheckoutError.make({
      message: `Effect source path resolves outside the project: ${candidate}`,
    });
  }
  let ancestor = projectDir;

  for (const segment of relative.split(path.sep).slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    if ((yield* observeSymbolicLink(ancestor)).kind === "symlink") {
      return yield* EffectSourceCheckoutError.make({
        message: `Effect source path has a symlink ancestor: ${ancestor}`,
      });
    }
  }

  return {
    checkoutDir,
    path: path.sep === "/" ? relative : relative.split(path.sep).join("/"),
  };
});

const inspectExistingCheckout = Effect.fn("inspectExistingEffectSource")(function* (
  checkoutDir: string,
  repository: string,
  tag: string,
) {
  const fs = yield* FileSystem.FileSystem;

  if ((yield* observeSymbolicLink(checkoutDir)).kind === "symlink") {
    return yield* EffectSourceCheckoutError.make({
      message: `Effect source destination is a symlink: ${checkoutDir}`,
    });
  }
  if (!(yield* fs.exists(checkoutDir))) return "sync" as const;

  const actualRoot = yield* runGit(checkoutDir, ["rev-parse", "--show-toplevel"]).pipe(
    Effect.mapError(() =>
      EffectSourceCheckoutError.make({
        message: `Effect source destination exists but is not a Git checkout: ${checkoutDir}`,
      }),
    ),
  );
  const expectedRoot = yield* fs.realPath(checkoutDir);

  if ((yield* fs.realPath(actualRoot)) !== expectedRoot) {
    return yield* EffectSourceCheckoutError.make({
      message: `Effect source destination is nested inside another Git checkout: ${checkoutDir}`,
    });
  }
  const remote = yield* runGit(checkoutDir, ["remote", "get-url", "origin"]);

  if (remote !== repository) {
    return yield* EffectSourceCheckoutError.make({
      message: `Effect source origin is ${remote}; expected ${repository}`,
    });
  }

  const target = yield* runGit(checkoutDir, [
    "rev-parse",
    "-q",
    "--verify",
    `${tag}^{commit}`,
  ]).pipe(Effect.catchTag("EffectSourceCommandError", () => Effect.void));

  if (target !== undefined) {
    const current = yield* runGit(checkoutDir, ["rev-parse", "HEAD"]);

    if (current === target) return "unchanged" as const;
  }

  const dirty = yield* runGit(checkoutDir, ["status", "--porcelain", "--untracked-files=all"]);

  if (dirty.length > 0) {
    return yield* EffectSourceCheckoutError.make({
      message: `Effect source checkout has local changes; refusing to switch ${checkoutDir} to ${tag}`,
    });
  }

  return "sync" as const;
});

export const planEffectSource = Effect.fn("planEffectSource")(function* (
  options: EffectSourceOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = yield* fs.realPath(path.resolve(options.projectDir ?? "."));
  const packageName = options.packageName ?? "effect";

  if (!isTypeScriptPackageName(packageName)) {
    return yield* EffectSourceCheckoutError.make({
      message: `invalid Effect source package name: ${packageName}`,
    });
  }
  const repository = options.repository ?? DEFAULT_EFFECT_REPOSITORY;

  if (repository.length === 0) {
    return yield* EffectSourceCheckoutError.make({
      message: "Effect source repository cannot be empty",
    });
  }
  const resolved = yield* resolveCheckoutPath(
    projectDir,
    options.path ?? DEFAULT_EFFECT_SOURCE_PATH,
  );
  const packageVersion = yield* readPackageVersion(projectDir, packageName);
  const tag = `effect@${packageVersion}`;
  const ci = yield* Config.string("CI").pipe(Config.withDefault(""));
  const action =
    ci === "true" || ci === "1"
      ? ("skipped" as const)
      : yield* inspectExistingCheckout(resolved.checkoutDir, repository, tag);

  return {
    action,
    checkoutDir: resolved.checkoutDir,
    packageName,
    packageVersion,
    path: resolved.path,
    projectDir,
    repository,
    tag,
  } satisfies EffectSourcePlan;
});

export const applyEffectSourcePlan = Effect.fn("applyEffectSourcePlan")(function* (
  plan: EffectSourcePlan,
) {
  if (plan.action !== "sync") return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!(yield* fs.exists(plan.checkoutDir))) {
    const parent = path.dirname(plan.checkoutDir);

    yield* fs.makeDirectory(parent, { recursive: true });
    const tempDir = yield* fs.makeTempDirectoryScoped({
      directory: parent,
      prefix: ".dev-kit-effect-source-",
    });
    const staged = path.join(tempDir, "checkout");

    yield* runGit(plan.projectDir, [
      "clone",
      "--depth",
      "1",
      "--branch",
      plan.tag,
      "--single-branch",
      "--",
      plan.repository,
      staged,
    ]);
    if (yield* fs.exists(plan.checkoutDir)) {
      return yield* EffectSourceCheckoutError.make({
        message: `Effect source destination appeared while cloning: ${plan.checkoutDir}`,
      });
    }
    yield* fs.rename(staged, plan.checkoutDir);

    return;
  }

  yield* runGit(plan.checkoutDir, [
    "fetch",
    "--depth",
    "1",
    "--force",
    "--quiet",
    "origin",
    `refs/tags/${plan.tag}:refs/tags/${plan.tag}`,
  ]);
  const target = yield* runGit(plan.checkoutDir, [
    "rev-parse",
    "-q",
    "--verify",
    `${plan.tag}^{commit}`,
  ]);

  yield* runGit(plan.checkoutDir, ["checkout", "--detach", target]);
});

export const syncEffectSource = Effect.fn("syncEffectSource")(function* (
  options: EffectSourceOptions = {},
) {
  const plan = yield* planEffectSource(options);
  const detail = `${plan.tag} → ${plan.path}`;

  if (plan.action === "skipped") {
    yield* printStatus("plan", "Effect source skipped", "CI");

    return;
  }
  if (options.dryRun) {
    yield* printStatus(
      plan.action === "sync" ? "plan" : "success",
      plan.action === "sync" ? "Would sync Effect source" : "Effect source up to date",
      detail,
    );

    return;
  }
  if (plan.action === "unchanged") {
    yield* printStatus("success", "Effect source up to date", detail);

    return;
  }
  yield* acquireProjectProcessLock(plan.projectDir);
  const replanned = yield* planEffectSource(options);
  const [plannedSignature, replannedSignature] = yield* Effect.all([
    Schema.encodeEffect(EffectSourcePlanJsonSchema)(plan),
    Schema.encodeEffect(EffectSourcePlanJsonSchema)(replanned),
  ]).pipe(
    Effect.mapError((error) =>
      EffectSourceCheckoutError.make({
        message: `could not encode Effect source plan: ${error.message}`,
      }),
    ),
  );

  if (plannedSignature !== replannedSignature) {
    return yield* EffectSourceCheckoutError.make({
      message: "Effect source checkout changed after planning; rerun the command",
    });
  }
  yield* withSpinner("Syncing Effect source", applyEffectSourcePlan(replanned));
  yield* printStatus("success", "Effect source ready", detail);
});
