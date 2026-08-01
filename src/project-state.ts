import { Schema } from "effect";

import { DigestSchema } from "./path-digest.ts";

export const ManagedSkillOutputSchema = Schema.Struct({
  resourceId: Schema.String,
  path: Schema.String,
  skill: Schema.String,
  target: Schema.Literals(["agents", "claude", "opencode"]),
  mode: Schema.Literals(["copy", "symlink"]),
  kind: Schema.Literals(["directory", "symlink"]),
  digest: DigestSchema,
  catalog: Schema.optional(
    Schema.Struct({
      source: Schema.String,
      repository: Schema.String,
      resolved: Schema.String,
    }),
  ),
});
export type ManagedSkillOutput = typeof ManagedSkillOutputSchema.Type;

export const EffectTsgoLockSchema = Schema.Struct({
  effectTsgoVersion: Schema.String,
  typescriptPackage: Schema.String,
  typescriptVersion: Schema.String,
});
export type EffectTsgoLock = typeof EffectTsgoLockSchema.Type;

export const EffectSourceLockSchema = Schema.Struct({
  packageName: Schema.String,
  packageVersion: Schema.String,
  path: Schema.String,
  repository: Schema.String,
  tag: Schema.String,
});
export type EffectSourceLock = typeof EffectSourceLockSchema.Type;

export const DevKitLockSchema = Schema.Struct({
  version: Schema.Literal(1),
  toolVersion: Schema.String,
  manifestDigest: DigestSchema,
  setup: Schema.optional(
    Schema.Struct({
      effectSource: Schema.optional(EffectSourceLockSchema),
      effectTsgo: Schema.optional(EffectTsgoLockSchema),
    }),
  ),
  outputs: Schema.Array(ManagedSkillOutputSchema),
});
export type DevKitLock = typeof DevKitLockSchema.Type;

export const OwnershipReceiptSchema = Schema.Struct({
  resourceId: Schema.String,
  path: Schema.String,
  mode: Schema.Literals(["copy", "symlink"]),
  kind: Schema.Literals(["directory", "symlink"]),
  digest: DigestSchema,
});
export type OwnershipReceipt = typeof OwnershipReceiptSchema.Type;

export const AppliedStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  appliedLockDigest: DigestSchema,
  outputs: Schema.Array(OwnershipReceiptSchema),
});
export type AppliedState = typeof AppliedStateSchema.Type;
