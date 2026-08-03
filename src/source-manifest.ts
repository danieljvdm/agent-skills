import { Schema } from "effect";

import { DigestSchema } from "./path-digest.ts";

export const ExternalSkillSourceSchema = Schema.Struct({
  id: Schema.String,
  repository: Schema.String,
  ref: Schema.String,
  skillsPath: Schema.String,
  include: Schema.Array(Schema.String),
  exclude: Schema.optional(Schema.Array(Schema.String)),
  licensePath: Schema.optional(Schema.String),
  stripFrontmatter: Schema.optional(Schema.Array(Schema.String)),
});

export type ExternalSkillSource = typeof ExternalSkillSourceSchema.Type;

/** Skills shipped by an npm package. Package contents are resolved by consumers. */
export const PackageSkillSourceSchema = Schema.Struct({
  id: Schema.String,
  package: Schema.String,
  skillsPath: Schema.String,
  include: Schema.Array(Schema.String),
  descriptions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export type PackageSkillSource = typeof PackageSkillSourceSchema.Type;

export const SkillSourcesManifestSchema = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  sources: Schema.Array(ExternalSkillSourceSchema),
  packages: Schema.optional(Schema.Array(PackageSkillSourceSchema)),
});

export type SkillSourcesManifest = typeof SkillSourcesManifestSchema.Type;

export const LockedSkillSourceSchema = Schema.Struct({
  id: Schema.String,
  repository: Schema.String,
  ref: Schema.String,
  resolved: Schema.String,
  skillsPath: Schema.String,
  include: Schema.Array(Schema.String),
  exclude: Schema.optional(Schema.Array(Schema.String)),
  skills: Schema.Array(Schema.String),
  descriptions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  digests: Schema.optional(Schema.Record(Schema.String, DigestSchema)),
  licensePath: Schema.optional(Schema.String),
  stripFrontmatter: Schema.optional(Schema.Array(Schema.String)),
});

export type LockedSkillSource = typeof LockedSkillSourceSchema.Type;

export const LockedPackageSkillSourceSchema = Schema.Struct({
  id: Schema.String,
  package: Schema.String,
  skillsPath: Schema.String,
  skills: Schema.Array(Schema.String),
  descriptions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export type LockedPackageSkillSource = typeof LockedPackageSkillSourceSchema.Type;

export const SkillSourcesLockSchema = Schema.Struct({
  version: Schema.Literal(1),
  sources: Schema.Array(LockedSkillSourceSchema),
  packages: Schema.optional(Schema.Array(LockedPackageSkillSourceSchema)),
});

export type SkillSourcesLock = typeof SkillSourcesLockSchema.Type;
