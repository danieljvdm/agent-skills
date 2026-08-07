import { Schema as S } from "effect";

import { DigestSchema } from "./path-digest.ts";

export const ExternalSkillSourceSchema = S.Struct({
  id: S.String,
  repository: S.String,
  ref: S.String,
  skillsPath: S.String,
  include: S.Array(S.String),
  exclude: S.optional(S.Array(S.String)),
  licensePath: S.optional(S.String),
  stripFrontmatter: S.optional(S.Array(S.String)),
});

export type ExternalSkillSource = typeof ExternalSkillSourceSchema.Type;

export const SkillSourcesManifestSchema = S.Struct({
  $schema: S.optional(S.String),
  sources: S.Array(ExternalSkillSourceSchema),
});

export type SkillSourcesManifest = typeof SkillSourcesManifestSchema.Type;

export const LockedSkillSourceSchema = S.Struct({
  id: S.String,
  repository: S.String,
  ref: S.String,
  resolved: S.String,
  skillsPath: S.String,
  include: S.Array(S.String),
  exclude: S.optional(S.Array(S.String)),
  skills: S.Array(S.String),
  descriptions: S.optional(S.Record(S.String, S.String)),
  digests: S.optional(S.Record(S.String, DigestSchema)),
  licensePath: S.optional(S.String),
  stripFrontmatter: S.optional(S.Array(S.String)),
});

export type LockedSkillSource = typeof LockedSkillSourceSchema.Type;

export const SkillSourcesLockSchema = S.Struct({
  version: S.Literal(1),
  sources: S.Array(LockedSkillSourceSchema),
});

export type SkillSourcesLock = typeof SkillSourcesLockSchema.Type;
