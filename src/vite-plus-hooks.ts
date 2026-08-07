import { Config, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { validateInstalledVitePlus } from "./vite-plus-dependency.ts";

export const VITE_PLUS_HOOKS_DIR = ".vite-hooks";
export const VITE_PLUS_HOOKS_PATH = `${VITE_PLUS_HOOKS_DIR}/_`;

export type VitePlusHooksPlan = {
  readonly action: "configure" | "unchanged" | "skipped";
  readonly hooksDir: string;
  readonly hooksPath: string;
  readonly projectDir: string;
  readonly vpBin: string;
};

export class VitePlusHooksDependencyError extends Schema.TaggedError<VitePlusHooksDependencyError>()(
  "VitePlusHooksDependencyError",
  { message: Schema.String },
) {}

export class VitePlusHooksConflictError extends Schema.TaggedError<VitePlusHooksConflictError>()(
  "VitePlusHooksConflictError",
  { hooksPath: Schema.String },
) {
  override get message() {
    return `core.hooksPath is already set to "${this.hooksPath}"; refusing to replace another Git hook manager`;
  }
}

class VitePlusHooksCommandError extends Schema.TaggedError<VitePlusHooksCommandError>()(
  "VitePlusHooksCommandError",
  { command: Schema.String, exitCode: Schema.Int, output: Schema.String },
) {
  override get message() {
    return this.output.length > 0
      ? `${this.command} exited with code ${this.exitCode}: ${this.output}`
      : `${this.command} exited with code ${this.exitCode}`;
  }
}

class VitePlusHooksConvergenceError extends Schema.TaggedError<VitePlusHooksConvergenceError>()(
  "VitePlusHooksConvergenceError",
  { message: Schema.String },
) {}

const runCommand = Effect.fn("runVitePlusHooksCommand")(function* (
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  allowedExitCodes: ReadonlyArray<number> = [0],
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

  if (!allowedExitCodes.includes(exitCode)) {
    return yield* VitePlusHooksCommandError.make({
      command: [command, ...args].join(" "),
      exitCode,
      output: trimmed,
    });
  }

  return { exitCode, output: trimmed };
});

const hasExecutableFile = Effect.fn("hasExecutableVitePlusHookFile")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(filePath))) return false;
  const info = yield* fs.stat(filePath);

  return info.type === "File" && (info.mode & 0o111) !== 0;
});

const hasVitePlusPreCommitHook = Effect.fn("hasVitePlusPreCommitHook")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(filePath))) return false;
  const info = yield* fs.stat(filePath);

  return info.type === "File" && (yield* fs.readFileString(filePath)).includes("vp staged");
});

const inspectVitePlusHooks = Effect.fn("inspectVitePlusHooks")(function* (projectDir: string) {
  const path = yield* Path.Path;
  const configuredPath = yield* runCommand(
    projectDir,
    "git",
    ["config", "--local", "--get", "core.hooksPath"],
    [0, 1],
  );
  const hooksPath = configuredPath.exitCode === 0 ? configuredPath.output : "";

  if (
    hooksPath.length > 0 &&
    hooksPath !== VITE_PLUS_HOOKS_PATH &&
    hooksPath !== ".husky" &&
    !hooksPath.startsWith(".husky/")
  ) {
    return yield* VitePlusHooksConflictError.make({ hooksPath });
  }
  const internalDir = path.join(projectDir, VITE_PLUS_HOOKS_DIR, "_");
  const [hasLauncher, hasDispatcher, hasPreCommit, hasInternalIgnore] = yield* Effect.all([
    hasExecutableFile(path.join(internalDir, "h")),
    hasExecutableFile(path.join(internalDir, "pre-commit")),
    hasVitePlusPreCommitHook(path.join(projectDir, VITE_PLUS_HOOKS_DIR, "pre-commit")),
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.readFileString(path.join(internalDir, ".gitignore"))),
      Effect.map((contents) => contents.split(/\r?\n/).includes("*")),
      Effect.orElseSucceed(() => false),
    ),
  ]);

  return (
    hooksPath === VITE_PLUS_HOOKS_PATH &&
    hasLauncher &&
    hasDispatcher &&
    hasPreCommit &&
    hasInternalIgnore
  );
});

export const planVitePlusHooks = Effect.fn("planVitePlusHooks")(function* (projectDir: string) {
  const { vpBin } = yield* validateInstalledVitePlus(projectDir).pipe(
    Effect.mapError((error) =>
      VitePlusHooksDependencyError.make({
        message: `${error.message} before enabling setup.vitePlus.hooks`,
      }),
    ),
  );
  const viteGitHooks = yield* Config.string("VITE_GIT_HOOKS").pipe(Config.withDefault(""));
  const husky = yield* Config.string("HUSKY").pipe(Config.withDefault(""));
  const action =
    viteGitHooks === "0" || husky === "0"
      ? "skipped"
      : (yield* inspectVitePlusHooks(projectDir))
        ? "unchanged"
        : "configure";

  return {
    action,
    hooksDir: VITE_PLUS_HOOKS_DIR,
    hooksPath: VITE_PLUS_HOOKS_PATH,
    projectDir,
    vpBin,
  } satisfies VitePlusHooksPlan;
});

export const applyVitePlusHooksPlan = Effect.fn("applyVitePlusHooksPlan")(function* (
  plan: VitePlusHooksPlan,
) {
  if (plan.action !== "configure") return;
  yield* runCommand(plan.projectDir, plan.vpBin, [
    "config",
    "--no-agent",
    "--hooks-dir",
    plan.hooksDir,
  ]);
  if (!(yield* inspectVitePlusHooks(plan.projectDir))) {
    return yield* VitePlusHooksConvergenceError.make({
      message: `Vite+ hook setup did not converge at ${plan.hooksPath}`,
    });
  }
});
