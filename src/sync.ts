import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { Cause, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { DevKitManifestSchema, normalizeManifest } from "./manifest.ts";
import {
  loadSkillCatalog,
  resolveSkillSources,
  type CatalogSkill,
  type ResolvedSkillSource,
} from "./catalog.ts";
import { printDetail, printStatus, withSpinner } from "./cli-ui.ts";
import {
  applyEffectSourcePlan,
  planEffectSource,
  type EffectSourcePlan,
} from "./effect-source.ts";
import {
  applyEffectTsgoPatchPlan,
  planEffectTsgoPatch,
  type EffectTsgoPatchPlan,
} from "./effect-tsgo.ts";
import {
  digestSymlinkTarget,
  digestText,
  observePath,
  type ObservedPath,
} from "./path-digest.ts";
import {
  isPackageSkillSelector,
  resolvePackageSkillSelector,
} from "./package-skill-source.ts";
import {
  AppliedStateSchema,
  DevKitLockSchema,
  type AppliedState,
  type DevKitLock,
  type ManagedInstructionOutput,
  type ManagedOutput,
  type ManagedSkillOutput,
  type OwnershipReceipt,
} from "./project-state.ts";
import {
  acquireProjectProcessLock,
  PROJECT_PROCESS_LOCK_PATH,
} from "./project-process-lock.ts";
import { observeSymbolicLink } from "./node-symbolic-link.ts";
import { DEV_KIT_VERSION } from "./tool-metadata.ts";

export type SyncOptions = {
  readonly manifestPath?: string;
  readonly projectDir?: string;
  readonly lockfilePath?: string;
  readonly statePath?: string;
  readonly dryRun?: boolean;
  readonly locked?: boolean;
};

type SkillCatalog = Readonly<Record<string, ReadonlyArray<string>>>;

type ManagedPath = {
  readonly absolute: string;
  readonly relative: string;
};

type DesiredSkillOutput =
  | (Omit<ManagedSkillOutput, "mode" | "kind"> & {
      readonly mode: "copy";
      readonly kind: "directory";
      readonly source: string;
      readonly destination: string;
    })
  | (Omit<ManagedSkillOutput, "mode" | "kind"> & {
      readonly mode: "symlink";
      readonly kind: "symlink";
      readonly source: string;
      readonly destination: string;
      readonly linkTarget: string;
    });

type DesiredInstructionOutput = ManagedInstructionOutput & {
  readonly destination: string;
  readonly linkTarget: string;
};

type DesiredOutput = DesiredSkillOutput | DesiredInstructionOutput;

type SkillPlanAction =
  | {
      readonly action: "create" | "update";
      readonly desired: DesiredOutput;
      readonly observed: ObservedPath;
    }
  | {
      readonly action: "remove";
      readonly previous: OwnershipReceipt;
      readonly destination: string;
      readonly observed: ObservedPath;
    }
  | {
      readonly action: "unchanged";
      readonly desired: DesiredOutput;
      readonly observed: ObservedPath;
      readonly adopted: boolean;
    }
  | {
      readonly action: "conflict";
      readonly path: string;
      readonly reason: string;
    };

export type SkillPlan = {
  readonly projectDir: string;
  readonly lockfilePath: string;
  readonly statePath: string;
  readonly actions: ReadonlyArray<SkillPlanAction>;
  readonly effectSource?: EffectSourcePlan;
  readonly effectTsgo?: EffectTsgoPatchPlan;
  readonly nextLock: DevKitLock;
  readonly nextState: AppliedState;
  readonly metadataChanged: boolean;
};

class ManifestNotFoundError extends Schema.TaggedErrorClass<ManifestNotFoundError>()(
  "ManifestNotFoundError",
  { path: Schema.String },
) {
  override get message() {
    return `manifest not found: ${this.path}`;
  }
}

class StructuredFileError extends Schema.TaggedErrorClass<StructuredFileError>()(
  "StructuredFileError",
  { path: Schema.String, message: Schema.String },
) {}

class UnknownSkillOrFamilyError extends Schema.TaggedErrorClass<UnknownSkillOrFamilyError>()(
  "UnknownSkillOrFamilyError",
  { name: Schema.String, known: Schema.Array(Schema.String) },
) {
  override get message() {
    return `unknown skill or family "${this.name}". Known values: ${this.known.join(", ")}`;
  }
}

class InvalidSkillCatalogError extends Schema.TaggedErrorClass<InvalidSkillCatalogError>()(
  "InvalidSkillCatalogError",
  { family: Schema.String, message: Schema.String },
) {}

class CommandError extends Schema.TaggedErrorClass<CommandError>()("CommandError", {
  command: Schema.String,
  exitCode: Schema.Int,
  output: Schema.String,
}) {
  override get message() {
    return this.output.length > 0
      ? `${this.command} exited with code ${this.exitCode}: ${this.output}`
      : `${this.command} exited with code ${this.exitCode}`;
  }
}

class UnsafeManagedPathError extends Schema.TaggedErrorClass<UnsafeManagedPathError>()(
  "UnsafeManagedPathError",
  { path: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `unsafe managed path "${this.path}": ${this.reason}`;
  }
}

class InvalidProjectStateError extends Schema.TaggedErrorClass<InvalidProjectStateError>()(
  "InvalidProjectStateError",
  { message: Schema.String },
) {}

class LockedPlanMismatchError extends Schema.TaggedErrorClass<LockedPlanMismatchError>()(
  "LockedPlanMismatchError",
  { message: Schema.String },
) {}

class PlanConflictError extends Schema.TaggedErrorClass<PlanConflictError>()(
  "PlanConflictError",
  { conflicts: Schema.Array(Schema.String) },
) {
  override get message() {
    const heading = `plan has ${this.conflicts.length} conflict${this.conflicts.length === 1 ? "" : "s"}`;
    return `${heading}:\n${this.conflicts.map((conflict) => `  ${conflict}`).join("\n")}`;
  }
}

class ApplyRaceError extends Schema.TaggedErrorClass<ApplyRaceError>()("ApplyRaceError", {
  path: Schema.String,
}) {
  override get message() {
    return `managed path changed after planning: ${this.path}`;
  }
}

const SKILL_FAMILIES: SkillCatalog = { effect: ["effect-ts"] };
export const DEFAULT_MANIFEST = "dev-kit.jsonc";
const DEFAULT_LOCKFILE = "dev-kit.lock.json";
const DEFAULT_STATE = ".dev-kit/state.json";

const resolvePackageRoot = Effect.fn("resolvePackageRoot")(function* () {
  const path = yield* Path.Path;
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url));
  return path.resolve(path.dirname(scriptPath), "..");
});

const runCommand = Effect.fn("runCommand")(function* (
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const formatted = [command, ...args].join(" ");
  const child = yield* ChildProcess.make(command, args, { cwd, stderr: "pipe", stdout: "pipe" });
  const [output, exitCode] = yield* Effect.all([
    Stream.mkString(Stream.decodeText(child.all)),
    child.exitCode,
  ]);
  const trimmed = output.trim();
  if (exitCode !== 0) {
    return yield* new CommandError({ command: formatted, exitCode, output: trimmed });
  }
  return trimmed;
});

const resolveGitRoot = Effect.fn("resolveGitRoot")(function* (cwd: string) {
  return yield* runCommand(cwd, "git", ["rev-parse", "--show-toplevel"]);
});

const parseStructuredFile = Effect.fn("parseStructuredFile")(function* <A>(
  filePath: string,
  raw: string,
  schema: Schema.ConstraintDecoder<A>,
) {
  const errors: Array<ParseError> = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });
  const first = errors[0];
  if (first !== undefined) {
    return yield* new StructuredFileError({
      path: filePath,
      message: `${printParseErrorCode(first.error)} at offset ${first.offset}`,
    });
  }
  return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
    Effect.mapError((cause) => new StructuredFileError({ path: filePath, message: cause.message })),
  );
});

const readManifest = Effect.fn("readManifest")(function* (manifestPath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(manifestPath))) {
    return yield* new ManifestNotFoundError({ path: manifestPath });
  }
  const raw = yield* fs.readFileString(manifestPath);
  return yield* parseStructuredFile(manifestPath, raw, DevKitManifestSchema);
});

const readOptionalStructuredFile = Effect.fn("readOptionalStructuredFile")(function* <A>(
  filePath: string,
  schema: Schema.ConstraintDecoder<A>,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(filePath))) {
    return undefined;
  }
  return yield* parseStructuredFile(filePath, yield* fs.readFileString(filePath), schema);
});

const expandSelection = (
  include: ReadonlyArray<string>,
  exclude: ReadonlyArray<string>,
  availableSkills: ReadonlyArray<string>,
  skillFamilies: SkillCatalog,
) => {
  const known = [...new Set([...Object.keys(skillFamilies), ...availableSkills])].sort();
  const selected = new Set<string>();
  for (const name of include) {
    if (skillFamilies[name]) {
      for (const skill of skillFamilies[name]) selected.add(skill);
    } else if (availableSkills.includes(name) || isPackageSkillSelector(name)) {
      selected.add(name);
    } else {
      return Effect.fail(new UnknownSkillOrFamilyError({ name, known }));
    }
  }
  for (const name of exclude) {
    const family = skillFamilies[name];
    if (family) for (const skill of family) selected.delete(skill);
    else selected.delete(name);
  }
  return Effect.succeed([...selected].sort());
};

const portablePath = (path: Path.Path, value: string): string =>
  path.sep === "/" ? value : value.split(path.sep).join("/");

const resolveManagedPath = Effect.fn("resolveManagedPath")(function* (
  projectDir: string,
  candidate: string,
) {
  const path = yield* Path.Path;
  if (candidate.length === 0 || path.isAbsolute(candidate)) {
    return yield* new UnsafeManagedPathError({ path: candidate, reason: "must be a non-empty project-relative path" });
  }
  const absolute = path.resolve(projectDir, candidate);
  const relative = path.relative(projectDir, absolute);
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return yield* new UnsafeManagedPathError({ path: candidate, reason: "resolves outside the project" });
  }

  const segments = relative.split(path.sep);
  let ancestor = projectDir;
  for (const segment of segments.slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    const target = yield* observeSymbolicLink(ancestor);
    if (target.kind === "symlink") {
      return yield* new UnsafeManagedPathError({
        path: candidate,
        reason: `ancestor is a symlink: ${portablePath(path, path.relative(projectDir, ancestor))}`,
      });
    }
  }
  return { absolute, relative: portablePath(path, relative) } satisfies ManagedPath;
});

const pathsOverlap = (left: string, right: string): boolean =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

const validateReservedPaths = Effect.fn("validateReservedPaths")(function* (
  projectDir: string,
  reserved: ReadonlyArray<{ readonly label: string; readonly path: string }>,
  outputs: ReadonlyArray<Pick<ManagedOutput | OwnershipReceipt, "path">>,
) {
  const outputPaths = new Set<string>();
  for (const output of outputs) {
    outputPaths.add((yield* resolveManagedPath(projectDir, output.path)).relative);
  }

  for (let index = 0; index < reserved.length; index += 1) {
    const current = reserved[index];
    if (current === undefined) continue;
    for (const other of reserved.slice(index + 1)) {
      if (pathsOverlap(current.path, other.path)) {
        return yield* new InvalidProjectStateError({
          message: `${current.label} path ${current.path} overlaps ${other.label} path ${other.path}`,
        });
      }
    }
    for (const outputPath of outputPaths) {
      if (pathsOverlap(current.path, outputPath)) {
        return yield* new InvalidProjectStateError({
          message: `${current.label} path ${current.path} overlaps managed output ${outputPath}`,
        });
      }
    }
  }
});

const outputIdentity = (output: ManagedOutput) =>
  JSON.stringify({
    resourceId: output.resourceId,
    path: output.path,
    mode: output.mode,
    kind: output.kind,
    digest: output.digest,
    ...("skill" in output
      ? { skill: output.skill, target: output.target, catalog: output.catalog }
      : { sourcePath: output.sourcePath }),
  });

const validateInventory = Effect.fn("validateManagedInventory")(function* (
  projectDir: string,
  outputs: ReadonlyArray<ManagedOutput | OwnershipReceipt>,
  label: string,
) {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const sortedPaths: Array<string> = [];
  for (const output of outputs) {
    if (ids.has(output.resourceId)) {
      return yield* new InvalidProjectStateError({ message: `${label} contains duplicate resource id ${output.resourceId}` });
    }
    if (paths.has(output.path)) {
      return yield* new InvalidProjectStateError({ message: `${label} contains duplicate path ${output.path}` });
    }
    ids.add(output.resourceId);
    paths.add(output.path);
    sortedPaths.push((yield* resolveManagedPath(projectDir, output.path)).relative);
  }
  sortedPaths.sort();
  for (let index = 1; index < sortedPaths.length; index += 1) {
    const previous = sortedPaths[index - 1];
    const current = sortedPaths[index];
    if (previous === undefined || current === undefined) continue;
    if (current.startsWith(`${previous}/`)) {
      return yield* new InvalidProjectStateError({ message: `${label} contains overlapping paths ${previous} and ${current}` });
    }
  }
});

const validateCrossInventoryPaths = Effect.fn("validateCrossInventoryPaths")(function* (
  projectDir: string,
  outputs: ReadonlyArray<Pick<ManagedOutput | OwnershipReceipt, "path">>,
) {
  const uniquePaths = new Set<string>();
  for (const output of outputs) {
    uniquePaths.add((yield* resolveManagedPath(projectDir, output.path)).relative);
  }
  const sortedPaths = [...uniquePaths].sort();
  for (let index = 1; index < sortedPaths.length; index += 1) {
    const previous = sortedPaths[index - 1];
    const current = sortedPaths[index];
    if (previous === undefined || current === undefined) continue;
    if (current.startsWith(`${previous}/`)) {
      return yield* new InvalidProjectStateError({
        message: `desired and previously owned paths overlap: ${previous} and ${current}`,
      });
    }
  }
});

const buildDesiredOutputs = Effect.fn("buildDesiredSkillOutputs")(function* (
  projectDir: string,
  sourceBySkill: ReadonlyMap<string, ResolvedSkillSource>,
  skills: ReadonlyArray<CatalogSkill>,
  setup: ReturnType<typeof normalizeManifest>["setup"],
  targets: ReturnType<typeof normalizeManifest>["targets"],
) {
  const path = yield* Path.Path;
  const outputs: Array<DesiredOutput> = [];
  if (setup.claudeInstructions.enabled) {
    const source = yield* resolveManagedPath(projectDir, "AGENTS.md");
    const sourceObservation = yield* observePath(source.absolute);
    if (sourceObservation.kind !== "file") {
      return yield* new InvalidProjectStateError({
        message: "Claude instructions source is not a regular file: AGENTS.md",
      });
    }
    const managed = yield* resolveManagedPath(projectDir, "CLAUDE.md");
    const linkTarget = path.relative(path.dirname(managed.absolute), source.absolute);
    outputs.push({
      resourceId: "setup:claude-instructions",
      path: managed.relative,
      sourcePath: source.relative,
      mode: "symlink",
      kind: "symlink",
      digest: yield* digestSymlinkTarget(linkTarget),
      destination: managed.absolute,
      linkTarget,
    });
  }
  const agentsTarget = targets.agents;
  const duplicateOutput = skills.find((skill, index) =>
    skills.findIndex((candidate) => candidate.name === skill.name) !== index
  );
  if (duplicateOutput !== undefined) {
    const selectors = skills
      .filter((skill) => skill.name === duplicateOutput.name)
      .map((skill) => skill.selector);
    return yield* new InvalidProjectStateError({
      message: `selected skills would both install as ${duplicateOutput.name}: ${selectors.join(", ")}`,
    });
  }
  for (const skill of skills) {
    const resolvedSource = sourceBySkill.get(skill.selector);
    if (resolvedSource === undefined) {
      return yield* new InvalidProjectStateError({ message: `skill source is unavailable: ${skill.selector}` });
    }
    const source = resolvedSource.path;
    const sourceObservation = yield* observePath(source);
    if (sourceObservation.kind !== "directory") {
      return yield* new InvalidProjectStateError({ message: `skill source is not a directory: ${source}` });
    }
    for (const targetName of ["agents", "claude", "opencode"] as const) {
      const target = targets[targetName];
      if (!target.enabled) continue;
      const managed = yield* resolveManagedPath(projectDir, path.join(target.path, skill.name));
      if (target.mode === "copy") {
        outputs.push({
          resourceId: `skill:${skill.selector}@${targetName}`,
          path: managed.relative,
          skill: skill.name,
          target: targetName,
          mode: "copy",
          kind: "directory",
          digest: sourceObservation.digest,
          ...(resolvedSource.catalog ? { catalog: resolvedSource.catalog } : {}),
          source,
          destination: managed.absolute,
        });
        continue;
      }
      const linkSource =
        targetName === "agents" || !agentsTarget.enabled
          ? resolvedSource.linkPath ?? source
          : (yield* resolveManagedPath(projectDir, path.join(agentsTarget.path, skill.name))).absolute;
      const linkTarget = path.relative(path.dirname(managed.absolute), linkSource);
      const linkDigest = yield* digestSymlinkTarget(linkTarget);
      outputs.push({
        resourceId: `skill:${skill.selector}@${targetName}`,
        path: managed.relative,
        skill: skill.name,
        target: targetName,
        mode: "symlink",
        kind: "symlink",
        digest: linkDigest,
        ...(resolvedSource.catalog ? { catalog: resolvedSource.catalog } : {}),
        source,
        destination: managed.absolute,
        linkTarget,
      });
    }
  }
  yield* validateInventory(projectDir, outputs, "desired outputs");
  return outputs.sort((left, right) => left.path.localeCompare(right.path));
});

const canonicalLock = (lock: DevKitLock): string => `${JSON.stringify(lock, null, 2)}\n`;
const canonicalState = (state: AppliedState): string => `${JSON.stringify(state, null, 2)}\n`;

const planDesiredOutputs = Effect.fn("planDesiredSkillOutputs")(function* (
  projectDir: string,
  desired: ReadonlyArray<DesiredOutput>,
  currentLock: DevKitLock | undefined,
  currentState: AppliedState | undefined,
  nextLock: DevKitLock,
) {
  if (currentLock) yield* validateInventory(projectDir, currentLock.outputs, "dev-kit lock");
  if (currentState) yield* validateInventory(projectDir, currentState.outputs, "applied state");
  yield* validateCrossInventoryPaths(projectDir, [...desired, ...(currentState?.outputs ?? [])]);
  const lockById = new Map(currentLock?.outputs.map((output) => [output.resourceId, output]) ?? []);
  const receiptsById = new Map(currentState?.outputs.map((output) => [output.resourceId, output]) ?? []);
  const desiredKeys = new Set(desired.map((output) => `${output.resourceId}\0${output.path}`));
  const actions: Array<SkillPlanAction> = [];

  for (const output of desired) {
    const observed = yield* observePath(output.destination);
    const receipt = receiptsById.get(output.resourceId);
    const sameReceipt = receipt?.path === output.path ? receipt : undefined;
    const locked = lockById.get(output.resourceId);
    const adoptable = locked !== undefined && outputIdentity(locked) === outputIdentity(output);

    if (observed.kind === "missing") {
      actions.push({ action: "create", desired: output, observed });
    } else if (observed.kind === output.kind && observed.digest === output.digest) {
      if (sameReceipt || adoptable) {
        actions.push({ action: "unchanged", desired: output, observed, adopted: !sameReceipt });
      } else {
        actions.push({ action: "conflict", path: output.path, reason: "destination exists but is not owned" });
      }
    } else if (
      sameReceipt &&
      observed.kind === sameReceipt.kind &&
      observed.digest === sameReceipt.digest
    ) {
      actions.push({ action: "update", desired: output, observed });
    } else {
      actions.push({
        action: "conflict",
        path: output.path,
        reason: sameReceipt ? "owned destination was modified" : "destination exists but is not owned",
      });
    }
  }

  for (const receipt of currentState?.outputs ?? []) {
    if (desiredKeys.has(`${receipt.resourceId}\0${receipt.path}`)) continue;
    const managed = yield* resolveManagedPath(projectDir, receipt.path);
    const observed = yield* observePath(managed.absolute);
    if (observed.kind === "missing") continue;
    if (observed.kind === receipt.kind && observed.digest === receipt.digest) {
      actions.push({ action: "remove", previous: receipt, destination: managed.absolute, observed });
    } else {
      actions.push({ action: "conflict", path: receipt.path, reason: "stale owned destination was modified" });
    }
  }

  const nextState: AppliedState = {
    version: 1,
    appliedLockDigest: yield* digestText(canonicalLock(nextLock)),
    outputs: desired.map(({ resourceId, path, mode, kind, digest }) => ({
      resourceId,
      path,
      mode,
      kind,
      digest,
    })),
  };
  return { actions: actions.sort((left, right) => {
    const leftPath = left.action === "remove" ? left.previous.path : left.action === "conflict" ? left.path : left.desired.path;
    const rightPath = right.action === "remove" ? right.previous.path : right.action === "conflict" ? right.path : right.desired.path;
    return leftPath.localeCompare(rightPath);
  }), nextState };
});

const lockedPlanMatches = (current: DevKitLock, next: DevKitLock): boolean =>
  current.toolVersion === next.toolVersion &&
  current.manifestDigest === next.manifestDigest &&
  JSON.stringify(current.setup) === JSON.stringify(next.setup) &&
  current.outputs.length === next.outputs.length &&
  current.outputs.every((output, index) => {
    const nextOutput = next.outputs[index];
    return nextOutput !== undefined && outputIdentity(output) === outputIdentity(nextOutput);
  });

export const planProjectSkills = Effect.fn("planProjectSkills")(function* (options: SyncOptions) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const initialDir = path.resolve(options.projectDir ?? ".");
  const discoveredRoot = yield* resolveGitRoot(initialDir).pipe(
    Effect.catchTag("CommandError", (error) =>
      error.output.includes("not a git repository")
        ? Effect.succeed(initialDir)
        : Effect.fail(error),
    ),
  );
  const projectDir = yield* fs.realPath(discoveredRoot);
  const manifestManaged = yield* resolveManagedPath(projectDir, options.manifestPath ?? DEFAULT_MANIFEST);
  const lockManaged = yield* resolveManagedPath(projectDir, options.lockfilePath ?? DEFAULT_LOCKFILE);
  const stateManaged = yield* resolveManagedPath(projectDir, options.statePath ?? DEFAULT_STATE);
  const processLockManaged = yield* resolveManagedPath(projectDir, PROJECT_PROCESS_LOCK_PATH);
  const packageRoot = yield* resolvePackageRoot();
  const manifest = normalizeManifest(yield* readManifest(manifestManaged.absolute));
  const effectSource = manifest.setup.effectSource.enabled
    ? yield* planEffectSource({
        packageName: manifest.setup.effectSource.packageName,
        path: manifest.setup.effectSource.path,
        projectDir,
        repository: manifest.setup.effectSource.repository,
      })
    : undefined;
  const effectTsgo = manifest.setup.effectTsgo.enabled
    ? yield* planEffectTsgoPatch({
        force: manifest.setup.effectTsgo.force,
        projectDir,
        typescriptPackage: manifest.setup.effectTsgo.typescriptPackage,
      })
    : undefined;
  const catalog = yield* loadSkillCatalog(packageRoot, projectDir);
  const availableSkills = catalog.skills.map((skill) => skill.selector);
  const skillFamilies = { ...SKILL_FAMILIES, ...catalog.families };
  for (const [family, familySkills] of Object.entries(skillFamilies)) {
    if (availableSkills.includes(family)) {
      return yield* new InvalidSkillCatalogError({ family, message: `family name conflicts with a skill name: ${family}` });
    }
    const missing = familySkills.filter((skill) => !availableSkills.includes(skill));
    if (missing.length > 0) {
      return yield* new InvalidSkillCatalogError({ family, message: `family references missing skills: ${missing.join(", ")}` });
    }
  }
  const selectedSelectors = yield* expandSelection(manifest.include, manifest.exclude, availableSkills, skillFamilies);
  const catalogBySelector = new Map(catalog.skills.map((skill) => [skill.selector, skill]));
  const sourceBySkill = yield* withSpinner(
    "Resolving selected skills",
    resolveSkillSources(packageRoot, projectDir, selectedSelectors, options.dryRun !== true),
  );
  const selectedSkills: Array<CatalogSkill> = [];
  for (const selector of selectedSelectors) {
    const catalogSkill = catalogBySelector.get(selector);
    if (catalogSkill !== undefined) {
      selectedSkills.push(catalogSkill);
      continue;
    }
    const resolved = sourceBySkill.get(selector);
    if (resolved?.catalog !== undefined && "package" in resolved.catalog) {
      selectedSkills.push({
        name: resolved.catalog.skill,
        selector,
        description: "",
        source: resolved.catalog.package,
        bundled: false,
        package: {
          name: resolved.catalog.package,
          version: resolved.catalog.version,
        },
      });
      continue;
    }
    return yield* new InvalidProjectStateError({
      message: `selected skill is unavailable: ${selector}`,
    });
  }
  const desired = yield* buildDesiredOutputs(
    projectDir,
    sourceBySkill,
    selectedSkills,
    manifest.setup,
    manifest.targets,
  );
  const nextLock: DevKitLock = {
    version: 1,
    toolVersion: DEV_KIT_VERSION,
    manifestDigest: yield* digestText(JSON.stringify(manifest)),
    setup: {
      ...(effectSource === undefined
        ? {}
        : {
            effectSource: {
              packageName: effectSource.packageName,
              packageVersion: effectSource.packageVersion,
              path: effectSource.path,
              repository: effectSource.repository,
              tag: effectSource.tag,
            },
          }),
      ...(effectTsgo === undefined
        ? {}
        : {
            effectTsgo: {
              effectTsgoVersion: effectTsgo.effectTsgoVersion,
              typescriptPackage: effectTsgo.typescriptPackage,
              typescriptVersion: effectTsgo.typescriptVersion,
            },
          }),
    },
    outputs: desired.map((output): ManagedOutput =>
      "skill" in output
        ? {
            resourceId: output.resourceId,
            path: output.path,
            skill: output.skill,
            target: output.target,
            mode: output.mode,
            kind: output.kind,
            digest: output.digest,
            ...(output.catalog ? { catalog: output.catalog } : {}),
          }
        : {
            resourceId: output.resourceId,
            path: output.path,
            sourcePath: output.sourcePath,
            mode: output.mode,
            kind: output.kind,
            digest: output.digest,
          },
    ),
  };
  const reservedPaths = [
    { label: "manifest", path: manifestManaged.relative },
    { label: "lockfile", path: lockManaged.relative },
    { label: "state", path: stateManaged.relative },
    { label: "process lock", path: processLockManaged.relative },
    ...(effectSource === undefined
      ? []
      : [{ label: "Effect source checkout", path: effectSource.path }]),
  ];
  yield* validateReservedPaths(projectDir, reservedPaths, desired);
  const currentLock = yield* readOptionalStructuredFile(lockManaged.absolute, DevKitLockSchema);
  const currentState = yield* readOptionalStructuredFile(stateManaged.absolute, AppliedStateSchema);
  yield* validateReservedPaths(
    projectDir,
    reservedPaths,
    [
      ...(currentLock?.outputs ?? []),
      ...(currentState?.outputs ?? []),
    ],
  );
  if (options.locked) {
    if (!currentLock) {
      return yield* new LockedPlanMismatchError({ message: "dev-kit.lock.json is required with --locked" });
    }
    if (!lockedPlanMatches(currentLock, nextLock)) {
      return yield* new LockedPlanMismatchError({ message: "manifest or packaged skills differ from dev-kit.lock.json" });
    }
  }
  const planned = yield* planDesiredOutputs(projectDir, desired, currentLock, currentState, nextLock);
  return {
    projectDir,
    lockfilePath: lockManaged.absolute,
    statePath: stateManaged.absolute,
    actions: planned.actions,
    ...(effectSource === undefined ? {} : { effectSource }),
    ...(effectTsgo === undefined ? {} : { effectTsgo }),
    nextLock,
    nextState: planned.nextState,
    metadataChanged:
      JSON.stringify(currentLock) !== JSON.stringify(nextLock) ||
      JSON.stringify(currentState) !== JSON.stringify(planned.nextState),
  } satisfies SkillPlan;
});

const formatAction = (action: SkillPlanAction): string => {
  if (action.action === "conflict") return `! ${action.path}: ${action.reason}`;
  if (action.action === "remove") return `− ${action.previous.resourceId} → ${action.previous.path}`;
  const verb = action.desired.mode === "copy" ? "copy" : "link";
  const adoption = action.action === "unchanged" && action.adopted ? " (adopt)" : "";
  const marker = action.action === "create" ? "+" : action.action === "update" ? "~" : "=";
  const source = "skill" in action.desired
    ? action.desired.skill
    : action.desired.sourcePath;
  return `${marker} ${verb} ${source} → ${action.desired.path}${adoption}`;
};

const operationalChangeCount = (plan: SkillPlan): number =>
  plan.actions.filter((action) => action.action !== "unchanged").length +
  (plan.effectSource?.action === "sync" ? 1 : 0) +
  (plan.effectTsgo !== undefined && !plan.effectTsgo.alreadyPatched ? 1 : 0);

const plannedChangeCount = (plan: SkillPlan): number => {
  const operational = operationalChangeCount(plan);
  return operational === 0 && plan.metadataChanged ? 1 : operational;
};

export const printSkillPlan = Effect.fn("printSkillPlan")(function* (plan: SkillPlan) {
  const changes = plannedChangeCount(plan);
  if (changes === 0) {
    yield* printStatus("success", "Already up to date");
    return;
  }
  yield* printStatus("plan", `${changes} change${changes === 1 ? "" : "s"} planned`);
  for (const action of plan.actions) {
    if (action.action !== "unchanged") yield* printDetail(formatAction(action));
  }
  if (plan.effectSource?.action === "sync") {
    yield* printDetail(
      `+ Effect source ${plan.effectSource.tag} → ${plan.effectSource.path}`,
    );
  }
  if (plan.effectTsgo !== undefined && !plan.effectTsgo.alreadyPatched) {
    yield* printDetail(
      `+ TypeScript patch @effect/tsgo@${plan.effectTsgo.effectTsgoVersion} → ${plan.effectTsgo.typescriptPackage}@${plan.effectTsgo.typescriptVersion}`,
    );
  }
  if (operationalChangeCount(plan) === 0 && plan.metadataChanged) {
    yield* printDetail("+ Dev kit metadata");
  }
});

const observationsEqual = (left: ObservedPath, right: ObservedPath): boolean =>
  left.kind === right.kind &&
  (left.kind === "missing" || (right.kind !== "missing" && left.digest === right.digest));

const findNestedSymbolicLink = Effect.fn("findNestedSkillSymbolicLink")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    if ((yield* observeSymbolicLink(current)).kind === "symlink") return current;
    const info = yield* fs.stat(current);
    if (info.type !== "Directory") continue;
    for (const entry of yield* fs.readDirectory(current)) {
      pending.push(path.join(current, entry));
    }
  }
  return undefined;
});

const verifyPackageSkillSources = Effect.fn("verifyPackageSkillSources")(function* (
  plan: SkillPlan,
) {
  const verified = new Set<string>();
  for (const action of plan.actions) {
    if (action.action === "remove" || action.action === "conflict") continue;
    if (!("skill" in action.desired)) continue;
    const catalog = action.desired.catalog;
    if (catalog === undefined || !("package" in catalog)) continue;
    const selector = `${catalog.package}#${catalog.skill}`;
    const key = `${selector}\0${catalog.version}\0${catalog.digest}`;
    if (verified.has(key)) continue;
    const resolved = yield* resolvePackageSkillSelector(plan.projectDir, selector);
    const observation = yield* observePath(resolved.path);
    if (resolved.path !== action.desired.source || resolved.version !== catalog.version ||
      observation.kind !== "directory" || observation.digest !== catalog.digest) {
      return yield* new ApplyRaceError({ path: action.desired.source });
    }
    verified.add(key);
  }
});

const applyPlannedSkillChanges = Effect.fn("applyPlannedSkillChanges")(function* (plan: SkillPlan) {
  const conflicts = plan.actions.filter((action) => action.action === "conflict");
  if (conflicts.length > 0) {
    return yield* new PlanConflictError({
      conflicts: conflicts.map((action) => action.action === "conflict" ? `${action.path}: ${action.reason}` : ""),
    });
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mutating = plan.actions.filter(
    (action): action is Exclude<SkillPlanAction, { readonly action: "unchanged" | "conflict" }> =>
      action.action === "create" || action.action === "update" || action.action === "remove",
  );
  for (const action of mutating) {
    const destination = action.action === "remove" ? action.destination : action.desired.destination;
    if (!observationsEqual(yield* observePath(destination), action.observed)) {
      return yield* new ApplyRaceError({ path: action.action === "remove" ? action.previous.path : action.desired.path });
    }
  }

  if (mutating.length === 0 && !plan.metadataChanged) {
    return;
  }

  const tempDir = yield* fs.makeTempDirectoryScoped({ directory: plan.projectDir, prefix: ".dev-kit-apply-" });
  const stageDir = path.join(tempDir, "stage");
  const backupDir = path.join(tempDir, "backup");
  const stagedByResource = new Map<string, string>();
  let stageIndex = 0;
  for (const action of mutating) {
    if (action.action === "remove") continue;
    const staged = path.join(stageDir, String(stageIndex++));
    yield* fs.makeDirectory(path.dirname(staged), { recursive: true });
    if (action.desired.mode === "copy") {
      yield* fs.copy(action.desired.source, staged, { overwrite: true });
      const symbolicLink = yield* findNestedSymbolicLink(staged);
      if (symbolicLink !== undefined) {
        return yield* new InvalidProjectStateError({
          message: `staged skill contains a symlink: ${action.desired.path}`,
        });
      }
    } else {
      yield* fs.symlink(action.desired.linkTarget, staged);
    }
    const observation = yield* observePath(staged);
    if (observation.kind !== action.desired.kind || observation.digest !== action.desired.digest) {
      return yield* new InvalidProjectStateError({ message: `staged output digest mismatch for ${action.desired.path}` });
    }
    stagedByResource.set(action.desired.resourceId, staged);
  }

  yield* verifyPackageSkillSources(plan);

  const stagedLock = path.join(tempDir, "next-lock.json");
  const stagedState = path.join(tempDir, "next-state.json");
  yield* fs.writeFileString(stagedLock, canonicalLock(plan.nextLock));
  yield* fs.writeFileString(stagedState, canonicalState(plan.nextState));

  type Replacement = {
    readonly destination: string;
    readonly backup: string;
    readonly expected?: ObservedPath;
    readonly path: string;
    readonly staged?: string;
  };
  const replacements: Array<Replacement> = [];
  let replacementIndex = 0;
  for (const action of mutating) {
    const staged = action.action === "remove"
      ? undefined
      : stagedByResource.get(action.desired.resourceId);
    if (action.action !== "remove" && staged === undefined) {
      return yield* new InvalidProjectStateError({
        message: `missing staged output for ${action.desired.resourceId}`,
      });
    }
    replacements.push({
      destination: action.action === "remove" ? action.destination : action.desired.destination,
      backup: path.join(backupDir, String(replacementIndex++)),
      expected: action.observed,
      path: action.action === "remove" ? action.previous.path : action.desired.path,
      ...(staged === undefined ? {} : { staged }),
    });
  }
  replacements.push(
    {
      destination: plan.lockfilePath,
      backup: path.join(backupDir, "lock"),
      path: plan.lockfilePath,
      staged: stagedLock,
    },
    {
      destination: plan.statePath,
      backup: path.join(backupDir, "state"),
      path: plan.statePath,
      staged: stagedState,
    },
  );

  const installed: Array<string> = [];
  const backedUp: Array<Replacement> = [];
  const rollback = Effect.gen(function* () {
    for (const destination of [...installed].reverse()) {
      yield* fs.remove(destination, { recursive: true, force: true });
    }
    for (const replacement of [...backedUp].reverse()) {
      yield* fs.makeDirectory(path.dirname(replacement.destination), { recursive: true });
      yield* fs.rename(replacement.backup, replacement.destination);
    }
  });

  const apply = Effect.gen(function* () {
    for (const replacement of replacements) {
      const observed = yield* observePath(replacement.destination);
      if (
        replacement.expected !== undefined &&
        !observationsEqual(observed, replacement.expected)
      ) {
        return yield* new ApplyRaceError({ path: replacement.path });
      }
      if (observed.kind !== "missing") {
        yield* fs.makeDirectory(path.dirname(replacement.backup), { recursive: true });
        yield* fs.rename(replacement.destination, replacement.backup);
        backedUp.push(replacement);
      }
      if (replacement.staged) {
        yield* fs.makeDirectory(path.dirname(replacement.destination), { recursive: true });
        yield* fs.rename(replacement.staged, replacement.destination);
        installed.push(replacement.destination);
      }
    }
  });

  yield* Effect.uninterruptible(apply.pipe(
    Effect.catchCause((applyCause) =>
      rollback.pipe(
        Effect.catchCause((rollbackCause) =>
          Effect.failCause(Cause.combine(applyCause, rollbackCause)),
        ),
        Effect.andThen(Effect.failCause(applyCause)),
      ),
    ),
  ));
});

export const runProjectSkillPlan = Effect.fn("runProjectSkillPlan")(function* (options: SyncOptions) {
  const plan = yield* planProjectSkills(options);
  if (options.dryRun) yield* printSkillPlan(plan);
  const conflicts = plan.actions.filter((action) => action.action === "conflict");
  if (conflicts.length > 0) {
    return yield* new PlanConflictError({
      conflicts: conflicts.map((action) => action.action === "conflict" ? `${action.path}: ${action.reason}` : ""),
    });
  }
  if (options.dryRun) return;

  yield* acquireProjectProcessLock(plan.projectDir);
  const replanned = yield* planProjectSkills(options);
  const originalSignature = JSON.stringify({
    actions: plan.actions,
    effectSource: plan.effectSource,
    effectTsgo: plan.effectTsgo,
    nextLock: plan.nextLock,
    nextState: plan.nextState,
  });
  const nextSignature = JSON.stringify({
    actions: replanned.actions,
    effectSource: replanned.effectSource,
    effectTsgo: replanned.effectTsgo,
    nextLock: replanned.nextLock,
    nextState: replanned.nextState,
  });
  if (originalSignature !== nextSignature) {
    return yield* new ApplyRaceError({ path: "project state" });
  }
  const changes = plannedChangeCount(replanned);
  yield* withSpinner(
    "Applying dev kit",
    Effect.gen(function* () {
      if (replanned.effectSource !== undefined) {
        yield* applyEffectSourcePlan(replanned.effectSource);
      }
      if (replanned.effectTsgo !== undefined) {
        yield* applyEffectTsgoPatchPlan(replanned.effectTsgo);
      }
      yield* applyPlannedSkillChanges(replanned);
    }),
  );
  yield* printStatus(
    "success",
    changes === 0 && !replanned.metadataChanged ? "Dev kit up to date" : "Dev kit ready",
    changes > 0 ? `${changes} change${changes === 1 ? "" : "s"}` : undefined,
  );
});
