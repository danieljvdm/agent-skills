import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { Console, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { ManifestSchema, normalizeManifest, type HarnessTarget } from "./manifest.ts";

export type SyncOptions = {
  readonly manifestPath?: string;
  readonly projectDir?: string;
  readonly dryRun?: boolean;
};

type SkillCatalog = Readonly<Record<string, ReadonlyArray<string>>>;

type SyncAction =
  | {
      readonly type: "copy";
      readonly skill: string;
      readonly source: string;
      readonly destination: string;
    }
  | {
      readonly type: "symlink";
      readonly skill: string;
      readonly source: string;
      readonly destination: string;
    };

class ManifestNotFoundError extends Schema.TaggedErrorClass<ManifestNotFoundError>()(
  "ManifestNotFoundError",
  {
    path: Schema.String,
  },
) {
  override get message() {
    return `manifest not found: ${this.path}`;
  }
}

class ManifestParseError extends Schema.TaggedErrorClass<ManifestParseError>()("ManifestParseError", {
  path: Schema.String,
  message: Schema.String,
}) {}

class UnknownSkillOrFamilyError extends Schema.TaggedErrorClass<UnknownSkillOrFamilyError>()(
  "UnknownSkillOrFamilyError",
  {
    name: Schema.String,
    known: Schema.Array(Schema.String),
  },
) {
  override get message() {
    return `unknown skill or family "${this.name}". Known values: ${this.known.join(", ")}`;
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

const SKILL_FAMILIES: SkillCatalog = {
  effect: ["effect-cli", "effect-patterns"],
};

const DEFAULT_MANIFEST = "agent-skills.jsonc";

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

const readManifest = Effect.fn("readManifest")(function* (manifestPath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(manifestPath))) {
    return yield* new ManifestNotFoundError({ path: manifestPath });
  }

  const raw = yield* fs.readFileString(manifestPath);
  const errors: Array<ParseError> = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    const first = errors[0]!;
    return yield* new ManifestParseError({
      path: manifestPath,
      message: `${printParseErrorCode(first.error)} at offset ${first.offset}`,
    });
  }

  return yield* Schema.decodeUnknownEffect(ManifestSchema)(parsed).pipe(
    Effect.mapError((cause) =>
      new ManifestParseError({
        path: manifestPath,
        message: cause.message,
      }),
    ),
  );
});

const discoverSkills = Effect.fn("discoverSkills")(function* (skillsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(skillsDir);
  const skills: Array<string> = [];

  for (const entry of entries) {
    const skillDir = path.join(skillsDir, entry);
    const info = yield* fs.stat(skillDir);
    if (info.type === "Directory" && (yield* fs.exists(path.join(skillDir, "SKILL.md")))) {
      skills.push(entry);
    }
  }

  return skills.sort();
});

const expandSelection = (
  include: ReadonlyArray<string>,
  exclude: ReadonlyArray<string>,
  availableSkills: ReadonlyArray<string>,
) => {
  const known = [...new Set([...Object.keys(SKILL_FAMILIES), ...availableSkills])].sort();
  const selected = new Set<string>();

  for (const name of include) {
    if (SKILL_FAMILIES[name]) {
      for (const skill of SKILL_FAMILIES[name]) {
        selected.add(skill);
      }
    } else if (availableSkills.includes(name)) {
      selected.add(name);
    } else {
      return Effect.fail(new UnknownSkillOrFamilyError({ name, known }));
    }
  }

  for (const name of exclude) {
    selected.delete(name);
  }

  return Effect.succeed([...selected].sort());
};

const destinationFor = Effect.fn("destinationFor")(function* (
  projectDir: string,
  targetPath: string,
  skill: string,
) {
  const path = yield* Path.Path;
  return path.resolve(projectDir, targetPath, skill);
});

const planActions = Effect.fn("planActions")(function* (
  projectDir: string,
  packageRoot: string,
  skills: ReadonlyArray<string>,
  targets: ReturnType<typeof normalizeManifest>["targets"],
) {
  const path = yield* Path.Path;
  const actions: Array<SyncAction> = [];
  const agentsTarget = targets.agents;

  for (const skill of skills) {
    const source = path.join(packageRoot, "skills", skill);

    for (const targetName of Object.keys(targets) as Array<HarnessTarget>) {
      const target = targets[targetName];
      if (!target.enabled) {
        continue;
      }

      const destination = yield* destinationFor(projectDir, target.path, skill);
      if (target.mode === "copy") {
        actions.push({ type: "copy", skill, source, destination });
        continue;
      }

      const linkSource =
        targetName === "agents" || !agentsTarget.enabled
          ? source
          : yield* destinationFor(projectDir, agentsTarget.path, skill);
      actions.push({ type: "symlink", skill, source: linkSource, destination });
    }
  }

  return actions;
});

const applyAction = Effect.fn("applyAction")(function* (projectDir: string, action: SyncAction) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(action.destination), { recursive: true });
  yield* fs.remove(action.destination, { recursive: true, force: true });

  if (action.type === "copy") {
    yield* fs.copy(action.source, action.destination, { overwrite: true });
    return;
  }

  const relativeSource = path.relative(path.dirname(action.destination), action.source);
  yield* fs.symlink(relativeSource, action.destination);
});

const formatAction = (projectDir: string, action: SyncAction) => {
  const destination = action.destination.startsWith(projectDir)
    ? action.destination.slice(projectDir.length + 1)
    : action.destination;
  const verb = action.type === "copy" ? "copy" : "link";
  return `${verb} ${action.skill} -> ${destination}`;
};

export const syncProjectSkills = Effect.fn("syncProjectSkills")(function* (options: SyncOptions) {
  const path = yield* Path.Path;
  const initialDir = path.resolve(options.projectDir ?? process.cwd());
  const projectDir = yield* resolveGitRoot(initialDir).pipe(
    Effect.catchCause(() => Effect.succeed(initialDir)),
  );
  const manifestPath = path.resolve(projectDir, options.manifestPath ?? DEFAULT_MANIFEST);
  const packageRoot = yield* resolvePackageRoot();
  const skillsDir = path.join(packageRoot, "skills");

  const manifest = normalizeManifest(yield* readManifest(manifestPath));
  const availableSkills = yield* discoverSkills(skillsDir);
  const selectedSkills = yield* expandSelection(manifest.include, manifest.exclude, availableSkills);
  const actions = yield* planActions(projectDir, packageRoot, selectedSkills, manifest.targets);

  if (actions.length === 0) {
    yield* Console.log("No skills selected.");
    return;
  }

  for (const action of actions) {
    yield* Console.log(formatAction(projectDir, action));
    if (!options.dryRun) {
      yield* applyAction(projectDir, action);
    }
  }
});
