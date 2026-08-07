import { Effect, FileSystem, Path, Result, Schema } from "effect";

import { observeSymbolicLink } from "./node-symbolic-link.ts";
import { readDirectDependencyNames } from "./project-package.ts";
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

const PackageMetadataSchema = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    intent: Schema.optional(Schema.Unknown),
    repository: Schema.optional(Schema.Unknown),
  }),
);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const hasIntentDiscoveryMetadata = (metadata: typeof PackageMetadataSchema.Type): boolean => {
  const intent = metadata.intent;

  if (
    typeof intent === "object" &&
    intent !== null &&
    "version" in intent &&
    intent.version === 1 &&
    "repo" in intent &&
    nonEmptyString(intent.repo) &&
    "docs" in intent &&
    nonEmptyString(intent.docs)
  ) {
    return true;
  }
  const repository = metadata.repository;

  return (
    nonEmptyString(repository) ||
    (typeof repository === "object" &&
      repository !== null &&
      "url" in repository &&
      nonEmptyString(repository.url))
  );
};

const isSafePackageVersion = (value: string): boolean =>
  value.length > 0 &&
  value.trim() === value &&
  ![...value].some((character) => {
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

const skillName = (document: string): string | undefined => frontmatterScalar(document, "name");

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
      return yield* PackageSkillSourceError.make({
        message: `package skill contains a symlink: ${current}`,
      });
    }
    const info = yield* fs.stat(current).pipe(
      Effect.mapError(() =>
        PackageSkillSourceError.make({
          message: `could not inspect package skill: ${current}`,
        }),
      ),
    );

    if (info.type !== "Directory") continue;
    for (const entry of yield* fs
      .readDirectory(current)
      .pipe(
        Effect.mapError(() =>
          PackageSkillSourceError.make({ message: `could not read package skill: ${current}` }),
        ),
      ))
      pending.push(path.join(current, entry));
  }
});

type InstalledPackageSkills = {
  readonly package: string;
  readonly version: string;
  readonly packageLink: string;
  readonly skillsRoot: string;
  readonly names: ReadonlyArray<string>;
};

const loadInstalledPackageSkills = Effect.fn("loadInstalledPackageSkills")(function* (
  projectDir: string,
  packageName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageLink = path.join(projectDir, "node_modules", ...packageName.split("/"));
  const packageRoot = yield* fs.realPath(packageLink).pipe(
    Effect.mapError(() =>
      PackageSkillSourceError.make({
        message: `package skill package is not installed: ${packageName}`,
      }),
    ),
  );
  const packageInfo = yield* fs.stat(packageRoot).pipe(
    Effect.mapError(() =>
      PackageSkillSourceError.make({
        message: `could not inspect package skill package: ${packageName}`,
      }),
    ),
  );

  if (packageInfo.type !== "Directory")
    return yield* PackageSkillSourceError.make({
      message: `package skill package is not a directory: ${packageName}`,
    });
  const metadata = yield* fs.readFileString(path.join(packageRoot, "package.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PackageMetadataSchema)),
    Effect.mapError(() =>
      PackageSkillSourceError.make({
        message: `invalid package.json for package skill package: ${packageName}`,
      }),
    ),
  );

  if (metadata.name !== packageName)
    return yield* PackageSkillSourceError.make({
      message: `package.json name does not match package skill package: ${packageName}`,
    });
  if (!isSafePackageVersion(metadata.version))
    return yield* PackageSkillSourceError.make({
      message: `package.json has an invalid version for package skill package: ${packageName}`,
    });
  if (!hasIntentDiscoveryMetadata(metadata))
    return yield* PackageSkillSourceError.make({
      message: `package does not declare Intent-compatible discovery metadata: ${packageName}`,
    });
  const skillsPath = "skills";
  const skillsLink = path.join(packageLink, skillsPath);

  if ((yield* observeSymbolicLink(skillsLink)).kind === "symlink")
    return yield* PackageSkillSourceError.make({
      message: `package skills path is a symlink: ${packageName}/${skillsPath}`,
    });
  const skillsRoot = yield* fs.realPath(skillsLink).pipe(
    Effect.mapError(() =>
      PackageSkillSourceError.make({
        message: `package skill package has no skills directory: ${packageName}`,
      }),
    ),
  );

  if (!isContained(path, packageRoot, skillsRoot))
    return yield* PackageSkillSourceError.make({
      message: `package skills path resolves outside package root: ${packageName}/${skillsPath}`,
    });
  const skillsInfo = yield* fs.stat(skillsRoot);

  if (skillsInfo.type !== "Directory")
    return yield* PackageSkillSourceError.make({
      message: `package skills path is not a directory: ${packageName}/${skillsPath}`,
    });
  const names = (yield* fs.readDirectory(skillsRoot).pipe(
    Effect.mapError(() =>
      PackageSkillSourceError.make({
        message: `package skill package has no readable skills directory: ${packageName}`,
      }),
    ),
  ))
    .filter(isSkillName)
    .sort();

  return {
    package: packageName,
    version: metadata.version,
    packageLink,
    skillsRoot,
    names,
  } satisfies InstalledPackageSkills;
});

const inspectPackageSkill = Effect.fn("inspectInstalledPackageSkill")(function* (
  installed: InstalledPackageSkills,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!isSkillName(name)) {
    return yield* PackageSkillSourceError.make({ message: `invalid package skill name: ${name}` });
  }
  const selector = `${installed.package}#${name}`;
  const linkPath = path.join(installed.packageLink, "skills", name);

  if ((yield* observeSymbolicLink(linkPath)).kind === "symlink") {
    return yield* PackageSkillSourceError.make({
      message: `package skill contains a symlink: ${selector}`,
    });
  }
  const skillRoot = yield* fs
    .realPath(linkPath)
    .pipe(
      Effect.mapError(() =>
        PackageSkillSourceError.make({ message: `package skill does not exist: ${selector}` }),
      ),
    );

  if (
    !isContained(path, installed.skillsRoot, skillRoot) ||
    (yield* fs.stat(skillRoot)).type !== "Directory"
  ) {
    return yield* PackageSkillSourceError.make({
      message: `package skill is not a contained directory: ${selector}`,
    });
  }
  yield* rejectNestedSymlinks(skillRoot);
  const document = yield* fs.readFileString(path.join(skillRoot, "SKILL.md")).pipe(
    Effect.mapError(() =>
      PackageSkillSourceError.make({
        message: `package skill is missing SKILL.md: ${selector}`,
      }),
    ),
  );

  if (skillName(document) !== name) {
    return yield* PackageSkillSourceError.make({
      message: `package skill SKILL.md name must match directory: ${selector}`,
    });
  }
  const description = skillDescription(document);

  if (description === undefined) {
    return yield* PackageSkillSourceError.make({
      message: `package skill SKILL.md must declare a description: ${selector}`,
    });
  }

  return {
    selector,
    name,
    description,
    package: installed.package,
    version: installed.version,
    path: skillRoot,
    linkPath,
  } satisfies DiscoveredPackageSkill;
});

/** Read direct project dependencies only; malformed packages are returned as diagnostics, never executed. */
export const discoverPackageSkills = Effect.fn("discoverInstalledPackageSkills")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates: Array<DiscoveredPackageSkill> = [];
  const diagnostics: Array<PackageSkillDiagnostic> = [];

  if (!(yield* fs.exists(path.join(projectDir, "package.json")))) {
    return { candidates, diagnostics };
  }
  for (const packageName of yield* readDirectDependencyNames(projectDir)) {
    if (!isTypeScriptPackageName(packageName)) {
      diagnostics.push({
        package: packageName,
        message: `invalid direct dependency package name: ${packageName}`,
      });
      continue;
    }
    const skillsLink = path.join(projectDir, "node_modules", ...packageName.split("/"), "skills");

    if (!(yield* fs.exists(skillsLink))) continue;
    const installed = yield* Effect.result(loadInstalledPackageSkills(projectDir, packageName));

    if (Result.isFailure(installed)) {
      diagnostics.push({ package: packageName, message: installed.failure.message });
      continue;
    }
    for (const name of installed.success.names) {
      const inspected = yield* Effect.result(inspectPackageSkill(installed.success, name));

      if (Result.isSuccess(inspected)) candidates.push(inspected.success);
      else diagnostics.push({ package: packageName, message: inspected.failure.message });
    }
  }

  return {
    candidates: candidates.sort((left, right) => left.selector.localeCompare(right.selector)),
    diagnostics,
  };
});

/** Resolve one explicitly selected package skill. Unlike browsing, every malformed or missing part is an error. */
export const resolvePackageSkillSelector = Effect.fn("resolvePackageSkillSelector")(function* (
  projectDir: string,
  selector: string,
) {
  const parsed = parseSkillSelector(selector);

  if (parsed?.type !== "package")
    return yield* PackageSkillSourceError.make({
      message: `invalid package skill selector: ${selector}`,
    });
  const directDependencies = yield* readDirectDependencyNames(projectDir);

  if (!directDependencies.includes(parsed.package))
    return yield* PackageSkillSourceError.make({
      message: `package skill package is not a direct dependency: ${parsed.package}`,
    });

  return yield* inspectPackageSkill(
    yield* loadInstalledPackageSkills(projectDir, parsed.package),
    parsed.skill,
  );
});
