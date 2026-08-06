import { Cause, Effect, FileSystem, Path, type PlatformError, Schema } from "effect";

import { printStatus } from "./cli-ui.ts";
import { observeSymbolicLink } from "./node-symbolic-link.ts";
import { acquireProjectProcessLock } from "./project-process-lock.ts";

export const CANONICAL_REPOSITORIES_DIRECTORY = ".repos";

export const DEV_KIT_GITIGNORE_ENTRIES = [
  `${CANONICAL_REPOSITORIES_DIRECTORY}/`,
  ".dev-kit/",
] as const;

export type GitignoreOptions = {
  readonly dryRun?: boolean;
  readonly projectDir?: string;
};

export type GitignorePatch = {
  readonly path: string;
  readonly changed: boolean;
  readonly added: ReadonlyArray<string>;
};

export class UnsafeGitignorePathError extends Schema.TaggedErrorClass<UnsafeGitignorePathError>()(
  "UnsafeGitignorePathError",
  {
    path: Schema.String,
    reason: Schema.String,
  },
) {
  override get message() {
    return `refusing to patch ${this.path}: ${this.reason}`;
  }
}

export class GitignoreConflictError extends Schema.TaggedErrorClass<GitignoreConflictError>()(
  "GitignoreConflictError",
  { path: Schema.String },
) {
  override get message() {
    return `${this.path} changed while dev-kit was preparing its patch; rerun the command`;
  }
}

type PlannedGitignorePatch = GitignorePatch & {
  readonly contents: string;
  readonly existed: boolean;
  readonly mode: number | undefined;
  readonly previousContents: string;
};

const publicPatch = (patch: PlannedGitignorePatch): GitignorePatch => ({
  path: patch.path,
  changed: patch.changed,
  added: patch.added,
});

export const patchGitignoreContents = (
  current: string,
): { readonly contents: string; readonly added: ReadonlyArray<string> } => {
  const lines = current.split(/\r?\n/);
  const added = DEV_KIT_GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));

  if (added.length === 0) return { contents: current, added };

  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const separator =
    current.length === 0
      ? ""
      : current.endsWith(`${newline}${newline}`)
        ? ""
        : current.endsWith(newline)
          ? newline
          : `${newline}${newline}`;
  const block = ["# dev-kit managed paths", ...added].join(newline);

  return {
    contents: `${current}${separator}${block}${newline}`,
    added,
  };
};

const planGitignorePatch = Effect.fn("planGitignorePatch")(function* (
  projectDir: string,
): Effect.fn.Return<
  PlannedGitignorePatch,
  UnsafeGitignorePathError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitignorePath = path.join(projectDir, ".gitignore");
  const observation = yield* observeSymbolicLink(gitignorePath);

  if (observation.kind === "symlink") {
    return yield* UnsafeGitignorePathError.make({
      path: gitignorePath,
      reason: "the file is a symlink",
    });
  }

  let current = "";
  let mode: number | undefined;

  if (observation.kind !== "missing") {
    const info = yield* fs.stat(gitignorePath);

    if (info.type !== "File") {
      return yield* UnsafeGitignorePathError.make({
        path: gitignorePath,
        reason: "the path is not a regular file",
      });
    }
    current = yield* fs.readFileString(gitignorePath);
    mode = info.mode & 0o777;
  }

  const patch = patchGitignoreContents(current);

  return {
    path: gitignorePath,
    changed: patch.added.length > 0,
    added: patch.added,
    contents: patch.contents,
    existed: observation.kind !== "missing",
    mode,
    previousContents: current,
  };
});

const applyGitignorePatch = Effect.fn("applyGitignorePatch")(function* (
  projectDir: string,
  patch: PlannedGitignorePatch,
) {
  if (!patch.changed) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({
    directory: path.join(projectDir, ".dev-kit"),
    prefix: "gitignore-",
  });
  const staged = path.join(tempDir, "next.gitignore");
  const backup = path.join(tempDir, "previous.gitignore");

  yield* fs.writeFileString(staged, patch.contents, { mode: patch.mode ?? 0o666 });

  const currentObservation = yield* observeSymbolicLink(patch.path);
  const changed = patch.existed
    ? currentObservation.kind !== "not-symlink" ||
      (yield* fs.readFileString(patch.path)) !== patch.previousContents
    : currentObservation.kind !== "missing";

  if (changed) {
    return yield* GitignoreConflictError.make({ path: patch.path });
  }

  let backedUp = false;
  let installed = false;
  const rollback = Effect.gen(function* () {
    if (installed) {
      yield* fs.remove(patch.path, { force: true });
    }
    if (backedUp) {
      yield* fs.rename(backup, patch.path);
    }
  });
  const apply = Effect.gen(function* () {
    if (patch.existed) {
      yield* fs.rename(patch.path, backup);
      backedUp = true;
    }
    yield* fs.rename(staged, patch.path);
    installed = true;
  });

  yield* Effect.uninterruptible(
    apply.pipe(
      Effect.catchCause((applyCause) =>
        rollback.pipe(
          Effect.catchCause((rollbackCause) =>
            Effect.failCause(Cause.combine(applyCause, rollbackCause)),
          ),
          Effect.andThen(Effect.failCause(applyCause)),
        ),
      ),
    ),
  );
});

export const patchProjectGitignore = Effect.fn("patchProjectGitignore")(function* (
  options: GitignoreOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = yield* fs.realPath(path.resolve(options.projectDir ?? "."));

  if (options.dryRun) {
    const patch = yield* planGitignorePatch(projectDir);

    yield* printStatus(
      patch.changed ? "plan" : "success",
      patch.changed ? "Would update .gitignore" : ".gitignore up to date",
      patch.changed ? `add ${patch.added.join(", ")}` : undefined,
    );

    return publicPatch(patch);
  }

  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* acquireProjectProcessLock(projectDir);
      const patch = yield* planGitignorePatch(projectDir);

      yield* applyGitignorePatch(projectDir, patch);
      yield* printStatus(
        "success",
        patch.changed ? "Updated .gitignore" : ".gitignore up to date",
        patch.changed ? `added ${patch.added.join(", ")}` : undefined,
      );

      return publicPatch(patch);
    }),
  );
});
