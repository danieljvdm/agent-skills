import { Schema as S } from "effect";

import { DigestSchema } from "./path-digest.ts";

export const CatalogProvenanceSchema = S.Union([
  S.Struct({
    source: S.String,
    repository: S.String,
    resolved: S.String,
  }),
  S.Struct({
    package: S.String,
    version: S.String,
    skill: S.String,
    digest: DigestSchema,
  }),
]);
export type CatalogProvenance = typeof CatalogProvenanceSchema.Type;

export const ManagedSkillOutputSchema = S.Struct({
  resourceId: S.String,
  path: S.String,
  skill: S.String,
  target: S.Literals(["agents", "claude", "opencode"]),
  mode: S.Literals(["copy", "symlink"]),
  kind: S.Literals(["directory", "symlink"]),
  digest: DigestSchema,
  catalog: S.optional(CatalogProvenanceSchema),
});
export type ManagedSkillOutput = typeof ManagedSkillOutputSchema.Type;

export const ManagedAgentInstructionsOutputSchema = S.Struct({
  resourceId: S.Literal("setup:agent-instructions"),
  path: S.String,
  sourcePath: S.String,
  mode: S.Literal("copy"),
  kind: S.Literal("file"),
  digest: DigestSchema,
});
export type ManagedAgentInstructionsOutput = typeof ManagedAgentInstructionsOutputSchema.Type;

export const ManagedClaudeInstructionsOutputSchema = S.Struct({
  resourceId: S.Literal("setup:claude-instructions"),
  path: S.String,
  sourcePath: S.String,
  mode: S.Literal("symlink"),
  kind: S.Literal("symlink"),
  digest: DigestSchema,
});
export type ManagedClaudeInstructionsOutput = typeof ManagedClaudeInstructionsOutputSchema.Type;

export const ManagedGeneratedFileOutputSchema = S.Struct({
  resourceId: S.Literal("setup:vite-plus-github-actions"),
  path: S.String,
  sourcePath: S.String,
  mode: S.Literal("copy"),
  kind: S.Literal("file"),
  digest: DigestSchema,
});
export type ManagedGeneratedFileOutput = typeof ManagedGeneratedFileOutputSchema.Type;

export const ManagedInstructionOutputSchema = S.Union([
  ManagedAgentInstructionsOutputSchema,
  ManagedClaudeInstructionsOutputSchema,
]);
export type ManagedInstructionOutput = typeof ManagedInstructionOutputSchema.Type;

export const ManagedOutputSchema = S.Union([
  ManagedSkillOutputSchema,
  ManagedInstructionOutputSchema,
  ManagedGeneratedFileOutputSchema,
]);
export type ManagedOutput = typeof ManagedOutputSchema.Type;

export const EffectTsgoLockSchema = S.Struct({
  effectTsgoVersion: S.String,
  typescriptPackage: S.String,
  typescriptVersion: S.String,
});
export type EffectTsgoLock = typeof EffectTsgoLockSchema.Type;

export const EffectSourceLockSchema = S.Struct({
  packageName: S.String,
  packageVersion: S.String,
  path: S.String,
  repository: S.String,
  tag: S.String,
});
export type EffectSourceLock = typeof EffectSourceLockSchema.Type;

export const DevKitLockSchema = S.Struct({
  version: S.Literal(1),
  toolVersion: S.String,
  manifestDigest: DigestSchema,
  setup: S.optional(
    S.Struct({
      effectSource: S.optional(EffectSourceLockSchema),
      effectTsgo: S.optional(EffectTsgoLockSchema),
    }),
  ),
  outputs: S.Array(ManagedOutputSchema),
});
export type DevKitLock = typeof DevKitLockSchema.Type;

export const OwnershipReceiptSchema = S.Struct({
  resourceId: S.String,
  path: S.String,
  mode: S.Literals(["copy", "symlink"]),
  kind: S.Literals(["file", "directory", "symlink"]),
  digest: DigestSchema,
});
export type OwnershipReceipt = typeof OwnershipReceiptSchema.Type;

export const AppliedStateSchema = S.Struct({
  version: S.Literal(1),
  appliedLockDigest: DigestSchema,
  outputs: S.Array(OwnershipReceiptSchema),
});
export type AppliedState = typeof AppliedStateSchema.Type;
