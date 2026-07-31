import { Cause, Crypto, DateTime, Effect, FileSystem, Path, Schema } from "effect";

export class ProjectAlreadyLockedError extends Schema.TaggedErrorClass<ProjectAlreadyLockedError>()(
  "ProjectAlreadyLockedError",
  { path: Schema.String },
) {
  override get message() {
    return `another dev-kit apply may be active (${this.path}); verify the owner before removing a stale lock`;
  }
}

export const acquireProjectProcessLock = Effect.fn("acquireProjectProcessLock")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const stateDir = path.join(projectDir, ".dev-kit");
  const lockDir = path.join(stateDir, "apply.lock");
  const ownerPath = path.join(lockDir, "owner.json");
  const token = yield* crypto.randomUUIDv7;
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const ownerContents = `${JSON.stringify(
    {
      version: 1,
      toolVersion: "0.1.0",
      token,
      startedAt,
    },
    null,
    2,
  )}\n`;

  return yield* Effect.acquireRelease(
    Effect.gen(function* () {
      yield* fs.makeDirectory(stateDir, { recursive: true });
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* fs.makeDirectory(lockDir).pipe(
            Effect.mapError((error) =>
              error.reason._tag === "AlreadyExists"
                ? new ProjectAlreadyLockedError({ path: lockDir })
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
        const currentOwner = yield* fs.readFileString(ownerPath).pipe(
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
