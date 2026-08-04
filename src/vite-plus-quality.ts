import { Effect, FileSystem, Path, Schema } from "effect";

import { readDirectDependencyNames, readProjectPackage } from "./project-package.ts";

export const VITE_PLUS_CONFIG_PATH = "vite.config.ts";
export const VITE_PLUS_CONFIG_TEMPLATE = "templates/vite-plus/vite.config.ts";
export const VITE_PLUS_GITHUB_ACTIONS_PATH = ".github/workflows/check.yml";
export const VITE_PLUS_GITHUB_ACTIONS_TEMPLATE = "templates/vite-plus/github-actions-check.yml";

export class VitePlusQualitySupportError extends Schema.TaggedErrorClass<VitePlusQualitySupportError>()(
  "VitePlusQualitySupportError",
  { message: Schema.String },
) {}

export const validateVitePlusQualitySupport = Effect.fn("validateVitePlusQualitySupport")(
  function* (projectDir: string, packageRoot: string, typescriptPackage: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageJson = yield* readProjectPackage(projectDir);
    const dependencies = yield* readDirectDependencyNames(projectDir);
    const required = new Set(["vite-plus", "effect", "@effect/tsgo", typescriptPackage]);

    if (projectDir !== packageRoot) required.add("@danieljvdm/dev-kit");
    const missing = [...required].filter((dependency) => !dependencies.includes(dependency));

    if (missing.length > 0) {
      return yield* new VitePlusQualitySupportError({
        message: `setup.vitePlus.quality requires direct dependencies: ${missing.join(", ")}`,
      });
    }
    const conflictingScripts = ["check", "typecheck"].filter(
      (script) => packageJson.scripts?.[script] !== undefined,
    );

    if (conflictingScripts.length > 0) {
      return yield* new VitePlusQualitySupportError({
        message: `setup.vitePlus.quality defines Vite tasks that conflict with package scripts: ${conflictingScripts.join(", ")}`,
      });
    }
    const vpBin = path.join(projectDir, "node_modules", ".bin", "vp");

    if (!(yield* fs.exists(vpBin))) {
      return yield* new VitePlusQualitySupportError({
        message:
          "vite-plus must be installed before enabling setup.vitePlus.quality: node_modules/.bin/vp is missing",
      });
    }
  },
);
