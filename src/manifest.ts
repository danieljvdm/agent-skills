import { Schema } from "effect";

import { SKILL_SELECTOR_PATTERN } from "./skill-selector.ts";
import { TYPESCRIPT_PACKAGE_NAME_PATTERN } from "./typescript-package-name.ts";

export type HarnessTarget = "agents" | "claude" | "opencode";

export const SyncMode = Schema.Literals(["copy", "symlink"]);
export type SyncMode = "copy" | "symlink";

export const TargetConfigSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  mode: Schema.optional(SyncMode),
  path: Schema.optional(Schema.String),
});

export type TargetConfig = typeof TargetConfigSchema.Type;

export const EffectTsgoSetupSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  force: Schema.optional(Schema.Boolean),
  typescriptPackage: Schema.optional(
    Schema.String.check(Schema.isPattern(TYPESCRIPT_PACKAGE_NAME_PATTERN)),
  ),
});

export type EffectTsgoSetup = typeof EffectTsgoSetupSchema.Type;

export const EffectSourceSetupSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  packageName: Schema.optional(
    Schema.String.check(Schema.isPattern(TYPESCRIPT_PACKAGE_NAME_PATTERN)),
  ),
  path: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.String),
});

export type EffectSourceSetup = typeof EffectSourceSetupSchema.Type;

export const AgentInstructionsSetupSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
});

export type AgentInstructionsSetup = typeof AgentInstructionsSetupSchema.Type;

export const ClaudeInstructionsSetupSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
});

export type ClaudeInstructionsSetup = typeof ClaudeInstructionsSetupSchema.Type;

export const VitePlusHooksSetupSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
});

export const VitePlusQualityWorkflowStepSchema = Schema.Struct({
  name: Schema.String,
  run: Schema.Array(Schema.String),
});
export type VitePlusQualityWorkflowStep = typeof VitePlusQualityWorkflowStepSchema.Type;

export const VitePlusQualityWorkflowSetupSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  beforeChecks: Schema.optional(Schema.Array(VitePlusQualityWorkflowStepSchema)),
  typecheck: Schema.optional(Schema.Array(Schema.String)),
});
export type VitePlusQualityWorkflowSetup = typeof VitePlusQualityWorkflowSetupSchema.Type;

export const VitePlusQualitySetupSchema = Schema.Struct({
  workflow: Schema.optional(VitePlusQualityWorkflowSetupSchema),
});
export type VitePlusQualitySetup = typeof VitePlusQualitySetupSchema.Type;

export const VitePlusSetupSchema = Schema.Struct({
  hooks: Schema.optional(VitePlusHooksSetupSchema),
  quality: Schema.optional(VitePlusQualitySetupSchema),
});

export type VitePlusSetup = typeof VitePlusSetupSchema.Type;

export const DevKitManifestSchema = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  include: Schema.Array(Schema.String.check(Schema.isPattern(SKILL_SELECTOR_PATTERN))),
  exclude: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isPattern(SKILL_SELECTOR_PATTERN))),
  ),
  setup: Schema.optional(
    Schema.Struct({
      agentInstructions: Schema.optional(AgentInstructionsSetupSchema),
      claudeInstructions: Schema.optional(ClaudeInstructionsSetupSchema),
      effectSource: Schema.optional(EffectSourceSetupSchema),
      effectTsgo: Schema.optional(EffectTsgoSetupSchema),
      vitePlus: Schema.optional(VitePlusSetupSchema),
    }),
  ),
  targets: Schema.optional(
    Schema.Struct({
      agents: Schema.optional(TargetConfigSchema),
      claude: Schema.optional(TargetConfigSchema),
      opencode: Schema.optional(TargetConfigSchema),
    }),
  ),
});

export type DevKitManifest = typeof DevKitManifestSchema.Type;

export type NormalizedTargetConfig = {
  readonly enabled: boolean;
  readonly mode: SyncMode;
  readonly path: string;
};

export type NormalizedManifest = {
  readonly include: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
  readonly setup: {
    readonly agentInstructions: {
      readonly enabled: boolean;
    };
    readonly claudeInstructions: {
      readonly enabled: boolean;
    };
    readonly effectSource: {
      readonly enabled: boolean;
      readonly packageName: string;
      readonly path: string;
      readonly repository: string;
    };
    readonly effectTsgo: {
      readonly enabled: boolean;
      readonly force: boolean;
      readonly typescriptPackage: string;
    };
    readonly vitePlus: {
      readonly hooks: {
        readonly enabled: boolean;
      };
      readonly quality: {
        readonly workflow: {
          readonly enabled: boolean;
          readonly beforeChecks: ReadonlyArray<VitePlusQualityWorkflowStep>;
          readonly typecheck: ReadonlyArray<string>;
        };
      };
    };
  };
  readonly targets: Readonly<Record<HarnessTarget, NormalizedTargetConfig>>;
};

const DEFAULT_TARGET_PATHS: Readonly<Record<HarnessTarget, string>> = {
  agents: ".agents/skills",
  claude: ".claude/skills",
  opencode: ".opencode/skills",
};

const DEFAULT_TARGETS: Readonly<Record<HarnessTarget, NormalizedTargetConfig>> = {
  agents: { enabled: true, mode: "copy", path: DEFAULT_TARGET_PATHS.agents },
  claude: { enabled: false, mode: "symlink", path: DEFAULT_TARGET_PATHS.claude },
  opencode: { enabled: false, mode: "symlink", path: DEFAULT_TARGET_PATHS.opencode },
};

export const normalizeManifest = (manifest: DevKitManifest): NormalizedManifest => {
  const targets = {
    ...DEFAULT_TARGETS,
  };

  for (const key of ["agents", "claude", "opencode"] as const) {
    const override = manifest.targets?.[key];

    if (override) {
      targets[key] = {
        enabled: override.enabled ?? DEFAULT_TARGETS[key].enabled,
        mode: override.mode ?? DEFAULT_TARGETS[key].mode,
        path: override.path ?? DEFAULT_TARGETS[key].path,
      };
    }
  }
  const quality = manifest.setup?.vitePlus?.quality;

  return {
    exclude: manifest.exclude ?? [],
    include: manifest.include,
    setup: {
      agentInstructions: {
        enabled: manifest.setup?.agentInstructions?.enabled ?? false,
      },
      claudeInstructions: {
        enabled: manifest.setup?.claudeInstructions?.enabled ?? false,
      },
      effectSource: {
        enabled: manifest.setup?.effectSource?.enabled ?? false,
        packageName: manifest.setup?.effectSource?.packageName ?? "effect",
        path: manifest.setup?.effectSource?.path ?? ".repos/effect",
        repository:
          manifest.setup?.effectSource?.repository ?? "https://github.com/Effect-TS/effect.git",
      },
      effectTsgo: {
        enabled: manifest.setup?.effectTsgo?.enabled ?? false,
        force: manifest.setup?.effectTsgo?.force ?? false,
        typescriptPackage: manifest.setup?.effectTsgo?.typescriptPackage ?? "typescript",
      },
      vitePlus: {
        hooks: {
          enabled: manifest.setup?.vitePlus?.hooks?.enabled ?? false,
        },
        quality: {
          workflow: {
            enabled: quality?.workflow?.enabled ?? false,
            beforeChecks: quality?.workflow?.beforeChecks ?? [],
            typecheck: quality?.workflow?.typecheck ?? ["vp run typecheck"],
          },
        },
      },
    },
    targets,
  };
};
