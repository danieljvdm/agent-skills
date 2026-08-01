import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Prompt } from "effect/unstable/cli";

import { loadSkillCatalog } from "./catalog.ts";
import { isInteractiveTerminal, printDetail, printLine, printStatus } from "./cli-ui.ts";
import { DevKitManifestSchema } from "./manifest.ts";
import { runProjectSkillPlan } from "./sync.ts";
import { patchProjectGitignore } from "./gitignore.ts";

class SkillManagerError extends Schema.TaggedErrorClass<SkillManagerError>()(
  "SkillManagerError",
  { message: Schema.String },
) {}

type ManagerOptions = {
  readonly projectDir?: string;
  readonly manifestPath?: string;
  readonly apply?: boolean;
};

const packageRoot = Effect.fn("skillManagerPackageRoot")(function* () {
  const path = yield* Path.Path;
  return path.resolve(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))), "..");
});

const resolvePaths = Effect.fn("resolveSkillManagerPaths")(function* (
  options: ManagerOptions,
) {
  const path = yield* Path.Path;
  const projectDir = path.resolve(options.projectDir ?? ".");
  return {
    projectDir,
    manifestPath: path.resolve(projectDir, options.manifestPath ?? "dev-kit.jsonc"),
  };
});

const defaultManifest = `{
  "$schema": "./node_modules/@danieljvdm/dev-kit/schema/dev-kit.schema.json",
  "include": [],
  "targets": {
    "agents": { "enabled": true, "mode": "copy" }
  }
}
`;

const readManifest = Effect.fn("readManagedSkillManifest")(function* (
  options: ManagerOptions,
  create = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* resolvePaths(options);
  if (!(yield* fs.exists(paths.manifestPath))) {
    if (!create) {
      return yield* new SkillManagerError({
        message: "dev-kit.jsonc not found. Run `dev-kit init` first.",
      });
    }
    yield* fs.writeFileString(paths.manifestPath, defaultManifest);
    yield* patchProjectGitignore({ projectDir: paths.projectDir });
  }
  const raw = yield* fs.readFileString(paths.manifestPath);
  const errors: Array<ParseError> = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    return yield* new SkillManagerError({ message: `could not parse ${paths.manifestPath}` });
  }
  const manifest = yield* Schema.decodeUnknownEffect(DevKitManifestSchema)(parsed).pipe(
    Effect.mapError((error) => new SkillManagerError({ message: error.message })),
  );
  return { ...paths, manifest, raw };
});

const writeArray = Effect.fn("writeManifestArray")(function* (
  manifestPath: string,
  raw: string,
  property: "include" | "exclude",
  values: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const parsed = parseJsonc(raw) as Record<string, unknown>;
  const current = Array.isArray(parsed[property])
    ? (parsed[property] as Array<unknown>).filter((value): value is string => typeof value === "string")
    : undefined;
  if (current === undefined) {
    if (values.length === 0) return;
    const edits = modify(raw, [property], [...values], {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    yield* fs.writeFileString(manifestPath, applyEdits(raw, edits));
    return;
  }
  let next = raw;
  const retained = [...current];
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (!values.includes(current[index]!)) {
      next = applyEdits(next, modify(next, [property, index], undefined, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }));
      retained.splice(index, 1);
    }
  }
  for (const value of values) {
    if (retained.includes(value)) continue;
    next = applyEdits(next, modify(next, [property, retained.length], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
      isArrayInsertion: true,
    }));
    retained.push(value);
  }
  if (next !== raw) yield* fs.writeFileString(manifestPath, next);
});

const selectedNames = (
  include: ReadonlyArray<string>,
  exclude: ReadonlyArray<string>,
  families: Readonly<Record<string, ReadonlyArray<string>>>,
) => {
  const selected = new Set<string>();
  for (const name of include) {
    for (const skill of families[name] ?? [name]) selected.add(skill);
  }
  for (const name of exclude) {
    for (const skill of families[name] ?? [name]) selected.delete(skill);
  }
  return selected;
};

const summary = (description: string, fallback: string): string => {
  const text = description || fallback;
  const firstSentence = text.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? text;
  return firstSentence.length > 96 ? `${firstSentence.slice(0, 93).trimEnd()}…` : firstSentence;
};

const applyIfRequested = (options: ManagerOptions) =>
  options.apply === false
    ? printStatus("success", "Manifest updated", "run dev-kit sync to apply")
    : runProjectSkillPlan({
        ...(options.projectDir === undefined ? {} : { projectDir: options.projectDir }),
        ...(options.manifestPath === undefined ? {} : { manifestPath: options.manifestPath }),
      });

export const initProject = Effect.fn("initDevKitProject")(function* (options: ManagerOptions) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* resolvePaths(options);
  if (yield* fs.exists(paths.manifestPath)) {
    yield* printStatus("info", "Already initialized", paths.manifestPath);
    return;
  }
  yield* fs.writeFileString(paths.manifestPath, defaultManifest);
  yield* patchProjectGitignore({ projectDir: paths.projectDir });
  yield* printStatus("success", "Created dev-kit.jsonc");
  yield* printDetail("Add a skill with: dev-kit add <name>");
});

export const addSkills = Effect.fn("addManagedSkills")(function* (
  names: ReadonlyArray<string>,
  options: ManagerOptions,
) {
  const current = yield* readManifest(options, true);
  const catalog = yield* loadSkillCatalog(yield* packageRoot());
  const known = new Set([...catalog.skills.map((skill) => skill.name), ...Object.keys(catalog.families)]);
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    return yield* new SkillManagerError({
      message: `unknown skill${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Try \`dev-kit search ${unknown[0]}\`.`,
    });
  }
  const include = [...new Set([...current.manifest.include, ...names])];
  const exclude = (current.manifest.exclude ?? []).filter((name) => !names.includes(name));
  yield* writeArray(current.manifestPath, current.raw, "include", include);
  const reread = yield* FileSystem.FileSystem;
  yield* writeArray(
    current.manifestPath,
    yield* reread.readFileString(current.manifestPath),
    "exclude",
    exclude,
  );
  yield* applyIfRequested(options);
});

export const removeSkills = Effect.fn("removeManagedSkills")(function* (
  names: ReadonlyArray<string>,
  options: ManagerOptions,
) {
  const current = yield* readManifest(options);
  const catalog = yield* loadSkillCatalog(yield* packageRoot());
  const before = selectedNames(
    current.manifest.include,
    current.manifest.exclude ?? [],
    catalog.families,
  );
  const absent = names.filter((name) => !before.has(name) && !current.manifest.include.includes(name));
  if (absent.length > 0) {
    return yield* new SkillManagerError({ message: `not selected: ${absent.join(", ")}` });
  }
  const include = current.manifest.include.filter((name) => !names.includes(name));
  const excluded = new Set(current.manifest.exclude ?? []);
  for (const name of names) {
    if (before.has(name) && !current.manifest.include.includes(name)) excluded.add(name);
    else excluded.delete(name);
  }
  yield* writeArray(current.manifestPath, current.raw, "include", include);
  const fs = yield* FileSystem.FileSystem;
  yield* writeArray(
    current.manifestPath,
    yield* fs.readFileString(current.manifestPath),
    "exclude",
    [...excluded].sort(),
  );
  yield* applyIfRequested(options);
});

export const listSkills = Effect.fn("listManagedSkills")(function* (
  options: ManagerOptions & { readonly all?: boolean; readonly query?: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* resolvePaths(options);
  const catalog = yield* loadSkillCatalog(yield* packageRoot());
  const manifest = (yield* fs.exists(paths.manifestPath))
    ? (yield* readManifest(options)).manifest
    : { include: [], exclude: [] };
  const selected = selectedNames(manifest.include, manifest.exclude ?? [], catalog.families);
  const query = options.query?.toLowerCase();
  const visible = catalog.skills.filter((skill) =>
    (options.all || selected.has(skill.name)) &&
    (!query || `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(query)),
  );
  if (visible.length === 0) {
    yield* printStatus("info", query ? "No matching skills" : "No skills selected");
    if (!query && !options.all) yield* printDetail("Browse with: dev-kit list --all");
    return;
  }
  for (const skill of visible) {
    const marker = selected.has(skill.name) ? "✓" : " ";
    const origin = skill.bundled ? "built in" : skill.source;
    yield* printLine(`${marker} ${skill.name}  ${summary(skill.description, origin)}`);
  }
  yield* printLine();
  yield* printLine(`${selected.size} selected · ${catalog.skills.length} approved`);
});

export const showSkill = Effect.fn("showCatalogSkill")(function* (name: string) {
  const catalog = yield* loadSkillCatalog(yield* packageRoot());
  const skill = catalog.skills.find((candidate) => candidate.name === name);
  if (!skill) return yield* new SkillManagerError({ message: `unknown skill: ${name}` });
  yield* printLine(skill.name);
  if (skill.description) yield* printLine(skill.description);
  yield* printLine(`Source: ${skill.bundled ? "dev-kit (built in)" : skill.source}`);
  if (!skill.bundled) {
    const source = catalog.lock?.sources.find((candidate) => candidate.id === skill.source);
    if (source) {
      yield* printLine(`Repository: ${source.repository}`);
      yield* printLine(`Approved commit: ${source.resolved}`);
    }
  }
});

export const showDashboard = Effect.fn("showSkillDashboard")(function* (options: ManagerOptions) {
  yield* printLine("dev-kit skills");
  yield* printLine();
  yield* listSkills({ ...options, all: false });
  yield* printLine("Add      dev-kit add <skill>");
  yield* printLine("Browse   dev-kit list --all");
  yield* printLine("Find     dev-kit search <words>");
  yield* printLine("Remove   dev-kit remove <skill>");
});

export const chooseSkillsToAdd = Effect.fn("chooseSkillsToAdd")(function* (
  options: ManagerOptions,
) {
  if (!(yield* isInteractiveTerminal)) {
    return yield* new SkillManagerError({ message: "pass one or more skill names, or run this command in a terminal" });
  }
  const current = yield* readManifest(options, true);
  const catalog = yield* loadSkillCatalog(yield* packageRoot());
  const selected = selectedNames(
    current.manifest.include,
    current.manifest.exclude ?? [],
    catalog.families,
  );
  const available = catalog.skills.filter((skill) => !selected.has(skill.name));
  if (available.length === 0) {
    yield* printStatus("success", "All approved skills are selected");
    return;
  }
  const names = yield* Prompt.multiSelect({
    message: "Choose skills to add",
    choices: available.map((skill) => ({
      title: skill.name,
      value: skill.name,
      description: summary(skill.description, skill.source),
    })),
    min: 1,
  });
  yield* addSkills(names, options);
});

export const chooseSkillsToRemove = Effect.fn("chooseSkillsToRemove")(function* (
  options: ManagerOptions,
) {
  if (!(yield* isInteractiveTerminal)) {
    return yield* new SkillManagerError({ message: "pass one or more skill names, or run this command in a terminal" });
  }
  const current = yield* readManifest(options);
  const catalog = yield* loadSkillCatalog(yield* packageRoot());
  const selected = selectedNames(
    current.manifest.include,
    current.manifest.exclude ?? [],
    catalog.families,
  );
  if (selected.size === 0) {
    yield* printStatus("info", "No skills selected");
    return;
  }
  const names = yield* Prompt.multiSelect({
    message: "Choose skills to remove",
    choices: catalog.skills.filter((skill) => selected.has(skill.name)).map((skill) => ({
      title: skill.name,
      value: skill.name,
      description: summary(skill.description, skill.source),
    })),
    min: 1,
  });
  yield* removeSkills(names, options);
});
