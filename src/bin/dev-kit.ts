import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Result } from "effect";
import { Argument, CliError, Command as CliCommand, Flag } from "effect/unstable/cli";

import {
  addCatalogSource,
  listCatalogSources,
  removeCatalogEntry,
  showCatalogSource,
} from "../catalog-manager.ts";
import { printError } from "../cli-ui.ts";
import { syncEffectSource } from "../effect-source.ts";
import { patchEffectTsgo } from "../effect-tsgo.ts";
import { patchProjectGitignore } from "../gitignore.ts";
import {
  addSkills,
  chooseSkillsToAdd,
  chooseSkillsToRemove,
  initProject,
  listSkills,
  removeSkills,
  showDashboard,
  showSkill,
} from "../skill-manager.ts";
import { DEFAULT_MANIFEST, runProjectSkillPlan } from "../sync.ts";
import { DEV_KIT_VERSION } from "../tool-metadata.ts";
import { refreshSkillCatalog } from "../vendor.ts";

const projectFlags = {
  manifest: Flag.string("manifest").pipe(
    Flag.withDefault(DEFAULT_MANIFEST),
    Flag.withDescription("Project-relative manifest path."),
  ),
  projectDir: Flag.string("project-dir").pipe(
    Flag.withDefault("."),
    Flag.withDescription("Project directory (defaults to the current directory)."),
  ),
};

const initCommand = CliCommand.make("init", projectFlags, ({ manifest, projectDir }) =>
  initProject({ manifestPath: manifest, projectDir }),
).pipe(CliCommand.withDescription("Initialize skill management in this project."));

const addCommand = CliCommand.make(
  "add",
  {
    skills: Argument.string("skills").pipe(Argument.variadic()),
    noApply: Flag.boolean("no-apply").pipe(
      Flag.withDescription("Update the manifest without installing yet."),
    ),
    ...projectFlags,
  },
  ({ skills, noApply, manifest, projectDir }) =>
    skills.length === 0
      ? chooseSkillsToAdd({ apply: !noApply, manifestPath: manifest, projectDir })
      : addSkills(skills, { apply: !noApply, manifestPath: manifest, projectDir }),
).pipe(CliCommand.withDescription("Select and install one or more available skills."));

const removeCommand = CliCommand.make(
  "remove",
  {
    skills: Argument.string("skills").pipe(Argument.variadic()),
    noApply: Flag.boolean("no-apply").pipe(
      Flag.withDescription("Update the manifest without uninstalling yet."),
    ),
    ...projectFlags,
  },
  ({ skills, noApply, manifest, projectDir }) =>
    skills.length === 0
      ? chooseSkillsToRemove({ apply: !noApply, manifestPath: manifest, projectDir })
      : removeSkills(skills, { apply: !noApply, manifestPath: manifest, projectDir }),
).pipe(CliCommand.withDescription("Deselect and uninstall one or more skills."));

const listCommand = CliCommand.make(
  "list",
  {
    all: Flag.boolean("all").pipe(Flag.withDescription("Include unselected skills.")),
    ...projectFlags,
  },
  ({ all, manifest, projectDir }) => listSkills({ all, manifestPath: manifest, projectDir }),
).pipe(CliCommand.withDescription("List selected skills; use --all to browse the catalog."));

const searchCommand = CliCommand.make(
  "search",
  { query: Argument.string("query").pipe(Argument.variadic({ min: 1 })), ...projectFlags },
  ({ query, manifest, projectDir }) =>
    listSkills({ all: true, query: query.join(" "), manifestPath: manifest, projectDir }),
).pipe(CliCommand.withDescription("Search available skill names and descriptions."));

const infoCommand = CliCommand.make(
  "info",
  { skill: Argument.string("skill"), ...projectFlags },
  ({ skill, manifest, projectDir }) => showSkill(skill, { manifestPath: manifest, projectDir }),
).pipe(CliCommand.withDescription("Show provenance and details for an available skill."));

const planCommand = CliCommand.make(
  "plan",
  {
    locked: Flag.boolean("locked"),
    lockfile: Flag.string("lockfile").pipe(Flag.withDefault("dev-kit.lock.json")),
    manifest: Flag.string("manifest").pipe(Flag.withDefault(DEFAULT_MANIFEST)),
    projectDir: Flag.string("project-dir").pipe(Flag.withDefault(".")),
  },
  ({ locked, lockfile, manifest, projectDir }) =>
    runProjectSkillPlan({
      dryRun: true,
      locked,
      lockfilePath: lockfile,
      manifestPath: manifest,
      projectDir,
    }),
).pipe(
  CliCommand.withDescription("Plan ownership-safe project skill changes without writing files."),
);

const applyCommand = CliCommand.make(
  "apply",
  {
    locked: Flag.boolean("locked"),
    lockfile: Flag.string("lockfile").pipe(Flag.withDefault("dev-kit.lock.json")),
    manifest: Flag.string("manifest").pipe(Flag.withDefault(DEFAULT_MANIFEST)),
    projectDir: Flag.string("project-dir").pipe(Flag.withDefault(".")),
  },
  ({ locked, lockfile, manifest, projectDir }) =>
    runProjectSkillPlan({
      locked,
      lockfilePath: lockfile,
      manifestPath: manifest,
      projectDir,
    }),
).pipe(
  CliCommand.withDescription("Apply ownership-safe project skill changes and update the lock."),
);

const syncCommand = CliCommand.make(
  "sync",
  {
    locked: Flag.boolean("locked"),
    lockfile: Flag.string("lockfile").pipe(Flag.withDefault("dev-kit.lock.json")),
    ...projectFlags,
  },
  ({ locked, lockfile, manifest, projectDir }) =>
    runProjectSkillPlan({ locked, lockfilePath: lockfile, manifestPath: manifest, projectDir }),
).pipe(CliCommand.withDescription("Install the skills selected in dev-kit.jsonc."));

const statusCommand = CliCommand.make(
  "status",
  {
    lockfile: Flag.string("lockfile").pipe(Flag.withDefault("dev-kit.lock.json")),
    ...projectFlags,
  },
  ({ lockfile, manifest, projectDir }) =>
    runProjectSkillPlan({
      dryRun: true,
      lockfilePath: lockfile,
      manifestPath: manifest,
      projectDir,
    }),
).pipe(CliCommand.withDescription("Check whether selected skills match the project."));

const gitignoreCommand = CliCommand.make(
  "gitignore",
  {
    dryRun: Flag.boolean("dry-run"),
    projectDir: Flag.string("project-dir").pipe(Flag.withDefault(".")),
  },
  ({ dryRun, projectDir }) => patchProjectGitignore({ dryRun, projectDir }),
).pipe(
  CliCommand.withDescription("Idempotently add .repos/ and .dev-kit/ to the project .gitignore."),
);

const tsgoPatchCommand = CliCommand.make(
  "patch",
  {
    dryRun: Flag.boolean("dry-run"),
    force: Flag.boolean("force"),
    projectDir: Flag.string("project-dir").pipe(Flag.withDefault(".")),
    typescriptPackage: Flag.string("typescript-package").pipe(Flag.withDefault("typescript")),
  },
  ({ dryRun, force, projectDir, typescriptPackage }) =>
    patchEffectTsgo({ dryRun, force, projectDir, typescriptPackage }),
).pipe(
  CliCommand.withDescription(
    "Patch the project-local native TypeScript compiler with the pinned Effect language service.",
  ),
);

const tsgoCommand = CliCommand.make("tsgo").pipe(
  CliCommand.withDescription("Manage the pinned Effect TypeScript-Go integration."),
  CliCommand.withSubcommands([tsgoPatchCommand] as const),
);

const effectSyncCommand = CliCommand.make(
  "sync",
  {
    dryRun: Flag.boolean("dry-run"),
    packageName: Flag.string("package").pipe(Flag.withDefault("effect")),
    path: Flag.string("path").pipe(Flag.withDefault(".repos/effect")),
    projectDir: Flag.string("project-dir").pipe(Flag.withDefault(".")),
    repository: Flag.string("repository").pipe(
      Flag.withDefault("https://github.com/Effect-TS/effect.git"),
    ),
  },
  ({ dryRun, packageName, path, projectDir, repository }) =>
    syncEffectSource({
      dryRun,
      packageName,
      path,
      projectDir,
      repository,
    }),
).pipe(
  CliCommand.withDescription(
    "Sync a detached Effect source checkout to the installed package version.",
  ),
);

const effectCommand = CliCommand.make("effect").pipe(
  CliCommand.withDescription("Manage the version-matched Effect source checkout."),
  CliCommand.withSubcommands([effectSyncCommand] as const),
);

const catalogFilesFlags = {
  lockfile: Flag.string("lockfile").pipe(
    Flag.withDefault("skill-sources.lock.json"),
    Flag.withDescription("Approved catalog snapshot path."),
  ),
  repoDir: Flag.string("repo-dir").pipe(
    Flag.withDefault("."),
    Flag.withDescription("Catalog repository directory."),
  ),
  sources: Flag.string("sources").pipe(
    Flag.withDefault("skill-sources.jsonc"),
    Flag.withDescription("Authored source manifest path."),
  ),
};

const catalogAddCommand = CliCommand.make(
  "add",
  {
    repository: Argument.string("repository"),
    all: Flag.boolean("all").pipe(
      Flag.withDescription("Approve every skill discovered in this snapshot."),
    ),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDescription("Inspect without writing.")),
    id: Flag.string("id").pipe(
      Flag.withDefault(""),
      Flag.withDescription("Override the inferred source id."),
    ),
    license: Flag.string("license").pipe(
      Flag.withDefault(""),
      Flag.withDescription("Repository-relative license path."),
    ),
    ref: Flag.string("ref").pipe(
      Flag.withDefault(""),
      Flag.withDescription("Branch, tag, or commit to track."),
    ),
    skill: Flag.string("skill").pipe(
      Flag.atLeast(0),
      Flag.withDescription("Approve one skill; repeat for several."),
    ),
    skillsPath: Flag.string("skills-path").pipe(
      Flag.withDefault(""),
      Flag.withDescription("Repository-relative directory containing skills."),
    ),
    stripFrontmatter: Flag.string("strip-frontmatter").pipe(
      Flag.atLeast(0),
      Flag.withDescription("Remove an upstream frontmatter key; repeat for several."),
    ),
    ...catalogFilesFlags,
  },
  ({
    repository,
    all,
    dryRun,
    id,
    license,
    ref,
    skill,
    skillsPath,
    stripFrontmatter,
    lockfile,
    repoDir,
    sources,
  }) =>
    addCatalogSource({
      repository,
      all,
      dryRun,
      skills: skill,
      stripFrontmatter,
      lockfilePath: lockfile,
      repoDir,
      sourcesPath: sources,
      ...(id ? { id } : {}),
      ...(license ? { licensePath: license } : {}),
      ...(ref ? { ref } : {}),
      ...(skillsPath ? { skillsPath } : {}),
    }),
).pipe(CliCommand.withDescription("Inspect a repository and approve selected skills."));

const catalogListCommand = CliCommand.make(
  "list",
  catalogFilesFlags,
  ({ lockfile, repoDir, sources }) =>
    listCatalogSources({ lockfilePath: lockfile, repoDir, sourcesPath: sources }),
).pipe(CliCommand.withDescription("List approved upstream repositories."));

const catalogInfoCommand = CliCommand.make(
  "info",
  { source: Argument.string("source"), ...catalogFilesFlags },
  ({ source, lockfile, repoDir, sources }) =>
    showCatalogSource(source, { lockfilePath: lockfile, repoDir, sourcesPath: sources }),
).pipe(CliCommand.withDescription("Show an approved source and its skills."));

const catalogRemoveCommand = CliCommand.make(
  "remove",
  {
    entry: Argument.string("source-or-skill"),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDescription("Preview without writing.")),
    yes: Flag.boolean("yes").pipe(Flag.withDescription("Confirm catalog revocation.")),
    ...catalogFilesFlags,
  },
  ({ entry, dryRun, yes, lockfile, repoDir, sources }) =>
    removeCatalogEntry(entry, {
      dryRun,
      yes,
      lockfilePath: lockfile,
      repoDir,
      sourcesPath: sources,
    }),
).pipe(CliCommand.withDescription("Revoke an approved source or individual skill."));

const catalogRefreshCommand = CliCommand.make(
  "refresh",
  {
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDescription("Preview without writing.")),
    locked: Flag.boolean("locked").pipe(Flag.withHidden),
    ...catalogFilesFlags,
  },
  ({ dryRun, locked, lockfile, repoDir, sources }) =>
    refreshSkillCatalog({ dryRun, locked, lockfilePath: lockfile, repoDir, sourcesPath: sources }),
).pipe(
  CliCommand.withDescription("Approve the current upstream refs as an exact catalog snapshot."),
);

const catalogVerifyCommand = CliCommand.make(
  "verify",
  catalogFilesFlags,
  ({ lockfile, repoDir, sources }) =>
    refreshSkillCatalog({ locked: true, lockfilePath: lockfile, repoDir, sourcesPath: sources }),
).pipe(CliCommand.withDescription("Verify the committed catalog without advancing refs."));

const catalogCommand = CliCommand.make("catalog").pipe(
  CliCommand.withDescription("Maintain the approved upstream catalog."),
  CliCommand.withSubcommands([
    catalogAddCommand,
    catalogRemoveCommand,
    catalogListCommand,
    catalogInfoCommand,
    catalogRefreshCommand,
    catalogVerifyCommand,
  ] as const),
);

const command = CliCommand.make("dev-kit", projectFlags, ({ manifest, projectDir }) =>
  showDashboard({ manifestPath: manifest, projectDir }),
).pipe(
  CliCommand.withDescription("Your approved skill catalog for coding agents."),
  CliCommand.withSubcommands([
    {
      group: "Skills",
      commands: [initCommand, addCommand, removeCommand, listCommand, searchCommand, infoCommand],
    },
    { group: "Project", commands: [statusCommand, syncCommand] },
    {
      group: "Advanced",
      commands: [
        planCommand,
        applyCommand,
        gitignoreCommand,
        effectCommand,
        tsgoCommand,
        catalogCommand,
      ],
    },
  ] as const),
);

const program = CliCommand.run(command, { version: DEV_KIT_VERSION }).pipe(
  Effect.catchFilter(
    (error) =>
      CliError.isCliError(error) && error._tag === "ShowHelp"
        ? Result.fail(error)
        : Result.succeed(error),
    (error) =>
      printError(error instanceof Error ? error.message : String(error)).pipe(
        Effect.andThen(Effect.fail(error)),
      ),
  ),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
