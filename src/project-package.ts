import { Effect, FileSystem, Path, Schema } from "effect";

export class ProjectPackageError extends Schema.TaggedErrorClass<ProjectPackageError>()(
  "ProjectPackageError",
  { message: Schema.String },
) {}

const ProjectPackageSchema = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    workspaces: Schema.optional(Schema.Unknown),
  }),
);

export const readProjectPackage = Effect.fn("readProjectPackage")(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(projectDir, "package.json");

  if (!(yield* fs.exists(manifestPath))) {
    return yield* new ProjectPackageError({ message: `package.json not found: ${manifestPath}` });
  }
  const manifest = yield* fs.readFileString(manifestPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ProjectPackageSchema)),
    Effect.mapError(
      () =>
        new ProjectPackageError({
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
