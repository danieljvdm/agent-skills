import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import {
  discoverPackageSkills,
  resolvePackageSkillSelector,
  type DiscoveredPackageSkill,
} from "./package-skill-source.ts";
import { observePath, type Digest } from "./path-digest.ts";
import { packageSkillInstallName } from "./skill-selector.ts";
import {
  SkillSourcesLockSchema,
  type LockedSkillSource,
  type SkillSourcesLock,
} from "./source-manifest.ts";

export type CatalogSkill = {
  readonly name: string;
  readonly selector: string;
  readonly description: string;
  readonly source: string;
  readonly bundled: boolean;
  readonly package?: {
    readonly name: string;
    readonly version: string;
  };
};

export type SkillCatalog = {
  readonly skills: ReadonlyArray<CatalogSkill>;
  readonly families: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly lock?: SkillSourcesLock;
};

export type ResolvedSkillSource = {
  readonly path: string;
  readonly linkPath?: string;
  readonly catalog?:
    | {
        readonly source: string;
        readonly repository: string;
        readonly resolved: string;
      }
    | {
        readonly package: string;
        readonly version: string;
        readonly skill: string;
        readonly digest: Digest;
      };
};

class CatalogError extends Schema.TaggedError<CatalogError>()("CatalogError", {
  message: Schema.String,
}) {}

const runGit = Effect.fn("runCatalogGit")(function* (cwd: string, args: ReadonlyArray<string>) {
  const child = yield* ChildProcess.make("git", args, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [output, exitCode] = yield* Effect.all([
    Stream.mkString(Stream.decodeText(child.all)),
    child.exitCode,
  ]);

  if (exitCode !== 0) {
    return yield* CatalogError.make({
      message: `git ${args.join(" ")} failed: ${output.trim()}`,
    });
  }

  return output.trim();
});

const readCatalogLock = Effect.fn("readCatalogLock")(function* (packageRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockPath = path.join(packageRoot, "skill-sources.lock.json");

  if (!(yield* fs.exists(lockPath))) return undefined;
  const raw = yield* fs.readFileString(lockPath);
  const errors: Array<ParseError> = [];
  const value = parseJsonc(raw, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    return yield* CatalogError.make({ message: `invalid skill catalog lock: ${lockPath}` });
  }

  return yield* Schema.decodeUnknownEffect(SkillSourcesLockSchema)(value).pipe(
    Effect.mapError((error) => CatalogError.make({ message: error.message })),
  );
});

const readDescription = Effect.fn("readSkillDescription")(function* (skillPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(path.join(skillPath, "SKILL.md"));

  return (
    text
      .match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
      ?.split(/\r?\n/)
      .find((line) => line.startsWith("description:"))
      ?.slice("description:".length)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2") ?? ""
  );
});

export const loadSkillCatalog = Effect.fn("loadSkillCatalog")(function* (
  packageRoot: string,
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillsDir = path.join(packageRoot, "skills");
  const skills: Array<CatalogSkill> = [];

  if (yield* fs.exists(skillsDir)) {
    for (const name of (yield* fs.readDirectory(skillsDir)).sort()) {
      const skillPath = path.join(skillsDir, name);

      if (yield* fs.exists(path.join(skillPath, "SKILL.md"))) {
        skills.push({
          name,
          selector: name,
          description: yield* readDescription(skillPath),
          source: "built-in",
          bundled: true,
        });
      }
    }
  }
  const lock = yield* readCatalogLock(packageRoot);

  for (const source of lock?.sources ?? []) {
    for (const name of source.skills) {
      skills.push({
        name,
        selector: name,
        description: source.descriptions?.[name] ?? "",
        source: source.id,
        bundled: false,
      });
    }
  }
  const discovery = yield* discoverPackageSkills(projectDir);

  for (const candidate of discovery.candidates) {
    skills.push({
      name: packageSkillInstallName(candidate.package, candidate.name),
      selector: candidate.selector,
      description: candidate.description,
      source: candidate.package,
      bundled: false,
      package: { name: candidate.package, version: candidate.version },
    });
  }
  const duplicates = skills.filter(
    (skill, index) =>
      skills.findIndex((candidate) => candidate.selector === skill.selector) !== index,
  );

  if (duplicates.length > 0) {
    return yield* CatalogError.make({
      message: `duplicate catalog skill selector: ${duplicates[0]?.selector ?? "unknown"}`,
    });
  }
  const externalFamilies = (lock?.sources ?? []).map(
    (source) => [source.id, source.skills] as const,
  );
  const duplicateFamily = externalFamilies.find(
    ([id], index) => externalFamilies.findIndex(([candidate]) => candidate === id) !== index,
  );

  if (duplicateFamily !== undefined) {
    return yield* CatalogError.make({
      message: `duplicate catalog family: ${duplicateFamily[0]}`,
    });
  }
  const families: Readonly<Record<string, ReadonlyArray<string>>> = {
    effect: ["effect-ts", "effect-architecture-audit", "build-effect-apis"],
    "effect-atom-data-fetching": ["effect-ts", "effect-architecture-audit", "build-effect-apis"],
    ...Object.fromEntries(externalFamilies),
  };

  return {
    skills: skills.sort((left, right) => left.selector.localeCompare(right.selector)),
    families,
    ...(lock ? { lock } : {}),
  } satisfies SkillCatalog;
});

const stripFrontmatterKeys = (text: string, keys: ReadonlyArray<string>): string => {
  if (keys.length === 0) return text;
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);

  if (!frontmatter?.[1]) return text;
  const stripped = new Set(keys);
  let skipping = false;
  const lines = frontmatter[1].split(/\r?\n/).filter((line) => {
    const key = line.match(/^([A-Za-z0-9_-]+):/)?.[1];

    if (key) skipping = stripped.has(key);

    return !skipping;
  });

  return `---\n${lines.join("\n")}\n---${frontmatter[2]}${text.slice(frontmatter[0].length)}`;
};

const rewriteFrontmatterName = (text: string, name: string): string => {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);

  if (!frontmatter?.[1]) return text;
  let replacing = false;
  const lines = frontmatter[1].split(/\r?\n/).flatMap((line) => {
    const key = line.match(/^([A-Za-z0-9_-]+):/)?.[1];

    if (key !== undefined) replacing = key === "name";

    return replacing ? (key === undefined ? [] : [`name: ${name}`]) : [line];
  });

  return `---\n${lines.join("\n")}\n---${frontmatter[2]}${text.slice(frontmatter[0].length)}`;
};

const materializePackageSkill = Effect.fn("materializePackageSkill")(function* (
  projectDir: string,
  skill: DiscoveredPackageSkill,
  digest: Digest,
  cache: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const installName = packageSkillInstallName(skill.package, skill.name);
  const root = cache
    ? path.join(projectDir, ".dev-kit", "cache", "package-skills", installName)
    : path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-package-plan-" }),
        installName,
      );
  const staged = path.join(root, "skill");
  const ready = path.join(root, ".ready");
  const stamp = `${skill.version}\n${digest}\n`;

  if (!(yield* fs.exists(ready)) || (yield* fs.readFileString(ready)) !== stamp) {
    yield* fs.remove(root, { force: true, recursive: true });
    yield* fs.makeDirectory(root, { recursive: true });
    yield* fs.copy(skill.path, staged, { overwrite: true });
    const document = path.join(staged, "SKILL.md");

    yield* fs.writeFileString(
      document,
      rewriteFrontmatterName(yield* fs.readFileString(document), installName),
    );
    yield* fs.writeFileString(ready, stamp);
  }

  return staged;
});

const materializeSource = Effect.fn("materializeCatalogSource")(function* (
  projectDir: string,
  source: LockedSkillSource,
  selected: ReadonlyArray<string>,
  cache: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = cache
    ? path.join(projectDir, ".dev-kit", "cache", "catalog", source.id, source.resolved)
    : path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-catalog-plan-" }),
        source.id,
        source.resolved,
      );
  const checkout = path.join(root, "checkout");
  const ready = path.join(root, ".ready");

  if (!(yield* fs.exists(ready))) {
    yield* fs.remove(root, { force: true, recursive: true });
    yield* fs.makeDirectory(checkout, { recursive: true });
    yield* runGit(checkout, ["init", "--quiet"]);
    yield* runGit(checkout, ["remote", "add", "origin", source.repository]);
    yield* runGit(checkout, ["fetch", "--quiet", "--depth", "1", "origin", source.resolved]);
    yield* runGit(checkout, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    const actual = yield* runGit(checkout, ["rev-parse", "HEAD"]);

    if (actual !== source.resolved) {
      return yield* CatalogError.make({
        message: `source ${source.id} resolved to ${actual}, expected ${source.resolved}`,
      });
    }
    const symlinks = yield* runGit(checkout, ["ls-files", "--stage", "--", source.skillsPath]);

    if (symlinks.split(/\r?\n/).some((line) => line.startsWith("120000 "))) {
      return yield* CatalogError.make({
        message: `source ${source.id} contains symlinks; refusing to install it`,
      });
    }
    for (const skill of source.skills) {
      const from = path.join(checkout, source.skillsPath, skill);
      const to = path.join(root, "skills", skill);
      const observation = yield* observePath(from);

      if (observation.kind !== "directory") {
        return yield* CatalogError.make({
          message: `source ${source.id} is missing skill ${skill}`,
        });
      }
      yield* fs.copy(from, to, { overwrite: true });
      if (source.stripFrontmatter?.length) {
        const document = path.join(to, "SKILL.md");

        yield* fs.writeFileString(
          document,
          stripFrontmatterKeys(yield* fs.readFileString(document), source.stripFrontmatter),
        );
      }
    }
    yield* fs.writeFileString(ready, `${source.resolved}\n`);
  }
  for (const skill of selected) {
    const observation = yield* observePath(path.join(root, "skills", skill));
    const approvedDigest = source.digests?.[skill];

    if (
      approvedDigest !== undefined &&
      (observation.kind !== "directory" || observation.digest !== approvedDigest)
    ) {
      return yield* CatalogError.make({
        message: `cached skill ${skill} does not match the approved catalog; remove ${root} and retry`,
      });
    }
  }

  return new Map(
    selected.map((skill) => [
      skill,
      {
        path: path.join(root, "skills", skill),
        catalog: {
          source: source.id,
          repository: source.repository,
          resolved: source.resolved,
        },
      } satisfies ResolvedSkillSource,
    ]),
  );
});

export const resolveSkillSources = Effect.fn("resolveSkillSources")(function* (
  packageRoot: string,
  projectDir: string,
  catalog: SkillCatalog,
  selected: ReadonlyArray<string>,
  cache = true,
) {
  const path = yield* Path.Path;
  const sources = new Map<string, ResolvedSkillSource>();

  for (const skill of catalog.skills.filter((skill) => skill.bundled)) {
    if (selected.includes(skill.selector)) {
      sources.set(skill.selector, { path: path.join(packageRoot, "skills", skill.name) });
    }
  }
  for (const source of catalog.lock?.sources ?? []) {
    const wanted = source.skills.filter((skill) => selected.includes(skill));

    if (wanted.length === 0) continue;
    for (const [name, sourcePath] of yield* materializeSource(projectDir, source, wanted, cache)) {
      sources.set(name, sourcePath);
    }
  }
  for (const selector of selected.filter((value) => value.includes("#"))) {
    const resolved = yield* resolvePackageSkillSelector(projectDir, selector);
    const observation = yield* observePath(resolved.path);

    if (observation.kind !== "directory") {
      return yield* CatalogError.make({ message: `package skill is missing: ${selector}` });
    }
    sources.set(selector, {
      path: yield* materializePackageSkill(projectDir, resolved, observation.digest, cache),
      linkPath: resolved.linkPath,
      catalog: {
        package: resolved.package,
        version: resolved.version,
        skill: resolved.name,
        digest: observation.digest,
      },
    });
  }

  return sources;
});
