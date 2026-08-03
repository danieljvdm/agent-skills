export {
  type AgentInstructionsSetup,
  AgentInstructionsSetupSchema,
  type ClaudeInstructionsSetup,
  ClaudeInstructionsSetupSchema,
  type DevKitManifest,
  DevKitManifestSchema,
  type EffectSourceSetup,
  EffectSourceSetupSchema,
  type EffectTsgoSetup,
  EffectTsgoSetupSchema,
  type HarnessTarget,
  TargetConfigSchema,
} from "./manifest.ts";
export {
  applyEffectSourcePlan,
  EffectSourceCheckoutError,
  EffectSourceDependencyError,
  type EffectSourceOptions,
  type EffectSourcePlan,
  planEffectSource,
  syncEffectSource,
} from "./effect-source.ts";
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
  CatalogProvenanceSchema,
  DevKitLockSchema,
  EffectSourceLockSchema,
  EffectTsgoLockSchema,
  ManagedAgentInstructionsOutputSchema,
  ManagedClaudeInstructionsOutputSchema,
  ManagedInstructionOutputSchema,
  ManagedOutputSchema,
  ManagedSkillOutputSchema,
  OwnershipReceiptSchema,
  type AppliedState,
  type CatalogProvenance,
  type DevKitLock,
  type EffectSourceLock,
  type EffectTsgoLock,
  type ManagedAgentInstructionsOutput,
  type ManagedClaudeInstructionsOutput,
  type ManagedInstructionOutput,
  type ManagedOutput,
  type ManagedSkillOutput,
  type OwnershipReceipt,
} from "./project-state.ts";
export {
  refreshSkillCatalog,
  vendorExternalSkills,
  type CatalogRefreshOptions,
  type VendorOptions,
} from "./vendor.ts";
export {
  loadSkillCatalog,
  resolveSkillSources,
  type CatalogSkill,
  type ResolvedSkillSource,
  type SkillCatalog,
} from "./catalog.ts";
export {
  addCatalogSource,
  listCatalogSources,
  removeCatalogEntry,
  showCatalogSource,
  type CatalogAddOptions,
  type CatalogCommandOptions,
} from "./catalog-manager.ts";
export {
  inspectCatalogRepository,
  type CatalogInspection,
  type CatalogInspectOptions,
} from "./vendor.ts";
