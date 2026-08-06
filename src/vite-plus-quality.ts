import { Effect, FileSystem, Path, Schema } from "effect";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import type { VitePlusQualityWorkflowStep, VitePlusTypecheckStrategy } from "./manifest.ts";
import { readDirectDependencyNames, readProjectPackage } from "./project-package.ts";
import { validateInstalledVitePlus } from "./vite-plus-dependency.ts";

export const VITE_PLUS_CONFIG_PATH = "vite.config.ts";
export const VITE_PLUS_CONFIG_TEMPLATE = "templates/vite-plus/vite.config.ts";
export const VITE_PLUS_GITHUB_ACTIONS_PATH = ".github/workflows/check.yml";
export const VITE_PLUS_GITHUB_ACTIONS_TEMPLATE = "templates/vite-plus/github-actions-check.yml";

export class VitePlusQualitySupportError extends Schema.TaggedErrorClass<VitePlusQualitySupportError>()(
  "VitePlusQualitySupportError",
  { message: Schema.String },
) {}

export type VitePlusQualityTypecheck = {
  readonly strategy: VitePlusTypecheckStrategy;
  readonly concurrency: number;
  readonly packages: ReadonlyArray<string>;
};

export type VitePlusQualityWorkflow = {
  readonly beforeChecks: ReadonlyArray<VitePlusQualityWorkflowStep>;
  readonly typecheck: ReadonlyArray<string>;
};

export type VitePlusQualitySelection = {
  readonly config?: VitePlusQualityTypecheck;
  readonly workflow?: VitePlusQualityWorkflow;
};

const SINGLE_PROJECT_TYPECHECK_TASK = '      typecheck: "tsc --noEmit",';
const LOCKED_DEV_KIT_COMMAND =
  "bun ./node_modules/@danieljvdm/dev-kit/bin/dev-kit.mjs apply --locked";
const BEFORE_CHECKS_MARKER =
  "      # Dev Kit inserts configured quality.workflow.beforeChecks steps here.\n\n";
const DEFAULT_WORKFLOW_TYPECHECK = `      - name: Type check with Effect TypeScript-Go
        run: vp run typecheck`;

const replaceUniqueTemplateMarker = (
  template: string,
  marker: string,
  replacement: string,
): string => {
  const parts = template.split(marker);

  if (parts.length !== 2) {
    throw new Error(`expected exactly one generated template marker: ${marker}`);
  }

  return `${parts[0]}${replacement}${parts[1]}`;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const renderVitePlusConfigTemplate = (
  template: string,
  typecheck: VitePlusQualityTypecheck,
): string => {
  if (typecheck.strategy === "single-project") return template;
  const filters = typecheck.packages
    .map((packageDir) => `--filter ${shellQuote(`./${packageDir}`)}`)
    .join(" ");
  const command = `vp run --cache --concurrency-limit ${typecheck.concurrency} ${filters} --fail-if-no-match typecheck`;

  return replaceUniqueTemplateMarker(
    template,
    SINGLE_PROJECT_TYPECHECK_TASK,
    `      typecheck: {
        command: ${JSON.stringify(command)},
        cache: false,
      },`,
  );
};

export const renderVitePlusWorkflowTemplate = (
  template: string,
  options: {
    readonly devKitCommand?: string;
    readonly workflow?: VitePlusQualityWorkflow;
  } = {},
): string => {
  const devKitCommand = options.devKitCommand;
  const workflow = options.workflow;
  let rendered =
    devKitCommand === undefined || devKitCommand === LOCKED_DEV_KIT_COMMAND
      ? template
      : replaceUniqueTemplateMarker(template, LOCKED_DEV_KIT_COMMAND, devKitCommand);

  if (workflow !== undefined) {
    const steps = workflow.beforeChecks
      .map((step) => {
        const commands = step.run
          .flatMap((command) => command.split("\n"))
          .map((line) => `          ${line}`)
          .join("\n");

        return `      - name: ${JSON.stringify(step.name)}
        run: |
${commands}`;
      })
      .join("\n\n");

    rendered = replaceUniqueTemplateMarker(
      rendered,
      BEFORE_CHECKS_MARKER,
      steps.length === 0 ? "" : `${steps}\n\n`,
    );
  }
  if (
    workflow !== undefined &&
    (workflow.typecheck.length !== 1 || workflow.typecheck[0] !== "vp run typecheck")
  ) {
    const commands = workflow.typecheck
      .flatMap((command) => command.split("\n"))
      .map((line) => `          ${line}`)
      .join("\n");

    rendered = replaceUniqueTemplateMarker(
      rendered,
      DEFAULT_WORKFLOW_TYPECHECK,
      `      - name: Type check with Effect TypeScript-Go
        run: |
${commands}`,
    );
  }

  return rendered;
};

export const validateVitePlusQualitySupport = Effect.fn("validateVitePlusQualitySupport")(
  function* (
    projectDir: string,
    packageRoot: string,
    typescriptPackage: string,
    selection: VitePlusQualitySelection,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageJson = yield* readProjectPackage(projectDir);
    const dependencies = yield* readDirectDependencyNames(projectDir);
    const required = new Set(["effect", "@effect/tsgo", typescriptPackage]);

    yield* validateInstalledVitePlus(projectDir).pipe(
      Effect.mapError((error) => VitePlusQualitySupportError.make({ message: error.message })),
    );

    if (projectDir !== packageRoot) required.add("@danieljvdm/dev-kit");
    const missing = [...required].filter((dependency) => !dependencies.includes(dependency));

    if (missing.length > 0) {
      return yield* VitePlusQualitySupportError.make({
        message: `setup.vitePlus.quality requires direct dependencies: ${missing.join(", ")}`,
      });
    }
    if (selection.workflow !== undefined) {
      if (selection.workflow.typecheck.length === 0) {
        return yield* VitePlusQualitySupportError.make({
          message: "setup.vitePlus.quality.workflow.typecheck requires at least one command",
        });
      }
      for (const command of selection.workflow.typecheck) {
        if (command.trim().length === 0) {
          return yield* VitePlusQualitySupportError.make({
            message: "setup.vitePlus.quality.workflow.typecheck commands must not be empty",
          });
        }
      }
      for (const step of selection.workflow.beforeChecks) {
        if (step.name.trim().length === 0 || step.run.length === 0) {
          return yield* VitePlusQualitySupportError.make({
            message:
              "setup.vitePlus.quality.workflow.beforeChecks steps require a name and at least one command",
          });
        }
        if (step.run.some((command) => command.trim().length === 0)) {
          return yield* VitePlusQualitySupportError.make({
            message: "setup.vitePlus.quality.workflow.beforeChecks commands must not be empty",
          });
        }
      }
    }
    const typecheck = selection.config;

    if (typecheck === undefined) return;
    const conflictingScripts = ["check", "typecheck"].filter(
      (script) => packageJson.scripts?.[script] !== undefined,
    );

    if (conflictingScripts.length > 0) {
      return yield* VitePlusQualitySupportError.make({
        message: `setup.vitePlus.quality.config defines Vite tasks that conflict with package scripts: ${conflictingScripts.join(", ")}`,
      });
    }
    if (typecheck.concurrency < 1 || typecheck.concurrency > 32) {
      return yield* VitePlusQualitySupportError.make({
        message: "setup.vitePlus.quality.config typecheck concurrency must be between 1 and 32",
      });
    }
    if (typecheck.strategy === "single-project" && typecheck.packages.length > 0) {
      return yield* VitePlusQualitySupportError.make({
        message:
          "setup.vitePlus.quality.config single-project typechecking does not accept workspace packages",
      });
    }
    const workspacePatterns = Array.isArray(packageJson.workspaces)
      ? packageJson.workspaces
      : typeof packageJson.workspaces === "object" && packageJson.workspaces !== null
        ? (packageJson.workspaces as { readonly packages?: unknown }).packages
        : undefined;

    if (
      typecheck.strategy === "workspace" &&
      (!Array.isArray(workspacePatterns) ||
        workspacePatterns.length === 0 ||
        !workspacePatterns.every((pattern) => typeof pattern === "string"))
    ) {
      return yield* VitePlusQualitySupportError.make({
        message:
          "setup.vitePlus.quality.config workspace typechecking requires package.json workspaces",
      });
    }
    if (typecheck.strategy === "workspace") {
      if (typecheck.packages.length === 0) {
        return yield* VitePlusQualitySupportError.make({
          message:
            "setup.vitePlus.quality.config workspace typechecking requires explicit package directories",
        });
      }
      const uniquePackages = new Set(typecheck.packages);

      if (uniquePackages.size !== typecheck.packages.length) {
        return yield* VitePlusQualitySupportError.make({
          message: "setup.vitePlus.quality.config workspace typecheck packages must be unique",
        });
      }
      for (const packageDir of typecheck.packages) {
        const absolute = path.resolve(projectDir, packageDir);
        const relative = path.relative(projectDir, absolute);

        if (
          packageDir.length === 0 ||
          path.isAbsolute(packageDir) ||
          relative.length === 0 ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`)
        ) {
          return yield* VitePlusQualitySupportError.make({
            message: `setup.vitePlus.quality.config workspace package must be a project-relative subdirectory: ${packageDir}`,
          });
        }
        const workspacePackage = yield* readProjectPackage(absolute).pipe(
          Effect.mapError(() =>
            VitePlusQualitySupportError.make({
              message: `setup.vitePlus.quality.config workspace package is missing a valid package.json: ${packageDir}`,
            }),
          ),
        );

        if (workspacePackage.scripts?.typecheck === undefined) {
          return yield* VitePlusQualitySupportError.make({
            message: `setup.vitePlus.quality.config workspace package requires a typecheck script: ${packageDir}`,
          });
        }
      }
    }
    if (typecheck.strategy === "single-project") {
      const tsconfigPath = path.join(projectDir, "tsconfig.json");

      if (!(yield* fs.exists(tsconfigPath))) {
        return yield* VitePlusQualitySupportError.make({
          message:
            "setup.vitePlus.quality.config single-project typechecking requires tsconfig.json",
        });
      }
      const errors: Array<ParseError> = [];
      const tsconfig = parseJsonc(yield* fs.readFileString(tsconfigPath), errors, {
        allowTrailingComma: true,
      });

      if (errors.length > 0 || typeof tsconfig !== "object" || tsconfig === null) {
        return yield* VitePlusQualitySupportError.make({
          message: "setup.vitePlus.quality.config requires a valid root tsconfig.json",
        });
      }
      const references = (tsconfig as { readonly references?: unknown }).references;

      if (Array.isArray(references) && references.length > 0) {
        return yield* VitePlusQualitySupportError.make({
          message:
            "setup.vitePlus.quality.config single-project typechecking does not support tsconfig project references; select the workspace strategy or use a custom Vite config",
        });
      }
    }
  },
);
