import { Schema as S } from "effect";

import { SKILL_SELECTOR_PATTERN } from "./skill-selector.ts";
import { TYPESCRIPT_PACKAGE_NAME_PATTERN } from "./typescript-package-name.ts";

export type HarnessTarget = "agents" | "claude" | "opencode";

export const SyncMode = S.Literals(["copy", "symlink"]);
export type SyncMode = "copy" | "symlink";

export const TargetConfigSchema = S.Struct({
  enabled: S.optional(S.Boolean),
  mode: S.optional(SyncMode),
  path: S.optional(S.String),
});

export type TargetConfig = typeof TargetConfigSchema.Type;

export const EffectTsgoSetupSchema = S.Struct({
  enabled: S.optional(S.Boolean),
  force: S.optional(S.Boolean),
  typescriptPackage: S.optional(S.String.check(S.isPattern(TYPESCRIPT_PACKAGE_NAME_PATTERN))),
});

export type EffectTsgoSetup = typeof EffectTsgoSetupSchema.Type;

export const EffectSourceSetupSchema = S.Struct({
  enabled: S.optional(S.Boolean),
  packageName: S.optional(S.String.check(S.isPattern(TYPESCRIPT_PACKAGE_NAME_PATTERN))),
  path: S.optional(S.String),
  repository: S.optional(S.String),
});

export type EffectSourceSetup = typeof EffectSourceSetupSchema.Type;

export const AgentInstructionsSetupSchema = S.Struct({
  enabled: S.optional(S.Boolean),
});

export type AgentInstructionsSetup = typeof AgentInstructionsSetupSchema.Type;

export const ClaudeInstructionsSetupSchema = S.Struct({
  enabled: S.optional(S.Boolean),
});

export type ClaudeInstructionsSetup = typeof ClaudeInstructionsSetupSchema.Type;

export const VitePlusHooksSetupSchema = S.Struct({
  enabled: S.optional(S.Boolean),
});

export const VitePlusQualityWorkflowStepSchema = S.Struct({
  name: S.String,
  run: S.Array(S.String),
});
export type VitePlusQualityWorkflowStep = typeof VitePlusQualityWorkflowStepSchema.Type;

export const VitePlusQualityWorkflowSetupSchema = S.Struct({
  enabled: S.optional(S.Boolean),
  beforeChecks: S.optional(S.Array(VitePlusQualityWorkflowStepSchema)),
  typecheck: S.optional(S.Array(S.String)),
});
export type VitePlusQualityWorkflowSetup = typeof VitePlusQualityWorkflowSetupSchema.Type;

export const VitePlusQualitySetupSchema = S.Struct({
  workflow: S.optional(VitePlusQualityWorkflowSetupSchema),
});
export type VitePlusQualitySetup = typeof VitePlusQualitySetupSchema.Type;

export const VitePlusSetupSchema = S.Struct({
  hooks: S.optional(VitePlusHooksSetupSchema),
  quality: S.optional(VitePlusQualitySetupSchema),
});

export type VitePlusSetup = typeof VitePlusSetupSchema.Type;

export const DevKitManifestSchema = S.Struct({
  $schema: S.optional(S.String),
  include: S.Array(S.String.check(S.isPattern(SKILL_SELECTOR_PATTERN))),
  exclude: S.optional(S.Array(S.String.check(S.isPattern(SKILL_SELECTOR_PATTERN)))),
  setup: S.optional(
    S.Struct({
      agentInstructions: S.optional(AgentInstructionsSetupSchema),
      claudeInstructions: S.optional(ClaudeInstructionsSetupSchema),
      effectSource: S.optional(EffectSourceSetupSchema),
      effectTsgo: S.optional(EffectTsgoSetupSchema),
      vitePlus: S.optional(VitePlusSetupSchema),
    }),
  ),
  targets: S.optional(
    S.Struct({
      agents: S.optional(TargetConfigSchema),
      claude: S.optional(TargetConfigSchema),
      opencode: S.optional(TargetConfigSchema),
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
