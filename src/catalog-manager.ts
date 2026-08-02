import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Prompt } from "effect/unstable/cli";

import { isInteractiveTerminal, printLine, printStatus } from "./cli-ui.ts";
import {
  SkillSourcesLockSchema,
  SkillSourcesManifestSchema,
  type ExternalSkillSource,
  type SkillSourcesLock,
  type SkillSourcesManifest,
} from "./source-manifest.ts";
import {
  inspectCatalogRepository,
  refreshSkillCatalog,
  type CatalogInspection,
} from "./vendor.ts";

type CatalogPaths = {
  readonly repoDir: string;
  readonly sourcesPath: string;
  readonly lockfilePath: string;
};

export type CatalogCommandOptions = {
  readonly repoDir?: string;
  readonly sourcesPath?: string;
  readonly lockfilePath?: string;
};

export type CatalogAddOptions = CatalogCommandOptions & {
  readonly repository: string;
  readonly id?: string;
  readonly ref?: string;
  readonly skillsPath?: string;
  readonly skills?: ReadonlyArray<string>;
  readonly all?: boolean;
  readonly licensePath?: string;
  readonly stripFrontmatter?: ReadonlyArray<string>;
  readonly dryRun?: boolean;
};

class CatalogManagerError extends Schema.TaggedErrorClass<CatalogManagerError>()(
  "CatalogManagerError",
  { message: Schema.String },
) {}

const formattingOptions = { insertSpaces: true, tabSize: 2 } as const;

const resolvePaths = Effect.fn("resolveCatalogManagerPaths")(function* (
  options: CatalogCommandOptions,
) {
  const path = yield* Path.Path;
  const repoDir = path.resolve(options.repoDir ?? ".");
  return {
    repoDir,
    sourcesPath: path.resolve(repoDir, options.sourcesPath ?? "skill-sources.jsonc"),
    lockfilePath: path.resolve(repoDir, options.lockfilePath ?? "skill-sources.lock.json"),
  } satisfies CatalogPaths;
});

const readJsonc = Effect.fn("readCatalogManagerJsonc")(function* <A>(
  filePath: string,
  schema: Schema.ConstraintDecoder<A>,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(filePath))) {
    return yield* new CatalogManagerError({ message: `file not found: ${filePath}` });
  }
  const raw = yield* fs.readFileString(filePath);
  const errors: Array<ParseError> = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    return yield* new CatalogManagerError({ message: `could not parse ${filePath}` });
  }
  const value = yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
    Effect.mapError((error) => new CatalogManagerError({ message: error.message })),
  );
  return { raw, value };
});

const readState = Effect.fn("readCatalogManagerState")(function* (
  options: CatalogCommandOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* resolvePaths(options);
  const sources = yield* readJsonc(paths.sourcesPath, SkillSourcesManifestSchema);
  const lock = (yield* fs.exists(paths.lockfilePath))
    ? yield* readJsonc(paths.lockfilePath, SkillSourcesLockSchema)
    : undefined;
  return { ...paths, sources, lock };
});

const compactDescription = (description: string): string => {
  const first = description.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? description;
  return first.length > 90 ? `${first.slice(0, 87).trimEnd()}…` : first;
};

const selectSkills = Effect.fn("selectCatalogSkills")(function* (
  inspection: CatalogInspection,
  requested: ReadonlyArray<string>,
  all: boolean,
) {
  const available = new Set(inspection.skills.map((skill) => skill.name));
  const unknown = requested.filter((skill) => !available.has(skill));
  if (unknown.length > 0) {
    return yield* new CatalogManagerError({
      message: `repository does not contain: ${unknown.join(", ")}`,
    });
  }
  if (all) {
    const selected = inspection.skills.map((skill) => skill.name);
    return { include: selected, selected };
  }
  if (requested.length > 0) return { include: [...new Set(requested)], selected: [...new Set(requested)] };
  if (!(yield* isInteractiveTerminal)) {
    return yield* new CatalogManagerError({
      message: "choose skills with --skill <name>, or pass --all",
    });
  }
  const selected = yield* Prompt.multiSelect({
    message: `Approve skills from ${inspection.id}`,
    choices: inspection.skills.map((skill) => ({
      title: skill.name,
      value: skill.name,
      ...(skill.description ? { description: compactDescription(skill.description) } : {}),
    })),
    min: 1,
  });
  return { include: selected, selected };
});

const refreshWithRollback = Effect.fn("refreshCatalogWithRollback")(function* (
  paths: CatalogPaths,
  previousSources: string,
  previousLock: string | undefined,
  updateSourceIds: ReadonlyArray<string>,
  pinSourceIds: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* refreshSkillCatalog({
    repoDir: paths.repoDir,
    sourcesPath: paths.sourcesPath,
    lockfilePath: paths.lockfilePath,
    updateSourceIds,
    pinSourceIds,
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(paths.sourcesPath, previousSources);
        if (previousLock === undefined) {
          yield* fs.remove(paths.lockfilePath, { force: true });
        } else {
          yield* fs.writeFileString(paths.lockfilePath, previousLock);
        }
        return yield* Effect.failCause(cause);
      }),
    ),
  );
});

const writeAndRefresh = Effect.fn("writeAndRefreshCatalog")(function* (
  state: {
    readonly repoDir: string;
    readonly sourcesPath: string;
    readonly lockfilePath: string;
    readonly sources: { readonly raw: string; readonly value: SkillSourcesManifest };
    readonly lock: { readonly raw: string; readonly value: SkillSourcesLock } | undefined;
  },
  nextSources: string,
  updateSourceIds: ReadonlyArray<string>,
  pinSourceIds: ReadonlyArray<string> = [],
) {
  const fs = yield* FileSystem.FileSystem;
  if (nextSources === state.sources.raw) {
    yield* printStatus("info", "Catalog already contains that selection");
    return;
  }
  const previousLock = state.lock?.raw;
  yield* fs.writeFileString(state.sourcesPath, nextSources);
  yield* refreshWithRollback(state, state.sources.raw, previousLock, updateSourceIds, pinSourceIds);
});

export const addCatalogSource = Effect.fn("addCatalogSource")(function* (
  options: CatalogAddOptions,
) {
  if (options.all && (options.skills?.length ?? 0) > 0) {
    return yield* new CatalogManagerError({ message: "use either --all or --skill, not both" });
  }
  const state = yield* readState(options);
  const inspection = yield* inspectCatalogRepository({
    repository: options.repository,
    repoDir: state.repoDir,
    ...(options.id ? { id: options.id } : {}),
    ...(options.ref ? { ref: options.ref } : {}),
    ...(options.skillsPath ? { skillsPath: options.skillsPath } : {}),
  });
  const selection = yield* selectSkills(
    inspection,
    options.skills ?? [],
    options.all ?? false,
  );
  const sources = state.sources.value.sources;
  const byId = sources.findIndex((source) => source.id === inspection.id);
  const byRepository = sources.findIndex((source) => source.repository === inspection.repository);
  if (byId >= 0 && sources[byId]?.repository !== inspection.repository) {
    return yield* new CatalogManagerError({
      message: `source id ${inspection.id} is already used by ${sources[byId]?.repository}`,
    });
  }
  if (byRepository >= 0 && sources[byRepository]?.id !== inspection.id) {
    return yield* new CatalogManagerError({
      message: `repository is already cataloged as ${sources[byRepository]?.id}`,
    });
  }
  const existingIndex = byId >= 0 ? byId : byRepository;
  let next = state.sources.raw;
  if (existingIndex >= 0) {
    const existing = sources[existingIndex];
    if (existing === undefined) {
      return yield* new CatalogManagerError({ message: "catalog source index is out of bounds" });
    }
    const approved = state.lock?.value.sources.find((source) => source.id === existing.id)?.skills ?? [];
    const currentInclude = existing.include.includes("*") ? approved : existing.include;
    const include = [...new Set([...currentInclude, ...selection.include])].sort();
    const exclude = (existing.exclude ?? []).filter((skill) => !selection.selected.includes(skill));
    next = applyEdits(next, modify(next, ["sources", existingIndex, "include"], include, { formattingOptions }));
    if (exclude.length > 0 || existing.exclude !== undefined) {
      next = applyEdits(next, modify(next, ["sources", existingIndex, "exclude"], exclude, { formattingOptions }));
    }
    if (existing.ref === "HEAD" && inspection.ref !== "HEAD") {
      next = applyEdits(next, modify(next, ["sources", existingIndex, "ref"], inspection.ref, { formattingOptions }));
    }
  } else {
    const source: ExternalSkillSource = {
      id: inspection.id,
      repository: inspection.repository,
      ref: inspection.ref,
      skillsPath: inspection.skillsPath,
      include: selection.include,
      ...(options.licensePath
        ? { licensePath: options.licensePath }
        : inspection.licensePath
        ? { licensePath: inspection.licensePath }
        : {}),
      ...(options.stripFrontmatter?.length
        ? { stripFrontmatter: [...new Set(options.stripFrontmatter)] }
        : {}),
    };
    next = applyEdits(next, modify(next, ["sources", sources.length], source, {
      formattingOptions,
      isArrayInsertion: true,
    }));
  }
  if (options.dryRun) {
    yield* printStatus(
      "plan",
      existingIndex >= 0 ? "Would update catalog source" : "Would add catalog source",
      `${inspection.id} · ${selection.selected.length} skill${selection.selected.length === 1 ? "" : "s"}`,
    );
    return;
  }
  yield* writeAndRefresh(state, next, [inspection.id]);
});

export const removeCatalogEntry = Effect.fn("removeCatalogEntry")(function* (
  name: string,
  options: CatalogCommandOptions & { readonly dryRun?: boolean; readonly yes?: boolean },
) {
  const state = yield* readState(options);
  const sources = state.sources.value.sources;
  const sourceIndex = sources.findIndex((source) => source.id === name);
  let next = state.sources.raw;
  let label: string;
  let pinSourceIds: ReadonlyArray<string> = [];
  if (sourceIndex >= 0) {
    next = applyEdits(next, modify(next, ["sources", sourceIndex], undefined, { formattingOptions }));
    label = `source ${name}`;
  } else {
    const owner = state.lock?.value.sources.find((source) => source.skills.includes(name));
    if (!owner) return yield* new CatalogManagerError({ message: `catalog entry not found: ${name}` });
    const index = sources.findIndex((source) => source.id === owner.id);
    const source = sources[index];
    if (!source) return yield* new CatalogManagerError({ message: `source not found: ${owner.id}` });
    if (source.include.includes("*")) {
      const exclude = [...new Set([...(source.exclude ?? []), name])];
      next = applyEdits(next, modify(next, ["sources", index, "exclude"], exclude, { formattingOptions }));
    } else {
      const include = source.include.filter((skill) => skill !== name);
      next = include.length === 0
        ? applyEdits(next, modify(next, ["sources", index], undefined, { formattingOptions }))
        : applyEdits(next, modify(next, ["sources", index, "include"], include, { formattingOptions }));
    }
    label = `skill ${name}`;
    pinSourceIds = [owner.id];
  }
  if (options.dryRun) {
    yield* printStatus("plan", "Would remove catalog entry", label);
    return;
  }
  if (!options.yes) {
    if (!(yield* isInteractiveTerminal)) {
      return yield* new CatalogManagerError({
        message: "catalog removal requires --yes outside a terminal",
      });
    }
    const confirmed = yield* Prompt.confirm({
      message: `Remove ${label} from the approved catalog?`,
      initial: false,
    });
    if (!confirmed) {
      yield* printStatus("info", "Cancelled");
      return;
    }
  }
  yield* writeAndRefresh(state, next, [], pinSourceIds);
});

export const listCatalogSources = Effect.fn("listCatalogSources")(function* (
  options: CatalogCommandOptions,
) {
  const state = yield* readState(options);
  if (state.sources.value.sources.length === 0) {
    yield* printStatus("info", "Catalog has no external sources");
    return;
  }
  for (const source of state.sources.value.sources) {
    const locked = state.lock?.value.sources.find((candidate) => candidate.id === source.id);
    yield* printLine(`${source.id}  ${source.repository}`);
    yield* printLine(`  ${locked?.skills.length ?? 0} skills · ${locked?.resolved.slice(0, 12) ?? "not refreshed"}`);
  }
});

export const showCatalogSource = Effect.fn("showCatalogSource")(function* (
  id: string,
  options: CatalogCommandOptions,
) {
  const state = yield* readState(options);
  const source = state.sources.value.sources.find((candidate) => candidate.id === id);
  if (!source) return yield* new CatalogManagerError({ message: `catalog source not found: ${id}` });
  const locked = state.lock?.value.sources.find((candidate) => candidate.id === id);
  yield* printLine(source.id);
  yield* printLine(`Repository: ${source.repository}`);
  yield* printLine(`Tracking: ${source.ref}`);
  if (locked) yield* printLine(`Approved commit: ${locked.resolved}`);
  yield* printLine(`Skills: ${locked?.skills.join(", ") ?? "run catalog refresh"}`);
  if (source.exclude?.length) yield* printLine(`Excluded: ${source.exclude.join(", ")}`);
});
