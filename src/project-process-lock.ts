import { Cause, Crypto, DateTime, Effect, FileSystem, Path, Schema as S } from "effect";

import { DEV_KIT_VERSION } from "./tool-metadata.ts";

export const PROJECT_PROCESS_LOCK_PATH = ".dev-kit/apply.lock";

export class ProjectAlreadyLockedError extends S.TaggedErrorClass<ProjectAlreadyLockedError>()(
  "ProjectAlreadyLockedError",
  { path: S.String },
) {
  override get message() {
    return `another dev-kit operation may be active (${this.path}); verify the owner before removing a stale lock`;
  }
}

const ProjectProcessLockOwnerSchema = S.fromJsonString(
  S.Struct({
    version: S.Literal(1),
    toolVersion: S.String,
    token: S.String,
    startedAt: S.String,
  }),
);

export const acquireProjectProcessLock = Effect.fn("acquireProjectProcessLock")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const lockDir = path.join(projectDir, ...PROJECT_PROCESS_LOCK_PATH.split("/"));
  const stateDir = path.dirname(lockDir);
  const ownerPath = path.join(lockDir, "owner.json");
  const token = yield* crypto.randomUUIDv7;
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const ownerContents = `${yield* S.encodeEffect(ProjectProcessLockOwnerSchema)({
    version: 1,
    toolVersion: DEV_KIT_VERSION,
    token,
    startedAt,
  }).pipe(Effect.orDie)}\n`;

  return yield* Effect.acquireRelease(
    Effect.gen(function* () {
      yield* fs.makeDirectory(stateDir, { recursive: true });

      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* fs
            .makeDirectory(lockDir)
            .pipe(
              Effect.mapError((error) =>
                error.reason._tag === "AlreadyExists"
                  ? ProjectAlreadyLockedError.make({ path: lockDir })
                  : error,
              ),
            );
          yield* fs.writeFileString(ownerPath, ownerContents).pipe(
            Effect.catchCause((writeCause) =>
              fs.remove(lockDir, { recursive: true, force: true }).pipe(
                Effect.catchCause((cleanupCause) =>
                  Effect.failCause(Cause.combine(writeCause, cleanupCause)),
                ),
                Effect.andThen(Effect.failCause(writeCause)),
              ),
            ),
          );

          return { lockDir, ownerContents };
        }),
      );
    }),
    ({ lockDir: acquiredLockDir, ownerContents }) =>
      Effect.gen(function* () {
        const currentOwner = yield* fs
          .readFileString(ownerPath)
          .pipe(
            Effect.catch((error) =>
              error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
            ),
          );

        if (currentOwner === ownerContents) {
          yield* fs.remove(acquiredLockDir, { recursive: true, force: true });
        }
      }).pipe(Effect.orDie),
  ).pipe(Effect.map(({ lockDir }) => lockDir));
});
