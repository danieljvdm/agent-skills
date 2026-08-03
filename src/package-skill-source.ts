import { Effect, FileSystem, Path, Result, Schema } from "effect";

import { observeSymbolicLink } from "./node-symbolic-link.ts";
import { isSkillName, parseSkillSelector } from "./skill-selector.ts";
import { isTypeScriptPackageName } from "./typescript-package-name.ts";

export class PackageSkillSourceError extends Schema.TaggedErrorClass<PackageSkillSourceError>()(
  "PackageSkillSourceError",
  { message: Schema.String },
) {}

export type PackageSkillDiagnostic = {
  readonly package: string;
  readonly message: string;
};

export type DiscoveredPackageSkill = {
  readonly selector: string;
  readonly name: string;
  readonly description: string;
  readonly package: string;
  readonly version: string;
  readonly path: string;
  readonly linkPath: string;
};

const ProjectPackageSchema = Schema.fromJsonString(Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}));

const PackageMetadataSchema = Schema.fromJsonString(Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  intent: Schema.optional(Schema.Unknown),
  repository: Schema.optional(Schema.Unknown),
}));

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const hasIntentDiscoveryMetadata = (metadata: typeof PackageMetadataSchema.Type): boolean => {
  const intent = metadata.intent;
  if (typeof intent === "object" && intent !== null &&
    "version" in intent && intent.version === 1 &&
    "repo" in intent && nonEmptyString(intent.repo) &&
    "docs" in intent && nonEmptyString(intent.docs)) {
    return true;
  }
  const repository = metadata.repository;
  return nonEmptyString(repository) ||
    (typeof repository === "object" && repository !== null &&
      "url" in repository && nonEmptyString(repository.url));
};

const isSafePackageVersion = (value: string): boolean =>
  value.length > 0 && value.trim() === value && ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || (code >= 127 && code <= 159);
  });

const isContained = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const frontmatterScalar = (document: string, key: string): string | undefined => {
  const body = document.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (body === undefined) return undefined;
  const lines = body.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index < 0) return undefined;
  const raw = lines[index]?.slice(key.length + 1).trim() ?? "";
  const block = raw.match(/^([|>])(?:[1-9][+-]?|[+-][1-9]?)?$/)?.[1];
  if (block !== undefined) {
    const values: Array<string> = [];
    for (const line of lines.slice(index + 1)) {
      if (line.length > 0 && !/^\s/.test(line)) break;
      values.push(line.trim());
    }
    const value = block === "|" ? values.join("\n").trim() : values.join(" ").trim();
    return value.length > 0 ? value : undefined;
  }
  const quoted = raw.match(/^(['"])([\s\S]*?)\1(?:\s+#.*)?$/)?.[2];
  const value = (quoted ?? raw.replace(/\s+#.*$/, "")).trim();
  return value.length > 0 ? value : undefined;
};

const skillName = (document: string): string | undefined =>
  frontmatterScalar(document, "name");

const skillDescription = (document: string): string | undefined =>
  frontmatterScalar(document, "description");

const rejectNestedSymlinks = Effect.fn("rejectPackageSkillSymlinks")(function* (skillRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pending = [skillRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    if ((yield* observeSymbolicLink(current)).kind === "symlink") {
      return yield* new PackageSkillSourceError({ message: `package skill contains a symlink: ${current}` });
    }
    const info = yield* fs.stat(current).pipe(
      Effect.mapError(() => new PackageSkillSourceError({ message: `could not inspect package skill: ${current}` })),
    );
    if (info.type !== "Directory") continue;
    for (const entry of yield* fs.readDirectory(current).pipe(
      Effect.mapError(() => new PackageSkillSourceError({ message: `could not read package skill: ${current}` })),
    )) pending.push(path.join(current, entry));
  }
});

const readDirectDependencyNames = Effect.fn("readDirectPackageSkillDependencyNames")(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(projectDir, "package.json");
  const manifest = yield* fs.readFileString(manifestPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ProjectPackageSchema)),
    Effect.mapError(() => new PackageSkillSourceError({ message: `invalid project package.json: ${manifestPath}` })),
  );
  return [...new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])].sort();
});

const readImmediateSkillNames = Effect.fn("readInstalledPackageSkillNames")(function* (
  projectDir: string,
  packageName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageLink = path.join(projectDir, "node_modules", ...packageName.split("/"));
  const skillsLink = path.join(packageLink, "skills");
  if (!(yield* fs.exists(skillsLink))) return [];
  if ((yield* observeSymbolicLink(skillsLink)).kind === "symlink") {
    return yield* new PackageSkillSourceError({
      message: `package skills path is a symlink: ${packageName}/skills`,
    });
  }
  const packageRoot = yield* fs.realPath(packageLink).pipe(
    Effect.mapError(() => new PackageSkillSourceError({
      message: `package skill package is not installed: ${packageName}`,
    })),
  );
  const metadata = yield* fs.readFileString(path.join(packageRoot, "package.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PackageMetadataSchema)),
    Effect.mapError(() => new PackageSkillSourceError({
      message: `invalid package.json for package skill package: ${packageName}`,
    })),
  );
  if (metadata.name !== packageName || !isSafePackageVersion(metadata.version) ||
    !hasIntentDiscoveryMetadata(metadata)) {
    return yield* new PackageSkillSourceError({
      message: `package does not expose valid Intent discovery metadata: ${packageName}`,
    });
  }
  const skillsRoot = yield* fs.realPath(skillsLink).pipe(
    Effect.mapError(() => new PackageSkillSourceError({
      message: `package skill package has no readable skills directory: ${packageName}`,
    })),
  );
  if (!isContained(path, packageRoot, skillsRoot) || (yield* fs.stat(skillsRoot)).type !== "Directory") {
    return yield* new PackageSkillSourceError({
      message: `package skills path is not a contained directory: ${packageName}/skills`,
    });
  }
  const entries = yield* fs.readDirectory(skillsRoot).pipe(
    Effect.mapError(() => new PackageSkillSourceError({
      message: `package skill package has no readable skills directory: ${packageName}`,
    })),
  );
  return entries.filter(isSkillName).sort();
});

const parseSelector = (selector: string): { readonly package: string; readonly name: string } | undefined => {
  const parsed = parseSkillSelector(selector);
  return parsed?.type === "package"
    ? { package: parsed.package, name: parsed.skill }
    : undefined;
};

export const isPackageSkillSelector = (value: string): boolean => parseSelector(value) !== undefined;

const inspectPackageSkill = Effect.fn("inspectInstalledPackageSkill")(function* (
  projectDir: string,
  packageName: string,
  requestedName?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageLink = path.join(projectDir, "node_modules", ...packageName.split("/"));
  const packageRoot = yield* fs.realPath(packageLink).pipe(
    Effect.mapError(() => new PackageSkillSourceError({ message: `package skill package is not installed: ${packageName}` })),
  );
  const packageInfo = yield* fs.stat(packageRoot).pipe(
    Effect.mapError(() => new PackageSkillSourceError({ message: `could not inspect package skill package: ${packageName}` })),
  );
  if (packageInfo.type !== "Directory") return yield* new PackageSkillSourceError({ message: `package skill package is not a directory: ${packageName}` });
  const metadata = yield* fs.readFileString(path.join(packageRoot, "package.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PackageMetadataSchema)),
    Effect.mapError(() => new PackageSkillSourceError({ message: `invalid package.json for package skill package: ${packageName}` })),
  );
  if (metadata.name !== packageName) return yield* new PackageSkillSourceError({ message: `package.json name does not match package skill package: ${packageName}` });
  if (!isSafePackageVersion(metadata.version)) return yield* new PackageSkillSourceError({ message: `package.json has an invalid version for package skill package: ${packageName}` });
  if (!hasIntentDiscoveryMetadata(metadata)) return yield* new PackageSkillSourceError({ message: `package does not declare Intent-compatible discovery metadata: ${packageName}` });
  const skillsPath = "skills";
  const skillsLink = path.join(packageLink, skillsPath);
  if ((yield* observeSymbolicLink(skillsLink)).kind === "symlink") return yield* new PackageSkillSourceError({ message: `package skills path is a symlink: ${packageName}/${skillsPath}` });
  const skillsRoot = yield* fs.realPath(skillsLink).pipe(
    Effect.mapError(() => new PackageSkillSourceError({ message: `package skill package has no skills directory: ${packageName}` })),
  );
  if (!isContained(path, packageRoot, skillsRoot)) return yield* new PackageSkillSourceError({ message: `package skills path resolves outside package root: ${packageName}/${skillsPath}` });
  const skillsInfo = yield* fs.stat(skillsRoot);
  if (skillsInfo.type !== "Directory") return yield* new PackageSkillSourceError({ message: `package skills path is not a directory: ${packageName}/${skillsPath}` });
  const entries = requestedName === undefined ? (yield* fs.readDirectory(skillsRoot)).sort() : [requestedName];
  const skills: Array<DiscoveredPackageSkill> = [];
  for (const name of entries) {
    if (!isSkillName(name)) {
      if (requestedName !== undefined) return yield* new PackageSkillSourceError({ message: `invalid package skill name: ${name}` });
      continue;
    }
    const linkPath = path.join(packageLink, skillsPath, name);
    if ((yield* observeSymbolicLink(linkPath)).kind === "symlink") {
      if (requestedName !== undefined) return yield* new PackageSkillSourceError({ message: `package skill contains a symlink: ${packageName}#${name}` });
      continue;
    }
    const skillRoot = yield* fs.realPath(linkPath).pipe(
      Effect.mapError(() => new PackageSkillSourceError({ message: `package skill does not exist: ${packageName}#${name}` })),
    );
    if (!isContained(path, skillsRoot, skillRoot) || (yield* fs.stat(skillRoot)).type !== "Directory") {
      if (requestedName !== undefined) return yield* new PackageSkillSourceError({ message: `package skill is not a contained directory: ${packageName}#${name}` });
      continue;
    }
    yield* rejectNestedSymlinks(skillRoot);
    const document = yield* fs.readFileString(path.join(skillRoot, "SKILL.md")).pipe(
      Effect.mapError(() => new PackageSkillSourceError({ message: `package skill is missing SKILL.md: ${packageName}#${name}` })),
    );
    if (skillName(document) !== name) return yield* new PackageSkillSourceError({ message: `package skill SKILL.md name must match directory: ${packageName}#${name}` });
    const description = skillDescription(document);
    if (description === undefined) return yield* new PackageSkillSourceError({ message: `package skill SKILL.md must declare a description: ${packageName}#${name}` });
    skills.push({ selector: `${packageName}#${name}`, name, description, package: packageName, version: metadata.version, path: skillRoot, linkPath });
  }
  return skills;
});

/** Read direct project dependencies only; malformed packages are returned as diagnostics, never executed. */
export const discoverPackageSkills = Effect.fn("discoverInstalledPackageSkills")(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates: Array<DiscoveredPackageSkill> = [];
  const diagnostics: Array<PackageSkillDiagnostic> = [];
  if (!(yield* fs.exists(path.join(projectDir, "package.json")))) {
    return { candidates, diagnostics };
  }
  for (const packageName of yield* readDirectDependencyNames(projectDir)) {
    if (!isTypeScriptPackageName(packageName)) {
      diagnostics.push({ package: packageName, message: `invalid direct dependency package name: ${packageName}` });
      continue;
    }
    const names = yield* Effect.result(readImmediateSkillNames(projectDir, packageName));
    if (Result.isFailure(names)) {
      diagnostics.push({ package: packageName, message: names.failure.message });
      continue;
    }
    for (const name of names.success) {
      const inspected = yield* Effect.result(inspectPackageSkill(projectDir, packageName, name));
      if (Result.isSuccess(inspected)) candidates.push(...inspected.success);
      else diagnostics.push({ package: packageName, message: inspected.failure.message });
    }
  }
  return { candidates: candidates.sort((left, right) => left.selector.localeCompare(right.selector)), diagnostics };
});

/** Resolve one explicitly selected package skill. Unlike browsing, every malformed or missing part is an error. */
export const resolvePackageSkillSelector = Effect.fn("resolvePackageSkillSelector")(function* (projectDir: string, selector: string) {
  const parsed = parseSelector(selector);
  if (!parsed) return yield* new PackageSkillSourceError({ message: `invalid package skill selector: ${selector}` });
  const directDependencies = yield* readDirectDependencyNames(projectDir);
  if (!directDependencies.includes(parsed.package)) return yield* new PackageSkillSourceError({ message: `package skill package is not a direct dependency: ${parsed.package}` });
  const skills = yield* inspectPackageSkill(projectDir, parsed.package, parsed.name);
  const skill = skills[0];
  if (!skill) return yield* new PackageSkillSourceError({ message: `package skill does not exist: ${selector}` });
  return skill;
});
