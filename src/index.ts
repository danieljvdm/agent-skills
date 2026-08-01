export {
  type DevKitManifest,
  DevKitManifestSchema,
  type EffectTsgoSetup,
  EffectTsgoSetupSchema,
  type HarnessTarget,
  TargetConfigSchema,
} from "./manifest.ts";
export {
  CANONICAL_REPOSITORIES_DIRECTORY,
  DEV_KIT_GITIGNORE_ENTRIES,
  GitignoreConflictError,
  patchGitignoreContents,
  patchProjectGitignore,
  type GitignoreOptions,
  type GitignorePatch,
  UnsafeGitignorePathError,
} from "./gitignore.ts";
export {
  EFFECT_TSGO_PLUGIN_NAME,
  EFFECT_TSGO_TYPESCRIPT_VERSION,
  EFFECT_TSGO_VERSION,
  EffectTsgoDependencyError,
  InvalidEffectTsgoPackageNameError,
  type EffectTsgoPatchOptions,
  type EffectTsgoPatchPlan,
  EffectTsgoPatchCommandError,
  patchEffectTsgo,
  planEffectTsgoPatch,
} from "./effect-tsgo.ts";
export {
  ExternalSkillSourceSchema,
  type ExternalSkillSource,
  LockedSkillSourceSchema,
  type LockedSkillSource,
  SkillSourcesLockSchema,
  type SkillSourcesLock,
  SkillSourcesManifestSchema,
  type SkillSourcesManifest,
} from "./source-manifest.ts";
export {
  planProjectSkills,
  printSkillPlan,
  runProjectSkillPlan,
  type SkillPlan,
  type SyncOptions,
} from "./sync.ts";
export {
  AppliedStateSchema,
  DevKitLockSchema,
  EffectTsgoLockSchema,
  ManagedSkillOutputSchema,
  OwnershipReceiptSchema,
  type AppliedState,
  type DevKitLock,
  type EffectTsgoLock,
  type ManagedSkillOutput,
  type OwnershipReceipt,
} from "./project-state.ts";
export { vendorExternalSkills, type VendorOptions } from "./vendor.ts";
