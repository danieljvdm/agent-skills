import { Effect, FileSystem, Path, Schema as S } from "effect";

export class ProjectPackageError extends S.TaggedErrorClass<ProjectPackageError>()(
  "ProjectPackageError",
  { message: S.String },
) {}

const ProjectPackageSchema = S.fromJsonString(
  S.Struct({
    name: S.optional(S.String),
    packageManager: S.optional(S.String),
    scripts: S.optional(S.Record(S.String, S.String)),
    dependencies: S.optional(S.Record(S.String, S.String)),
    devDependencies: S.optional(S.Record(S.String, S.String)),
    optionalDependencies: S.optional(S.Record(S.String, S.String)),
    peerDependencies: S.optional(S.Record(S.String, S.String)),
    workspaces: S.optional(S.Unknown),
  }),
);

export const readProjectPackage = Effect.fn("readProjectPackage")(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(projectDir, "package.json");

  if (!(yield* fs.exists(manifestPath))) {
    return yield* ProjectPackageError.make({
      message: `package.json not found: ${manifestPath}`,
    });
  }
  const manifest = yield* fs.readFileString(manifestPath).pipe(
    Effect.flatMap(S.decodeUnknownEffect(ProjectPackageSchema)),
    Effect.mapError(() =>
      ProjectPackageError.make({
        message: `invalid project package.json: ${manifestPath}`,
      }),
    ),
  );

  return manifest;
});

export const readDirectDependencyNames = Effect.fn("readDirectDependencyNames")(function* (
  projectDir: string,
) {
  const manifest = yield* readProjectPackage(projectDir).pipe(
    Effect.catchTag("ProjectPackageError", (error) =>
      error.message.startsWith("package.json not found:") ? Effect.void : Effect.fail(error),
    ),
  );

  if (manifest === undefined) return [];

  return [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]),
  ].sort();
});
