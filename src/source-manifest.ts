import { Schema } from "effect";

export const ExternalSkillSourceSchema = Schema.Struct({
  id: Schema.String,
  repository: Schema.String,
  ref: Schema.String,
  skillsPath: Schema.String,
  include: Schema.Array(Schema.String),
  licensePath: Schema.optional(Schema.String),
  stripFrontmatter: Schema.optional(Schema.Array(Schema.String)),
});

export type ExternalSkillSource = typeof ExternalSkillSourceSchema.Type;

export const SkillSourcesManifestSchema = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  sources: Schema.Array(ExternalSkillSourceSchema),
});

export type SkillSourcesManifest = typeof SkillSourcesManifestSchema.Type;

export const LockedSkillSourceSchema = Schema.Struct({
  id: Schema.String,
  repository: Schema.String,
  ref: Schema.String,
  resolved: Schema.String,
  skillsPath: Schema.String,
  include: Schema.Array(Schema.String),
  skills: Schema.Array(Schema.String),
  licensePath: Schema.optional(Schema.String),
  stripFrontmatter: Schema.optional(Schema.Array(Schema.String)),
});

export type LockedSkillSource = typeof LockedSkillSourceSchema.Type;

export const SkillSourcesLockSchema = Schema.Struct({
  version: Schema.Literal(1),
  sources: Schema.Array(LockedSkillSourceSchema),
});

export type SkillSourcesLock = typeof SkillSourcesLockSchema.Type;
