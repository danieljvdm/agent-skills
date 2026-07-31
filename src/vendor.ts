import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { Cause, Console, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

import {
  SkillSourcesLockSchema,
  SkillSourcesManifestSchema,
  type ExternalSkillSource,
  type LockedSkillSource,
  type SkillSourcesLock,
} from "./source-manifest.ts";

export type VendorOptions = {
  readonly repoDir?: string;
  readonly sourcesPath?: string;
  readonly lockfilePath?: string;
  readonly dryRun?: boolean;
  readonly locked?: boolean;
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
      reason: `symlinks are not allowed in vendored paths: ${symlink.slice(symlink.indexOf("\t") + 1)}`,
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

  const selected = includeAll ? discovered : [...source.include];
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
    useLock &&
    (!lockedSource ||
      lockedSource.repository !== source.repository ||
      lockedSource.ref !== source.ref ||
      lockedSource.skillsPath !== source.skillsPath ||
      [...lockedSource.include].sort().join("\0") !== [...source.include].sort().join("\0") ||
      lockedSource.licensePath !== source.licensePath ||
      [...(lockedSource.stripFrontmatter ?? [])].sort().join("\0") !==
        [...(source.stripFrontmatter ?? [])].sort().join("\0"))
  ) {
    return yield* new InvalidSourceError({
      source: source.id,
      reason: "no matching lockfile entry; run vendor without --locked first",
    });
  }

  const checkoutDir = path.join(tempDir, "checkouts", source.id);
  yield* fs.makeDirectory(checkoutDir, { recursive: true });
  yield* runCommand(checkoutDir, "git", ["init", "--quiet"]);
  yield* runCommand(checkoutDir, "git", ["remote", "add", "origin", source.repository]);
  yield* runCommand(checkoutDir, "git", [
    "fetch",
    "--quiet",
    "--depth",
    "1",
    "origin",
    useLock ? lockedSource!.resolved : source.ref,
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
  for (const [skill, skillOwners] of owners) {
    if (skillOwners.length > 1) {
      return yield* new SkillCollisionError({ skill, owners: skillOwners });
    }
  }
  for (const preparedSource of prepared) {
    if (owners.has(preparedSource.source.id)) {
      return yield* new InvalidSourceError({
        source: preparedSource.source.id,
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
  const stagedLicensesDir = path.join(tempDir, "staged", "third-party");
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
    if (preparedSource.licenseSource) {
      const licenseDir = path.join(stagedLicensesDir, preparedSource.source.id);
      yield* fs.makeDirectory(licenseDir, { recursive: true });
      yield* fs.copyFile(
        preparedSource.licenseSource,
        path.join(licenseDir, path.basename(preparedSource.licenseSource)),
      );
    }
  }

  return { stagedLicensesDir, stagedSkillsDir };
});

const buildLock = (prepared: ReadonlyArray<PreparedSource>): SkillSourcesLock => ({
  version: 1,
  sources: prepared.map(({ resolved, skills, source }) => ({
    id: source.id,
    repository: source.repository,
    ref: source.ref,
    resolved,
    skillsPath: source.skillsPath,
    include: source.include,
    skills,
    ...(source.licensePath ? { licensePath: source.licensePath } : {}),
    ...(source.stripFrontmatter ? { stripFrontmatter: source.stripFrontmatter } : {}),
  })),
});

const applyPreparedSources = Effect.fn("applyPreparedSkillSources")(function* (
  repoDir: string,
  tempDir: string,
  lockfilePath: string,
  currentLock: SkillSourcesLock | undefined,
  nextLock: SkillSourcesLock,
  staged: { readonly stagedSkillsDir: string; readonly stagedLicensesDir: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillsDir = path.join(repoDir, "skills");
  const licensesDir = path.join(repoDir, "third-party");
  const backupDir = path.join(tempDir, "backup");
  const nextLockPath = path.join(tempDir, "next-lock.json");
  yield* fs.makeDirectory(skillsDir, { recursive: true });
  yield* fs.writeFileString(nextLockPath, `${JSON.stringify(nextLock, null, 2)}\n`);

  type Replacement = {
    readonly destination: string;
    readonly backup: string;
    staged?: string;
  };
  const replacements = new Map<string, Replacement>();
  const addReplacement = (
    destinationRoot: string,
    backupRoot: string,
    name: string,
    stagedPath?: string,
  ) => {
    const destination = path.resolve(destinationRoot, name);
    const relative = path.relative(destinationRoot, destination);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative.length === 0) {
      return Effect.fail(
        new InvalidSourceError({
          source: "lockfile",
          reason: `managed path escapes its destination: ${name}`,
        }),
      );
    }
    const existing = replacements.get(destination);
    replacements.set(destination, {
      backup: path.resolve(backupRoot, name),
      destination,
      ...(stagedPath ? { staged: stagedPath } : existing?.staged ? { staged: existing.staged } : {}),
    });
    return Effect.void;
  };

  for (const source of currentLock?.sources ?? []) {
    for (const skill of source.skills) {
      yield* addReplacement(skillsDir, path.join(backupDir, "skills"), skill);
    }
    yield* addReplacement(licensesDir, path.join(backupDir, "third-party"), source.id);
  }
  for (const source of nextLock.sources) {
    for (const skill of source.skills) {
      yield* addReplacement(
        skillsDir,
        path.join(backupDir, "skills"),
        skill,
        path.join(staged.stagedSkillsDir, skill),
      );
    }
    const stagedLicenseDir = path.join(staged.stagedLicensesDir, source.id);
    if (yield* fs.exists(stagedLicenseDir)) {
      yield* addReplacement(
        licensesDir,
        path.join(backupDir, "third-party"),
        source.id,
        stagedLicenseDir,
      );
    }
  }

  const installed: Array<string> = [];
  const backedUp: Array<Replacement> = [];
  const rollback = Effect.gen(function* () {
    for (const destination of [...installed].reverse()) {
      yield* fs.remove(destination, { force: true, recursive: true });
    }
    for (const replacement of [...backedUp].reverse()) {
      yield* fs.makeDirectory(path.dirname(replacement.destination), { recursive: true });
      yield* fs.rename(replacement.backup, replacement.destination);
    }
  });

  const apply = Effect.gen(function* () {
    for (const replacement of replacements.values()) {
      if (yield* fs.exists(replacement.destination)) {
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
    yield* fs.rename(nextLockPath, lockfilePath);
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

export const vendorExternalSkills = Effect.fn("vendorExternalSkills")(function* (
  options: VendorOptions,
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
  const sourcesPath = path.resolve(repoDir, options.sourcesPath ?? DEFAULT_SOURCES_PATH);
  const lockfilePath = path.resolve(repoDir, options.lockfilePath ?? DEFAULT_LOCKFILE_PATH);
  const manifest = yield* readJsonc(sourcesPath, SkillSourcesManifestSchema);
  const currentLock = yield* readCurrentLock(lockfilePath);
  yield* validateCurrentLock(currentLock);
  const lockedById = new Map(
    currentLock?.sources.map((source) => [source.id, source] as const) ?? [],
  );

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
  if (options.locked) {
    if (!currentLock) {
      return yield* new SourceManifestError({
        path: lockfilePath,
        message: "lockfile is required with --locked",
      });
    }
    const lockedIds = new Set(currentLock.sources.map((source) => source.id));
    const missingFromManifest = currentLock.sources.find((source) => !sourceIds.has(source.id));
    const missingFromLock = manifest.sources.find((source) => !lockedIds.has(source.id));
    if (missingFromManifest || missingFromLock) {
      return yield* new SourceManifestError({
        path: lockfilePath,
        message: "source ids differ from skill-sources.jsonc; run vendor without --locked",
      });
    }
  }

  const tempDir = yield* fs.makeTempDirectoryScoped({
    directory: repoDir,
    prefix: ".agent-skills-vendor-",
  });
  const prepared = yield* Effect.forEach(
    manifest.sources,
    (source) =>
      prepareSource(tempDir, source, lockedById.get(source.id), options.locked ?? false),
    { concurrency: 4 },
  );
  const localSkills = yield* currentLocalSkills(path.join(repoDir, "skills"), currentLock);
  yield* validateOwnership(prepared, localSkills);
  const staged = yield* stageSources(tempDir, prepared);
  const nextLock = buildLock(prepared);

  for (const source of nextLock.sources) {
    yield* Console.log(`${source.id} ${source.resolved.slice(0, 12)}`);
    for (const skill of source.skills) {
      yield* Console.log(`  vendor ${skill}`);
    }
  }

  if (options.dryRun) {
    yield* Console.log("Dry run: no files changed.");
    return;
  }

  yield* applyPreparedSources(repoDir, tempDir, lockfilePath, currentLock, nextLock, staged);
  yield* Console.log(`Updated ${path.relative(repoDir, lockfilePath)}`);
});
