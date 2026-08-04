import { Effect, FileSystem, Path, Schema } from "effect";
import semver from "semver";

import { readDirectDependencyNames } from "./project-package.ts";
import { VITE_PLUS_SUPPORTED_RANGE } from "./tool-metadata.ts";

const InstalledVitePlusPackageSchema = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String }),
);

export class VitePlusDependencyError extends Schema.TaggedErrorClass<VitePlusDependencyError>()(
  "VitePlusDependencyError",
  { message: Schema.String },
) {}

export type InstalledVitePlus = {
  readonly version: string;
  readonly vpBin: string;
};

export const validateInstalledVitePlus = Effect.fn("validateInstalledVitePlus")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dependencies = yield* readDirectDependencyNames(projectDir);

  if (!dependencies.includes("vite-plus")) {
    return yield* new VitePlusDependencyError({
      message: "vite-plus must be a direct project dependency",
    });
  }
  const packagePath = path.join(projectDir, "node_modules", "vite-plus", "package.json");

  if (!(yield* fs.exists(packagePath))) {
    return yield* new VitePlusDependencyError({
      message:
        "vite-plus must be installed before enabling this setup: node_modules/vite-plus/package.json is missing",
    });
  }
  const installed = yield* fs.readFileString(packagePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(InstalledVitePlusPackageSchema)),
    Effect.mapError(
      () =>
        new VitePlusDependencyError({
          message: "installed vite-plus package metadata has no valid version",
        }),
    ),
  );

  if (!semver.valid(installed.version)) {
    return yield* new VitePlusDependencyError({
      message: `installed vite-plus package metadata has invalid version: ${installed.version}`,
    });
  }
  if (!semver.satisfies(installed.version, VITE_PLUS_SUPPORTED_RANGE)) {
    return yield* new VitePlusDependencyError({
      message: `installed vite-plus ${installed.version} is incompatible with @danieljvdm/dev-kit; supported range: ${VITE_PLUS_SUPPORTED_RANGE}`,
    });
  }
  const vpBin = path.join(projectDir, "node_modules", ".bin", "vp");

  if (!(yield* fs.exists(vpBin))) {
    return yield* new VitePlusDependencyError({
      message: "vite-plus is installed but node_modules/.bin/vp is missing",
    });
  }

  return { version: installed.version, vpBin } satisfies InstalledVitePlus;
});
