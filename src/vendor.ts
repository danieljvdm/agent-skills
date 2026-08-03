import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { printStatus, withSpinner } from "./cli-ui.ts";
import { isPortablePackageSkillPath } from "./package-skill-path.ts";
import { observePath, type Digest } from "./path-digest.ts";
import { acquireProjectProcessLock } from "./project-process-lock.ts";

import {
  SkillSourcesLockSchema,
  SkillSourcesManifestSchema,
  type ExternalSkillSource,
  type LockedSkillSource,
  type LockedPackageSkillSource,
  type PackageSkillSource,
  type SkillSourcesLock,
} from "./source-manifest.ts";
import { isTypeScriptPackageName } from "./typescript-package-name.ts";

export type CatalogRefreshOptions = {
  readonly repoDir?: string;
  readonly sourcesPath?: string;
  readonly lockfilePath?: string;
  readonly dryRun?: boolean;
  readonly locked?: boolean;
  readonly updateSourceIds?: ReadonlyArray<string>;
  readonly pinSourceIds?: ReadonlyArray<string>;
};
/** @deprecated Use CatalogRefreshOptions. */
export type VendorOptions = CatalogRefreshOptions;

export type CatalogInspection = {
  readonly id: string;
  readonly repository: string;
  readonly ref: string;
  readonly resolved: string;
  readonly skillsPath: string;
  readonly skills: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly licensePath?: string;
};

export type CatalogInspectOptions = {
  readonly repository: string;
  readonly id?: string;
  readonly ref?: string;
  readonly skillsPath?: string;
  readonly repoDir?: string;
};

type PreparedSource = {
  readonly source: ExternalSkillSource;
  readonly resolved: string;
  readonly skills: ReadonlyArray<string>;
  readonly checkoutDir: string;
  readonly licenseSource?: string;
};

class SourceManifestError extends Schema.TaggedErrorClass<SourceManifestError>()(
  "SourceManifestError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

class InvalidSourceError extends Schema.TaggedErrorClass<InvalidSourceError>()(
  "InvalidSourceError",
  {
    source: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `invalid source "${this.source}": ${this.reason}`;
  }
}

class SkillCollisionError extends Schema.TaggedErrorClass<SkillCollisionError>()(
  "SkillCollisionError",
  {
    skill: Schema.String,
    owners: Schema.Array(Schema.String),
  },
) {
  override get message() {
    return `skill "${this.skill}" is owned by more than one source: ${this.owners.join(", ")}`;
  }
}

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

const DEFAULT_SOURCES_PATH = "skill-sources.jsonc";
const DEFAULT_LOCKFILE_PATH = "skill-sources.lock.json";
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SOURCE_IDS = new Set(["effect"]);

const inferSourceId = (repository: string): string => {
  const cleaned = repository.replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  const segments = cleaned.split(/[\\/:]+/).filter(Boolean);
  const tail = segments.slice(-2).join("-").toLowerCase();
  return tail.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
};

const containsControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const normalizeRepositoryLocator = (
  repository: string,
): Effect.Effect<{
  readonly repository: string;
  readonly ref?: string;
  readonly skillsPath?: string;
}, InvalidSourceError> => {
  if (containsControlCharacter(repository)) {
    return Effect.fail(new InvalidSourceError({ source: repository, reason: "repository contains control characters" }));
  }
  try {
    const url = new URL(repository);
    if ((url.protocol === "http:" || url.protocol === "https:") && (url.username || url.password)) {
      return Effect.fail(new InvalidSourceError({ source: repository, reason: "repository URLs must not contain credentials" }));
    }
    if (url.hostname.toLowerCase() !== "github.com") return Effect.succeed({ repository });
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const [owner, rawName] = segments;
    if (owner === undefined || rawName === undefined) return Effect.succeed({ repository });
    const name = rawName.replace(/\.git$/i, "");
    const normalized = `https://github.com/${owner}/${name}.git`;
    if (segments[2] === "tree" && segments[3]) {
      return Effect.succeed({
        repository: normalized,
        ref: segments[3],
        ...(segments.length > 4 ? { skillsPath: segments.slice(4).join("/") } : {}),
      });
    }
    return Effect.succeed({ repository: normalized });
  } catch {
    return Effect.succeed({ repository });
  }
};

const runCommand = Effect.fn("runVendorCommand")(function* (
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

const resolveGitRoot = Effect.fn("resolveVendorGitRoot")(function* (cwd: string) {
  return yield* runCommand(cwd, "git", ["rev-parse", "--show-toplevel"]);
});

const readJsonc = Effect.fn("readVendorJsonc")(function* <A>(
  filePath: string,
  schema: Schema.ConstraintDecoder<A>,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(filePath))) {
    return yield* new SourceManifestError({ path: filePath, message: "file not found" });
  }

  const raw = yield* fs.readFileString(filePath);
  const errors: Array<ParseError> = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });

  const first = errors[0];
  if (first !== undefined) {
    return yield* new SourceManifestError({
      path: filePath,
      message: `${printParseErrorCode(first.error)} at offset ${first.offset}`,
    });
  }

  return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
    Effect.mapError(
      (cause) => new SourceManifestError({ path: filePath, message: cause.message }),
    ),
  );
});

const resolveInside = (
  path: Path.Path,
  root: string,
  relativePath: string,
  sourceId: string,
  field: string,
  allowRoot = false,
) => {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (
    (!allowRoot && relative.length === 0) ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return Effect.fail(
      new InvalidSourceError({
        source: sourceId,
        reason: `${field} must be a relative path inside the source repository`,
      }),
    );
  }
  return Effect.succeed(resolved);
};

const ensureCanonicalPathInside = Effect.fn("ensureCanonicalSourcePathInside")(function* (
  root: string,
  target: string,
  sourceId: string,
  field: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [canonicalRoot, canonicalTarget] = yield* Effect.all([
    fs.realPath(root),
    fs.realPath(target),
  ]);
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return yield* new InvalidSourceError({
      source: sourceId,
      reason: `${field} resolves outside the source repository`,
    });
  }
  return canonicalTarget;
});

const rejectGitSymlinks = Effect.fn("rejectGitSymlinks")(function* (
  checkoutDir: string,
  relativePath: string,
  sourceId: string,
) {
  const entries = yield* runCommand(checkoutDir, "git", [
    "ls-files",
    "--stage",
    "--",
    relativePath,
  ]);
  const symlink = entries.split(/\r?\n/).find((line) => line.startsWith("120000 "));
  if (symlink) {
    return yield* new InvalidSourceError({
      source: sourceId,
      reason: `symlinks are not allowed in catalog paths: ${symlink.slice(symlink.indexOf("\t") + 1)}`,
    });
  }
});

const discoverSkills = Effect.fn("discoverVendoredSkills")(function* (
  skillsDir: string,
  source: ExternalSkillSource,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!(yield* fs.exists(skillsDir))) {
    return yield* new InvalidSourceError({
      source: source.id,
      reason: `skillsPath does not exist: ${source.skillsPath}`,
    });
  }

  const entries = yield* fs.readDirectory(skillsDir);
  const discovered: Array<string> = [];
  for (const entry of entries) {
    const skillDir = path.join(skillsDir, entry);
    const info = yield* fs.stat(skillDir);
    const skillDocumentPath = path.join(skillDir, "SKILL.md");
    if (info.type === "Directory" && (yield* fs.exists(skillDocumentPath))) {
      const skillDocument = yield* fs.readFileString(skillDocumentPath);
      const frontmatter = skillDocument.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const declaredName = frontmatter?.[1]
        ?.split(/\r?\n/)
        .find((line) => line.startsWith("name:"))
        ?.slice("name:".length)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
      if (declaredName !== entry) {
        return yield* new InvalidSourceError({
          source: source.id,
          reason: `${source.skillsPath}/${entry}/SKILL.md must declare name: ${entry}`,
        });
      }
      discovered.push(entry);
    }
  }
  discovered.sort();

  const includeAll = source.include.length === 1 && source.include[0] === "*";
  if (source.include.includes("*") && !includeAll) {
    return yield* new InvalidSourceError({
      source: source.id,
      reason: 'include must contain either "*" or explicit skill names, not both',
    });
  }

  const selected = (includeAll ? discovered : [...source.include]).filter(
    (skill) => !(source.exclude ?? []).includes(skill),
  );
  if (selected.length === 0) {
    return yield* new InvalidSourceError({
      source: source.id,
      reason: "include must select at least one skill",
    });
  }

  for (const skill of selected) {
    if (!SKILL_NAME_PATTERN.test(skill)) {
      return yield* new InvalidSourceError({
        source: source.id,
        reason: `invalid skill name "${skill}"`,
      });
    }
    if (!discovered.includes(skill)) {
      return yield* new InvalidSourceError({
        source: source.id,
        reason: `skill not found under ${source.skillsPath}: ${skill}`,
      });
    }
  }

  return [...new Set(selected)].sort();
});

const prepareSource = Effect.fn("prepareSkillSource")(function* (
  tempDir: string,
  source: ExternalSkillSource,
  lockedSource: LockedSkillSource | undefined,
  useLock: boolean,
  validateLockConfig = useLock,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!SOURCE_ID_PATTERN.test(source.id)) {
    return yield* new InvalidSourceError({
      source: source.id,
      reason: "id must use lowercase letters, numbers, and hyphens",
    });
  }
  if (RESERVED_SOURCE_IDS.has(source.id)) {
    return yield* new InvalidSourceError({
      source: source.id,
      reason: "id conflicts with a built-in skill family",
    });
  }
  if (source.repository.length === 0 || source.ref.length === 0) {
    return yield* new InvalidSourceError({
      source: source.id,
      reason: "repository and ref must not be empty",
    });
  }
  if (
    useLock && validateLockConfig &&
    (!lockedSource ||
      lockedSource.repository !== source.repository ||
      lockedSource.ref !== source.ref ||
      lockedSource.skillsPath !== source.skillsPath ||
      [...lockedSource.include].sort().join("\0") !== [...source.include].sort().join("\0") ||
      [...(lockedSource.exclude ?? [])].sort().join("\0") !==
        [...(source.exclude ?? [])].sort().join("\0") ||
      lockedSource.licensePath !== source.licensePath ||
      [...(lockedSource.stripFrontmatter ?? [])].sort().join("\0") !==
        [...(source.stripFrontmatter ?? [])].sort().join("\0"))
  ) {
    return yield* new InvalidSourceError({
      source: source.id,
      reason: "no matching lockfile entry; run catalog refresh without --locked first",
    });
  }

  const checkoutDir = path.join(tempDir, "checkouts", source.id);
  yield* fs.makeDirectory(checkoutDir, { recursive: true });
  yield* runCommand(checkoutDir, "git", ["init", "--quiet"]);
  yield* runCommand(checkoutDir, "git", ["remote", "add", "origin", source.repository]);
  const fetchRef = useLock ? lockedSource?.resolved : source.ref;
  if (fetchRef === undefined) {
    return yield* new InvalidSourceError({
      source: source.id,
      reason: "no matching lockfile entry; run catalog refresh without --locked first",
    });
  }
  yield* runCommand(checkoutDir, "git", [
    "fetch",
    "--quiet",
    "--depth",
    "1",
    "origin",
    fetchRef,
  ]);
  yield* runCommand(checkoutDir, "git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  const resolved = yield* runCommand(checkoutDir, "git", ["rev-parse", "HEAD"]);

  const unresolvedSkillsDir = yield* resolveInside(
    path,
    checkoutDir,
    source.skillsPath,
    source.id,
    "skillsPath",
    true,
  );
  yield* rejectGitSymlinks(checkoutDir, source.skillsPath, source.id);
  const skillsDir = yield* ensureCanonicalPathInside(
    checkoutDir,
    unresolvedSkillsDir,
    source.id,
    "skillsPath",
  );
  const skills = yield* discoverSkills(skillsDir, source);
  let licenseSource: string | undefined;
  if (source.licensePath) {
    licenseSource = yield* resolveInside(
      path,
      checkoutDir,
      source.licensePath,
      source.id,
      "licensePath",
    );
    yield* rejectGitSymlinks(checkoutDir, source.licensePath, source.id);
    if (!(yield* fs.exists(licenseSource))) {
      return yield* new InvalidSourceError({
        source: source.id,
        reason: `licensePath does not exist: ${source.licensePath}`,
      });
    }
    licenseSource = yield* ensureCanonicalPathInside(
      checkoutDir,
      licenseSource,
      source.id,
      "licensePath",
    );
    const licenseInfo = yield* fs.stat(licenseSource);
    if (licenseInfo.type !== "File") {
      return yield* new InvalidSourceError({
        source: source.id,
        reason: `licensePath must be a file: ${source.licensePath}`,
      });
    }
  }

  return {
    checkoutDir,
    resolved,
    skills,
    source,
    ...(licenseSource ? { licenseSource } : {}),
  } satisfies PreparedSource;
});

const readCurrentLock = Effect.fn("readCurrentSkillSourcesLock")(function* (lockfilePath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(lockfilePath))) {
    return undefined;
  }
  return yield* readJsonc(lockfilePath, SkillSourcesLockSchema);
});

const validateCurrentLock = Effect.fn("validateCurrentSkillSourcesLock")(function* (
  lock: SkillSourcesLock | undefined,
) {
  if (!lock) {
    return;
  }
  const sourceIds = new Set<string>();
  const skills = new Set<string>();
  for (const source of lock.sources) {
    if (!SOURCE_ID_PATTERN.test(source.id) || RESERVED_SOURCE_IDS.has(source.id)) {
      return yield* new InvalidSourceError({
        source: source.id,
        reason: "lockfile contains an invalid source id",
      });
    }
    if (sourceIds.has(source.id)) {
      return yield* new InvalidSourceError({
        source: source.id,
        reason: "lockfile source ids must be unique",
      });
    }
    sourceIds.add(source.id);
    if (!/^[0-9a-f]{40,64}$/.test(source.resolved)) {
      return yield* new InvalidSourceError({
        source: source.id,
        reason: "lockfile resolved commit must be a full hexadecimal object id",
      });
    }
    for (const skill of source.skills) {
      if (!SKILL_NAME_PATTERN.test(skill)) {
        return yield* new InvalidSourceError({
          source: source.id,
          reason: `lockfile contains an invalid skill name: ${skill}`,
        });
      }
      if (skills.has(skill)) {
        return yield* new SkillCollisionError({
          skill,
          owners: ["multiple lockfile sources"],
        });
      }
      skills.add(skill);
    }
  }
  for (const source of lock.packages ?? []) {
    if (!SOURCE_ID_PATTERN.test(source.id) || RESERVED_SOURCE_IDS.has(source.id)) {
      return yield* new InvalidSourceError({
        source: source.id,
        reason: "lockfile contains an invalid package source id",
      });
    }
    if (sourceIds.has(source.id)) {
      return yield* new InvalidSourceError({
        source: source.id,
        reason: "lockfile source ids must be unique",
      });
    }
    sourceIds.add(source.id);
    if (!isTypeScriptPackageName(source.package)) {
      return yield* new InvalidSourceError({
        source: source.id,
        reason: "lockfile contains an invalid package name",
      });
    }
    for (const skill of source.skills) {
      if (!SKILL_NAME_PATTERN.test(skill)) {
        return yield* new InvalidSourceError({
          source: source.id,
          reason: `lockfile contains an invalid skill name: ${skill}`,
        });
      }
      if (skills.has(skill)) {
        return yield* new SkillCollisionError({ skill, owners: ["multiple lockfile sources"] });
      }
      skills.add(skill);
    }
  }
  for (const sourceId of sourceIds) {
    if (skills.has(sourceId)) {
      return yield* new InvalidSourceError({
        source: sourceId,
        reason: "lockfile source id conflicts with a skill name",
      });
    }
  }
});

const currentLocalSkills = Effect.fn("currentLocalSkills")(function* (
  skillsDir: string,
  currentLock: SkillSourcesLock | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(skillsDir))) {
    return [];
  }
  const managed = new Set(currentLock?.sources.flatMap((source) => source.skills) ?? []);
  const entries = yield* fs.readDirectory(skillsDir);
  return entries.filter((entry) => !managed.has(entry));
});

const validateOwnership = Effect.fn("validateSkillOwnership")(function* (
  prepared: ReadonlyArray<PreparedSource>,
  packages: ReadonlyArray<PackageSkillSource>,
  localSkills: ReadonlyArray<string>,
) {
  const owners = new Map<string, Array<string>>();
  for (const skill of localSkills) {
    owners.set(skill, ["local"]);
  }
  for (const preparedSource of prepared) {
    for (const skill of preparedSource.skills) {
      const existing = owners.get(skill) ?? [];
      existing.push(preparedSource.source.id);
      owners.set(skill, existing);
    }
  }
  for (const source of packages) {
    for (const skill of source.include) {
      const existing = owners.get(skill) ?? [];
      existing.push(source.id);
      owners.set(skill, existing);
    }
  }
  for (const [skill, skillOwners] of owners) {
    if (skillOwners.length > 1) {
      return yield* new SkillCollisionError({ skill, owners: skillOwners });
    }
  }
  for (const sourceId of [
    ...prepared.map((source) => source.source.id),
    ...packages.map((source) => source.id),
  ]) {
    if (owners.has(sourceId)) {
      return yield* new InvalidSourceError({
        source: sourceId,
        reason: "id conflicts with a skill name",
      });
    }
  }
  for (const reservedFamily of RESERVED_SOURCE_IDS) {
    if (owners.has(reservedFamily)) {
      return yield* new InvalidSourceError({
        source: reservedFamily,
        reason: "skill name conflicts with a built-in skill family",
      });
    }
  }
});

const stripFrontmatterKeys = (
  skillDocument: string,
  keys: ReadonlyArray<string>,
): string => {
  if (keys.length === 0) {
    return skillDocument;
  }
  const frontmatter = skillDocument.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!frontmatter) {
    return skillDocument;
  }

  const stripped = new Set(keys);
  const keptLines: Array<string> = [];
  let skipping = false;
  const frontmatterBody = frontmatter[1];
  if (frontmatterBody === undefined) return skillDocument;
  for (const line of frontmatterBody.split(/\r?\n/)) {
    const key = line.match(/^([A-Za-z0-9_-]+):/)?.[1];
    if (key) {
      skipping = stripped.has(key);
    }
    if (!skipping) {
      keptLines.push(line);
    }
  }

  return `---\n${keptLines.join("\n")}\n---${frontmatter[2]}${skillDocument.slice(frontmatter[0].length)}`;
};

const stageSources = Effect.fn("stageSkillSources")(function* (
  tempDir: string,
  prepared: ReadonlyArray<PreparedSource>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stagedSkillsDir = path.join(tempDir, "staged", "skills");
  yield* fs.makeDirectory(stagedSkillsDir, { recursive: true });

  for (const preparedSource of prepared) {
    const sourceSkillsDir = path.resolve(
      preparedSource.checkoutDir,
      preparedSource.source.skillsPath,
    );
    for (const skill of preparedSource.skills) {
      const stagedSkillDir = path.join(stagedSkillsDir, skill);
      yield* fs.copy(path.join(sourceSkillsDir, skill), stagedSkillDir, { overwrite: true });
      if (preparedSource.source.stripFrontmatter?.length) {
        const skillDocumentPath = path.join(stagedSkillDir, "SKILL.md");
        const skillDocument = yield* fs.readFileString(skillDocumentPath);
        yield* fs.writeFileString(
          skillDocumentPath,
          stripFrontmatterKeys(skillDocument, preparedSource.source.stripFrontmatter),
        );
      }
    }
  }

  return { stagedSkillsDir };
});

const buildLock = Effect.fn("buildSkillCatalogLock")(function* (
  prepared: ReadonlyArray<PreparedSource>,
  stagedSkillsDir: string,
  packages: ReadonlyArray<PackageSkillSource>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sources: Array<LockedSkillSource> = [];
  for (const { resolved, skills, source } of prepared) {
    const descriptions: Record<string, string> = {};
    const digests: Record<string, Digest> = {};
    for (const skill of skills) {
      const stagedSkill = path.join(stagedSkillsDir, skill);
      const document = yield* fs.readFileString(path.join(stagedSkill, "SKILL.md"));
      descriptions[skill] = document
        .match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
        ?.split(/\r?\n/)
        .find((line) => line.startsWith("description:"))
        ?.slice("description:".length)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2") ?? "";
      const observation = yield* observePath(stagedSkill);
      if (observation.kind !== "directory") {
        return yield* new InvalidSourceError({ source: source.id, reason: `could not digest ${skill}` });
      }
      digests[skill] = observation.digest;
    }
    sources.push({
      id: source.id,
      repository: source.repository,
      ref: source.ref,
      resolved,
      skillsPath: source.skillsPath,
      include: source.include,
      ...(source.exclude ? { exclude: source.exclude } : {}),
      skills,
      descriptions,
      digests,
      ...(source.licensePath ? { licensePath: source.licensePath } : {}),
      ...(source.stripFrontmatter ? { stripFrontmatter: source.stripFrontmatter } : {}),
    });
  }
  const lockedPackages: Array<LockedPackageSkillSource> = packages.map((source) => ({
    id: source.id,
    package: source.package,
    skillsPath: source.skillsPath,
    skills: [...source.include].sort(),
    ...(source.descriptions ? { descriptions: source.descriptions } : {}),
  }));
  return {
    version: 1,
    sources,
    ...(lockedPackages.length > 0 ? { packages: lockedPackages } : {}),
  } satisfies SkillSourcesLock;
});

const validatePackageSources = Effect.fn("validatePackageSkillSources")(function* (
  packages: ReadonlyArray<PackageSkillSource>,
  sourceIds: Set<string>,
) {
  for (const source of packages) {
    if (!SOURCE_ID_PATTERN.test(source.id) || RESERVED_SOURCE_IDS.has(source.id)) {
      return yield* new InvalidSourceError({
        source: source.id,
        reason: "id must use lowercase letters, numbers, and hyphens and not conflict with a built-in skill family",
      });
    }
    if (sourceIds.has(source.id)) {
      return yield* new InvalidSourceError({ source: source.id, reason: "source ids must be unique" });
    }
    sourceIds.add(source.id);
    if (!isTypeScriptPackageName(source.package)) {
      return yield* new InvalidSourceError({ source: source.id, reason: `invalid package name: ${source.package}` });
    }
    if (!isPortablePackageSkillPath(source.skillsPath)) {
      return yield* new InvalidSourceError({
        source: source.id,
        reason: "skillsPath must be a portable package-relative path",
      });
    }
    if (source.include.length === 0) {
      return yield* new InvalidSourceError({ source: source.id, reason: "include must select at least one skill" });
    }
    const selected = new Set<string>();
    for (const skill of source.include) {
      if (!SKILL_NAME_PATTERN.test(skill)) {
        return yield* new InvalidSourceError({
          source: source.id,
          reason: `package include must contain explicit valid skill names: ${skill}`,
        });
      }
      if (selected.has(skill)) {
        return yield* new InvalidSourceError({ source: source.id, reason: `include contains duplicate skill: ${skill}` });
      }
      selected.add(skill);
    }
    for (const skill of Object.keys(source.descriptions ?? {})) {
      if (!selected.has(skill)) {
        return yield* new InvalidSourceError({ source: source.id, reason: `description is not for an approved skill: ${skill}` });
      }
    }
  }
});

export const inspectCatalogRepository = Effect.fn("inspectCatalogRepository")(function* (
  options: CatalogInspectOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoDir = path.resolve(options.repoDir ?? ".");
  const locator = yield* normalizeRepositoryLocator(options.repository);
  const repository = locator.repository;
  const id = options.id ?? inferSourceId(repository);
  if (id.length === 0) {
    return yield* new InvalidSourceError({
      source: repository,
      reason: "could not infer a source id; pass --id",
    });
  }
  const source: ExternalSkillSource = {
    id,
    repository,
    ref: options.ref ?? locator.ref ?? "HEAD",
    skillsPath: options.skillsPath ?? locator.skillsPath ?? "skills",
    include: ["*"],
  };
  const tempDir = yield* fs.makeTempDirectoryScoped({
    directory: repoDir,
    prefix: ".dev-kit-inspect-",
  });
  const prepared = yield* withSpinner(
    "Inspecting skill repository",
    prepareSource(tempDir, source, undefined, false),
  );
  let ref = source.ref;
  if (ref === "HEAD") {
    const symbolicHead = yield* runCommand(prepared.checkoutDir, "git", [
      "ls-remote",
      "--symref",
      "origin",
      "HEAD",
    ]);
    ref = symbolicHead.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m)?.[1] ?? ref;
  }
  const skills: Array<{ readonly name: string; readonly description: string }> = [];
  for (const name of prepared.skills) {
    const document = yield* fs.readFileString(
      path.join(prepared.checkoutDir, source.skillsPath, name, "SKILL.md"),
    );
    const description = document
      .match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
      ?.split(/\r?\n/)
      .find((line) => line.startsWith("description:"))
      ?.slice("description:".length)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2") ?? "";
    skills.push({ name, description });
  }
  let licensePath: string | undefined;
  for (const candidate of ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]) {
    const candidatePath = path.join(prepared.checkoutDir, candidate);
    if (yield* fs.exists(candidatePath)) {
      const info = yield* fs.stat(candidatePath);
      if (info.type === "File") {
        licensePath = candidate;
        break;
      }
    }
  }
  return {
    id,
    repository,
    ref,
    resolved: prepared.resolved,
    skillsPath: source.skillsPath,
    skills,
    ...(licensePath ? { licensePath } : {}),
  } satisfies CatalogInspection;
});

export const refreshSkillCatalog = Effect.fn("refreshSkillCatalog")(function* (
  options: CatalogRefreshOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const initialDir = path.resolve(options.repoDir ?? ".");
  const repoDir = yield* resolveGitRoot(initialDir).pipe(
    Effect.catchTag("CommandError", (error) =>
      error.output.includes("not a git repository")
        ? Effect.succeed(initialDir)
        : Effect.fail(error),
    ),
  );
  yield* acquireProjectProcessLock(repoDir);
  const sourcesPath = path.resolve(repoDir, options.sourcesPath ?? DEFAULT_SOURCES_PATH);
  const lockfilePath = path.resolve(repoDir, options.lockfilePath ?? DEFAULT_LOCKFILE_PATH);
  const manifest = yield* readJsonc(sourcesPath, SkillSourcesManifestSchema);
  const currentLock = yield* readCurrentLock(lockfilePath);
  yield* validateCurrentLock(currentLock);
  const lockedById = new Map(
    currentLock?.sources.map((source) => [source.id, source] as const) ?? [],
  );

  const packages = manifest.packages ?? [];
  const sourceIds = new Set<string>();
  for (const source of manifest.sources) {
    if (sourceIds.has(source.id)) {
      return yield* new InvalidSourceError({
        source: source.id,
        reason: "source ids must be unique",
      });
    }
    sourceIds.add(source.id);
  }
  yield* validatePackageSources(packages, sourceIds);
  if (options.locked) {
    if (!currentLock) {
      return yield* new SourceManifestError({
        path: lockfilePath,
        message: "lockfile is required with --locked",
      });
    }
    const lockedIds = new Set([
      ...currentLock.sources.map((source) => source.id),
      ...(currentLock.packages ?? []).map((source) => source.id),
    ]);
    const missingFromManifest = [...currentLock.sources, ...(currentLock.packages ?? [])]
      .find((source) => !sourceIds.has(source.id));
    const missingFromLock = [...manifest.sources, ...packages].find((source) => !lockedIds.has(source.id));
    if (missingFromManifest || missingFromLock) {
      return yield* new SourceManifestError({
        path: lockfilePath,
        message: "source ids differ from skill-sources.jsonc; run catalog refresh without --locked",
      });
    }
  }

  const tempDir = yield* fs.makeTempDirectoryScoped({
    directory: repoDir,
    prefix: ".dev-kit-vendor-",
  });
  const prepared = yield* withSpinner(
    "Fetching skill sources",
    Effect.forEach(
      manifest.sources,
      (source) => {
        const pinned = options.pinSourceIds?.includes(source.id) ?? false;
        const useLock = (options.locked ?? false) || pinned ||
          (options.updateSourceIds !== undefined && !options.updateSourceIds.includes(source.id));
        return prepareSource(
          tempDir,
          source,
          lockedById.get(source.id),
          useLock,
          (options.locked ?? false) || !pinned,
        );
      },
      { concurrency: 4 },
    ),
  );
  const localSkills = yield* currentLocalSkills(path.join(repoDir, "skills"), currentLock);
  yield* validateOwnership(prepared, packages, localSkills);
  const staged = yield* stageSources(tempDir, prepared);
  const nextLock = yield* buildLock(prepared, staged.stagedSkillsDir, packages);

  const skillCount = new Set([
    ...nextLock.sources.flatMap((source) => source.skills),
    ...(nextLock.packages ?? []).flatMap((source) => source.skills),
  ]).size;
  const sourceCount = nextLock.sources.length + (nextLock.packages?.length ?? 0);
  const summary = `${skillCount} skill${skillCount === 1 ? "" : "s"} from ${sourceCount} source${sourceCount === 1 ? "" : "s"}`;

  if (options.locked) {
    if (JSON.stringify(currentLock) !== JSON.stringify(nextLock)) {
      return yield* new SourceManifestError({
        path: lockfilePath,
        message: "approved catalog metadata differs from the lock; run catalog refresh and review it",
      });
    }
    yield* printStatus("success", "Catalog verified", summary);
    return;
  }

  if (options.dryRun) {
    yield* printStatus("plan", "Would refresh catalog", summary);
    return;
  }

  const nextLockPath = path.join(tempDir, "next-catalog-lock.json");
  yield* fs.writeFileString(nextLockPath, `${JSON.stringify(nextLock, null, 2)}\n`);
  yield* fs.rename(nextLockPath, lockfilePath);
  yield* printStatus("success", "Catalog refreshed", summary);
});

/** @deprecated Use refreshSkillCatalog. */
export const vendorExternalSkills = refreshSkillCatalog;
