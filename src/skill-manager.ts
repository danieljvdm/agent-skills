import { Effect, FileSystem, Path, Schema } from "effect";
import { Prompt } from "effect/unstable/cli";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";

import { loadSkillCatalog } from "./catalog.ts";
import { isInteractiveTerminal, printDetail, printLine, printStatus } from "./cli-ui.ts";
import { patchProjectGitignore } from "./gitignore.ts";
import { DevKitManifestSchema } from "./manifest.ts";
import { observeSymbolicLink } from "./node-symbolic-link.ts";
import { runProjectSkillPlan } from "./sync.ts";

class SkillManagerError extends Schema.TaggedErrorClass<SkillManagerError>()("SkillManagerError", {
  message: Schema.String,
}) {}

type ManagerOptions = {
  readonly projectDir?: string;
  readonly manifestPath?: string;
  readonly apply?: boolean;
};

const packageRoot = Effect.fn("skillManagerPackageRoot")(function* () {
  const path = yield* Path.Path;

  return path.resolve(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))), "..");
});

const resolvePaths = Effect.fn("resolveSkillManagerPaths")(function* (options: ManagerOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = path.resolve(options.projectDir ?? ".");
  const candidate = options.manifestPath ?? "dev-kit.jsonc";

  if (candidate.length === 0 || path.isAbsolute(candidate)) {
    return yield* SkillManagerError.make({
      message: "--manifest must be a non-empty project-relative path",
    });
  }
  const manifestPath = path.resolve(projectDir, candidate);
  const relative = path.relative(projectDir, manifestPath);

  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return yield* SkillManagerError.make({
      message: "--manifest must resolve inside the project",
    });
  }
  let ancestor = projectDir;

  for (const segment of relative.split(path.sep).slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    if ((yield* observeSymbolicLink(ancestor)).kind === "symlink") {
      return yield* SkillManagerError.make({
        message: `manifest ancestor is a symlink: ${path.relative(projectDir, ancestor)}`,
      });
    }
  }
  const destination = yield* observeSymbolicLink(manifestPath);

  if (destination.kind === "symlink") {
    return yield* SkillManagerError.make({ message: `manifest is a symlink: ${relative}` });
  }
  if (destination.kind === "not-symlink" && (yield* fs.stat(manifestPath)).type !== "File") {
    return yield* SkillManagerError.make({
      message: `manifest is not a regular file: ${relative}`,
    });
  }

  return {
    projectDir,
    manifestPath,
  };
});

const renderDefaultManifest = (projectDir: string, manifestPath: string, path: Path.Path) => {
  const rawSchemaPath = path.relative(
    path.dirname(manifestPath),
    path.join(
      projectDir,
      "node_modules",
      "@danieljvdm",
      "dev-kit",
      "schema",
      "dev-kit.schema.json",
    ),
  );
  const portableSchemaPath =
    path.sep === "/" ? rawSchemaPath : rawSchemaPath.split(path.sep).join("/");
  const schemaPath = portableSchemaPath.startsWith(".")
    ? portableSchemaPath
    : `./${portableSchemaPath}`;

  return `${JSON.stringify(
    {
      $schema: schemaPath,
      include: [],
      targets: { agents: { enabled: true, mode: "copy" } },
    },
    null,
    2,
  )}\n`;
};

const createDefaultManifest = Effect.fn("createDefaultSkillManifest")(function* (paths: {
  readonly projectDir: string;
  readonly manifestPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.makeDirectory(path.dirname(paths.manifestPath), { recursive: true });
  const staged = yield* fs.makeTempFileScoped({
    directory: path.dirname(paths.manifestPath),
    prefix: ".dev-kit-init-",
  });

  yield* fs.writeFileString(
    staged,
    renderDefaultManifest(paths.projectDir, paths.manifestPath, path),
  );
  yield* fs.rename(staged, paths.manifestPath);
  yield* patchProjectGitignore({ projectDir: paths.projectDir });
});

const readManifest = Effect.fn("readManagedSkillManifest")(function* (
  options: ManagerOptions,
  create = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* resolvePaths(options);

  if (!(yield* fs.exists(paths.manifestPath))) {
    if (!create) {
      return yield* SkillManagerError.make({
        message: "dev-kit.jsonc not found. Run `dev-kit init` first.",
      });
    }
    yield* createDefaultManifest(paths);
  }
  const raw = yield* fs.readFileString(paths.manifestPath);
  const errors: Array<ParseError> = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    return yield* SkillManagerError.make({ message: `could not parse ${paths.manifestPath}` });
  }
  const manifest = yield* Schema.decodeUnknownEffect(DevKitManifestSchema)(parsed).pipe(
    Effect.mapError((error) => SkillManagerError.make({ message: error.message })),
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
    ? (parsed[property] as Array<unknown>).filter(
        (value): value is string => typeof value === "string",
      )
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
    const currentValue = current[index];

    if (currentValue !== undefined && !values.includes(currentValue)) {
      next = applyEdits(
        next,
        modify(next, [property, index], undefined, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      );
      retained.splice(index, 1);
    }
  }
  for (const value of values) {
    if (retained.includes(value)) continue;
    next = applyEdits(
      next,
      modify(next, [property, retained.length], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
        isArrayInsertion: true,
      }),
    );
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

const displayValue = (value: string): string =>
  [...value]
    .map((character) => {
      const code = character.charCodeAt(0);

      return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();

const summary = (description: string, defaultDescription: string): string => {
  const text = displayValue(description || defaultDescription);
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
  yield* createDefaultManifest(paths);
  yield* printStatus("success", "Created dev-kit.jsonc");
  yield* printDetail("Add a skill with: dev-kit add <name>");
});

export const addSkills = Effect.fn("addManagedSkills")(function* (
  names: ReadonlyArray<string>,
  options: ManagerOptions,
) {
  const current = yield* readManifest(options, true);
  const catalog = yield* loadSkillCatalog(yield* packageRoot(), current.projectDir);
  const known = new Set([
    ...catalog.skills.map((skill) => skill.selector),
    ...Object.keys(catalog.families),
  ]);
  const unknown = names.filter((name) => !known.has(name));

  if (unknown.length > 0) {
    return yield* SkillManagerError.make({
      message: `unknown skill${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Try \`dev-kit search ${unknown[0]}\`.`,
    });
  }
  const sourceFamilies = catalog.lock?.sources ?? [];

  for (const source of sourceFamilies) {
    if (!names.includes(source.id)) continue;
    yield* printStatus(
      "info",
      `Source family ${source.id} selects all ${source.skills.length} approved skills`,
    );
    yield* printDetail(
      `Prefer individual skill names unless every skill applies. Inspect with: dev-kit search ${source.id}`,
    );
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
  const catalog = yield* loadSkillCatalog(yield* packageRoot(), current.projectDir);
  const before = selectedNames(
    current.manifest.include,
    current.manifest.exclude ?? [],
    catalog.families,
  );
  const absent = names.filter(
    (name) => !before.has(name) && !current.manifest.include.includes(name),
  );

  if (absent.length > 0) {
    return yield* SkillManagerError.make({ message: `not selected: ${absent.join(", ")}` });
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
  const catalog = yield* loadSkillCatalog(yield* packageRoot(), paths.projectDir);
  const manifest = (yield* fs.exists(paths.manifestPath))
    ? (yield* readManifest(options)).manifest
    : { include: [], exclude: [] };
  const selected = selectedNames(manifest.include, manifest.exclude ?? [], catalog.families);
  const query = options.query?.toLowerCase();
  const visible = catalog.skills.filter(
    (skill) =>
      (options.all || selected.has(skill.selector)) &&
      (!query ||
        `${skill.selector} ${skill.description} ${skill.source}`.toLowerCase().includes(query)),
  );
  const catalogSelectors = new Set(catalog.skills.map((skill) => skill.selector));
  const unavailable = [...selected].filter(
    (selector) =>
      !catalogSelectors.has(selector) && (!query || selector.toLowerCase().includes(query)),
  );

  if (visible.length === 0 && unavailable.length === 0) {
    yield* printStatus("info", query ? "No matching skills" : "No skills selected");
    if (!query && !options.all) yield* printDetail("Browse with: dev-kit list --all");

    return;
  }
  for (const skill of visible) {
    const marker = selected.has(skill.selector) ? "✓" : " ";
    const origin = skill.bundled ? "built in" : skill.source;
    const provenance = skill.package
      ? ` [installed ${displayValue(skill.package.version)}]`
      : skill.bundled
        ? ""
        : ` [${skill.source}]`;

    yield* printLine(
      `${marker} ${skill.selector}${provenance}  ${summary(skill.description, origin)}`,
    );
  }
  for (const selector of unavailable) {
    yield* printLine(
      `! ${selector} [unavailable]  install or repair the selected direct dependency`,
    );
  }
  yield* printLine();
  yield* printLine(`${selected.size} selected · ${catalog.skills.length} available`);
});

export const showSkill = Effect.fn("showCatalogSkill")(function* (
  name: string,
  options: ManagerOptions,
) {
  const paths = yield* resolvePaths(options);
  const catalog = yield* loadSkillCatalog(yield* packageRoot(), paths.projectDir);
  const skill = catalog.skills.find((candidate) => candidate.selector === name);

  if (!skill) return yield* SkillManagerError.make({ message: `unknown skill: ${name}` });
  yield* printLine(skill.selector);
  if (skill.description) yield* printLine(displayValue(skill.description));
  if (skill.package) {
    yield* printLine(`Source: installed package`);
    yield* printLine(`Package: ${skill.package.name}`);
    yield* printLine(`Version: ${displayValue(skill.package.version)}`);

    return;
  }
  yield* printLine(`Source: ${skill.bundled ? "dev-kit (built in)" : skill.source}`);
  if (!skill.bundled) {
    const source = catalog.lock?.sources.find((candidate) => candidate.id === skill.source);

    if (source) {
      yield* printLine(`Repository: ${source.repository}`);
      yield* printLine(`Approved commit: ${source.resolved}`);

      return;
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
    return yield* SkillManagerError.make({
      message: "pass one or more skill names, or run this command in a terminal",
    });
  }
  const current = yield* readManifest(options, true);
  const catalog = yield* loadSkillCatalog(yield* packageRoot(), current.projectDir);
  const selected = selectedNames(
    current.manifest.include,
    current.manifest.exclude ?? [],
    catalog.families,
  );
  const available = catalog.skills.filter((skill) => !selected.has(skill.selector));

  if (available.length === 0) {
    yield* printStatus("success", "All available skills are selected");

    return;
  }
  const names = yield* Prompt.multiSelect({
    message: "Choose skills to add",
    choices: available.map((skill) => ({
      title: skill.selector,
      value: skill.selector,
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
    return yield* SkillManagerError.make({
      message: "pass one or more skill names, or run this command in a terminal",
    });
  }
  const current = yield* readManifest(options);
  const catalog = yield* loadSkillCatalog(yield* packageRoot(), current.projectDir);
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
    choices: [
      ...catalog.skills
        .filter((skill) => selected.has(skill.selector))
        .map((skill) => ({
          title: skill.selector,
          value: skill.selector,
          description: summary(skill.description, skill.source),
        })),
      ...[...selected]
        .filter((selector) => !catalog.skills.some((skill) => skill.selector === selector))
        .map((selector) => ({
          title: selector,
          value: selector,
          description: "Selected but currently unavailable",
        })),
    ],
    min: 1,
  });

  yield* removeSkills(names, options);
});
