import { Schema } from "effect";

export type HarnessTarget = "agents" | "claude" | "opencode";

export const SyncMode = Schema.Literals(["copy", "symlink"]);
export type SyncMode = "copy" | "symlink";

export const TargetConfigSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  mode: Schema.optional(SyncMode),
  path: Schema.optional(Schema.String),
});

export type TargetConfig = typeof TargetConfigSchema.Type;

export const ManifestSchema = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  include: Schema.Array(Schema.String),
  exclude: Schema.optional(Schema.Array(Schema.String)),
  targets: Schema.optional(
    Schema.Struct({
      agents: Schema.optional(TargetConfigSchema),
      claude: Schema.optional(TargetConfigSchema),
      opencode: Schema.optional(TargetConfigSchema),
    }),
  ),
});

export type AgentSkillsManifest = typeof ManifestSchema.Type;

export type NormalizedTargetConfig = {
  readonly enabled: boolean;
  readonly mode: SyncMode;
  readonly path: string;
};

export type NormalizedManifest = {
  readonly include: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
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

export const normalizeManifest = (manifest: AgentSkillsManifest): NormalizedManifest => {
  const targets = {
    ...DEFAULT_TARGETS,
  };

  for (const key of Object.keys(DEFAULT_TARGETS) as Array<HarnessTarget>) {
    const override = manifest.targets?.[key];
    if (override) {
      targets[key] = {
        enabled: override.enabled ?? DEFAULT_TARGETS[key].enabled,
        mode: override.mode ?? DEFAULT_TARGETS[key].mode,
        path: override.path ?? DEFAULT_TARGETS[key].path,
      };
    }
  }

  return {
    exclude: manifest.exclude ?? [],
    include: manifest.include,
    targets,
  };
};
