import { Effect, Schema } from "effect";

import type { VitePlusQualityWorkflowStep } from "./manifest.ts";
import { readDirectDependencyNames } from "./project-package.ts";
import { validateInstalledVitePlus } from "./vite-plus-dependency.ts";

export const VITE_PLUS_GITHUB_ACTIONS_PATH = ".github/workflows/check.yml";
export const VITE_PLUS_GITHUB_ACTIONS_TEMPLATE = "templates/vite-plus/github-actions-check.yml";

export class VitePlusQualitySupportError extends Schema.TaggedErrorClass<VitePlusQualitySupportError>()(
  "VitePlusQualitySupportError",
  { message: Schema.String },
) {}

export type VitePlusQualityWorkflow = {
  readonly beforeChecks: ReadonlyArray<VitePlusQualityWorkflowStep>;
  readonly typecheck: ReadonlyArray<string>;
};

export type VitePlusQualitySelection = {
  readonly workflow: VitePlusQualityWorkflow;
};

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
  },
);
