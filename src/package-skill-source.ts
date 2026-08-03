import { Effect, FileSystem, Path, Schema } from "effect";

import { observeSymbolicLink } from "./node-symbolic-link.ts";
import { isPortablePackageSkillPath } from "./package-skill-path.ts";
import type { LockedPackageSkillSource } from "./source-manifest.ts";
import { isTypeScriptPackageName } from "./typescript-package-name.ts";

export class PackageSkillSourceError extends Schema.TaggedErrorClass<PackageSkillSourceError>()(
  "PackageSkillSourceError",
  { message: Schema.String },
) {}

const PackageMetadataSchema = Schema.fromJsonString(Schema.Struct({
  name: Schema.String,
  version: Schema.String,
}));

const isContained = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const resolveContainedPath = Effect.fn("resolveContainedPackageSkillPath")(function* (
  root: string,
  relative: string,
  label: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (relative.length === 0 || path.isAbsolute(relative)) {
    return yield* new PackageSkillSourceError({ message: `${label} must be a non-empty relative path` });
  }
  const candidate = path.resolve(root, relative);
  if (!isContained(path, root, candidate)) {
    return yield* new PackageSkillSourceError({ message: `${label} escapes package root` });
  }
  const canonical = yield* fs.realPath(candidate).pipe(
    Effect.mapError(() => new PackageSkillSourceError({ message: `${label} does not exist: ${relative}` })),
  );
  if (!isContained(path, root, canonical)) {
    return yield* new PackageSkillSourceError({ message: `${label} resolves outside package root: ${relative}` });
  }
  return canonical;
});

const rejectRelativePathSymlinks = Effect.fn("rejectPackageRelativePathSymlinks")(function* (
  root: string,
  relative: string,
  label: string,
) {
  const path = yield* Path.Path;
  const candidate = path.resolve(root, relative);
  if (!isContained(path, root, candidate)) return;
  let current = root;
  for (const segment of path.relative(root, candidate).split(path.sep)) {
    if (segment.length === 0) continue;
    current = path.join(current, segment);
    if ((yield* observeSymbolicLink(current)).kind === "symlink") {
      return yield* new PackageSkillSourceError({
        message: `${label} contains a symlink: ${relative}`,
      });
    }
  }
});

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
    )) {
      pending.push(path.join(current, entry));
    }
  }
});

const skillName = (document: string): string | undefined =>
  document.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
    ?.split(/\r?\n/)
    .find((line) => line.startsWith("name:"))
    ?.slice("name:".length)
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2");

/** Resolve already-installed, locked package skills without mutating the project. */
export const resolvePackageSkillSource = Effect.fn("resolvePackageSkillSource")(function* (
  projectDir: string,
  source: LockedPackageSkillSource,
  selected: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!isTypeScriptPackageName(source.package)) {
    return yield* new PackageSkillSourceError({ message: `invalid package skill source package: ${source.package}` });
  }
  if (!isPortablePackageSkillPath(source.skillsPath)) {
    return yield* new PackageSkillSourceError({
      message: `invalid package skill source skills path: ${source.skillsPath}`,
    });
  }
  const unapproved = selected.find((skill) => !source.skills.includes(skill));
  if (unapproved !== undefined) {
    return yield* new PackageSkillSourceError({
      message: `package skill is not approved by source ${source.id}: ${unapproved}`,
    });
  }
  const requested = [...new Set(selected)];
  const packageCandidate = path.join(projectDir, "node_modules", ...source.package.split("/"));
  const packageRoot = yield* fs.realPath(packageCandidate).pipe(
    Effect.mapError(() => new PackageSkillSourceError({ message: `package skill source is not installed: ${source.package}` })),
  );
  const packageInfo = yield* fs.stat(packageRoot).pipe(
    Effect.mapError(() => new PackageSkillSourceError({ message: `could not inspect package skill source: ${source.package}` })),
  );
  if (packageInfo.type !== "Directory") {
    return yield* new PackageSkillSourceError({ message: `package skill source is not a directory: ${source.package}` });
  }
  const manifestPath = path.join(packageRoot, "package.json");
  const metadata = yield* fs.readFileString(manifestPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PackageMetadataSchema)),
    Effect.mapError(() => new PackageSkillSourceError({ message: `invalid package.json for package skill source: ${source.package}` })),
  );
  if (metadata.name !== source.package) {
    return yield* new PackageSkillSourceError({ message: `package.json name does not match package skill source: ${source.package}` });
  }
  if (metadata.version.trim().length === 0 || metadata.version.trim() !== metadata.version) {
    return yield* new PackageSkillSourceError({ message: `package.json has an invalid version for package skill source: ${source.package}` });
  }
  const skillsCandidate = path.resolve(packageRoot, source.skillsPath);
  yield* rejectRelativePathSymlinks(packageRoot, source.skillsPath, "package skills path");
  if ((yield* observeSymbolicLink(skillsCandidate)).kind === "symlink") {
    return yield* new PackageSkillSourceError({ message: `package skills path is a symlink: ${source.skillsPath}` });
  }
  const skillsRoot = yield* resolveContainedPath(packageRoot, source.skillsPath, "package skills path");
  const rootInfo = yield* fs.stat(skillsRoot).pipe(
    Effect.mapError(() => new PackageSkillSourceError({ message: `package skills path is not a directory: ${source.skillsPath}` })),
  );
  if (rootInfo.type !== "Directory") {
    return yield* new PackageSkillSourceError({ message: `package skills path is not a directory: ${source.skillsPath}` });
  }
  const paths = new Map<
    string,
    { readonly path: string; readonly linkPath: string; readonly version: string }
  >();
  for (const name of requested) {
    if (name.length === 0 || name.includes("\\") || path.isAbsolute(name) || name === "." || name === ".." || name.includes("/")) {
      return yield* new PackageSkillSourceError({ message: `invalid package skill name: ${name}` });
    }
    const candidate = path.join(skillsRoot, name);
    if ((yield* observeSymbolicLink(candidate)).kind === "symlink") {
      return yield* new PackageSkillSourceError({ message: `package skill contains a symlink: ${name}` });
    }
    const skillRoot = yield* resolveContainedPath(skillsRoot, name, "package skill");
    const info = yield* fs.stat(skillRoot).pipe(
      Effect.mapError(() => new PackageSkillSourceError({ message: `package skill is not a directory: ${name}` })),
    );
    if (info.type !== "Directory") {
      return yield* new PackageSkillSourceError({ message: `package skill is not a directory: ${name}` });
    }
    yield* rejectNestedSymlinks(skillRoot);
    const document = yield* fs.readFileString(path.join(skillRoot, "SKILL.md")).pipe(
      Effect.mapError(() => new PackageSkillSourceError({ message: `package skill is missing SKILL.md: ${name}` })),
    );
    if (skillName(document) !== name) {
      return yield* new PackageSkillSourceError({ message: `package skill SKILL.md name must match directory: ${name}` });
    }
    const linkPath = path.join(packageCandidate, ...source.skillsPath.split("/"), name);
    const currentCanonical = yield* fs.realPath(linkPath).pipe(
      Effect.mapError(() => new PackageSkillSourceError({
        message: `package skill changed during resolution: ${name}`,
      })),
    );
    if (currentCanonical !== skillRoot) {
      return yield* new PackageSkillSourceError({
        message: `package skill changed during resolution: ${name}`,
      });
    }
    paths.set(name, {
      path: skillRoot,
      linkPath,
      version: metadata.version,
    });
  }
  return paths;
});
