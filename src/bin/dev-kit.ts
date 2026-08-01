import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Command as CliCommand, Flag } from "effect/unstable/cli";
import { Console, Effect } from "effect";

import { patchEffectTsgo } from "../effect-tsgo.ts";
import { patchProjectGitignore } from "../gitignore.ts";
import {
  DEFAULT_MANIFEST,
  LEGACY_MANIFEST,
  runProjectSkillPlan,
  syncProjectSkills,
} from "../sync.ts";
import { DEV_KIT_VERSION } from "../tool-metadata.ts";
import { vendorExternalSkills } from "../vendor.ts";

const legacyInvocation =
  /(?:^|[/\\])agent-skills(?:\.[^/\\]+)?$/.test(process.argv[1] ?? "");
const executableName = legacyInvocation ? "agent-skills" : "dev-kit";
const defaultManifest = legacyInvocation ? LEGACY_MANIFEST : DEFAULT_MANIFEST;

const syncCommand = CliCommand.make(
  "sync",
  {
    dryRun: Flag.boolean("dry-run"),
    locked: Flag.boolean("locked"),
    lockfile: Flag.string("lockfile").pipe(Flag.withDefault("dev-kit.lock.json")),
    manifest: Flag.string("manifest").pipe(Flag.withDefault(defaultManifest)),
    projectDir: Flag.string("project-dir").pipe(Flag.withDefault(".")),
  },
  ({ dryRun, locked, lockfile, manifest, projectDir }) =>
    syncProjectSkills({
      dryRun,
      locked,
      lockfilePath: lockfile,
      manifestPath: manifest,
      projectDir,
    }),
).pipe(CliCommand.withDescription("Sync selected portable skills into project-local harness paths."));

const planCommand = CliCommand.make(
  "plan",
  {
    locked: Flag.boolean("locked"),
    lockfile: Flag.string("lockfile").pipe(Flag.withDefault("dev-kit.lock.json")),
    manifest: Flag.string("manifest").pipe(Flag.withDefault(defaultManifest)),
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
).pipe(CliCommand.withDescription("Plan ownership-safe project skill changes without writing files."));

const applyCommand = CliCommand.make(
  "apply",
  {
    locked: Flag.boolean("locked"),
    lockfile: Flag.string("lockfile").pipe(Flag.withDefault("dev-kit.lock.json")),
    manifest: Flag.string("manifest").pipe(Flag.withDefault(defaultManifest)),
    projectDir: Flag.string("project-dir").pipe(Flag.withDefault(".")),
  },
  ({ locked, lockfile, manifest, projectDir }) =>
    runProjectSkillPlan({
      locked,
      lockfilePath: lockfile,
      manifestPath: manifest,
      projectDir,
    }),
).pipe(CliCommand.withDescription("Apply ownership-safe project skill changes and update the lock."));

const gitignoreCommand = CliCommand.make(
  "gitignore",
  {
    dryRun: Flag.boolean("dry-run"),
    projectDir: Flag.string("project-dir").pipe(Flag.withDefault(".")),
  },
  ({ dryRun, projectDir }) => patchProjectGitignore({ dryRun, projectDir }),
).pipe(
  CliCommand.withDescription(
    "Idempotently add .repos/ and .dev-kit/ to the project .gitignore.",
  ),
);

const tsgoPatchCommand = CliCommand.make(
  "patch",
  {
    dryRun: Flag.boolean("dry-run"),
    force: Flag.boolean("force"),
    projectDir: Flag.string("project-dir").pipe(Flag.withDefault(".")),
    typescriptPackage: Flag.string("typescript-package").pipe(
      Flag.withDefault("typescript"),
    ),
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

const vendorCommand = CliCommand.make(
  "vendor",
  {
    dryRun: Flag.boolean("dry-run"),
    locked: Flag.boolean("locked"),
    lockfile: Flag.string("lockfile").pipe(Flag.withDefault("skill-sources.lock.json")),
    repoDir: Flag.string("repo-dir").pipe(Flag.withDefault(".")),
    sources: Flag.string("sources").pipe(Flag.withDefault("skill-sources.jsonc")),
  },
  ({ dryRun, locked, lockfile, repoDir, sources }) =>
    vendorExternalSkills({
      dryRun,
      locked,
      lockfilePath: lockfile,
      repoDir,
      sourcesPath: sources,
    }),
).pipe(
  CliCommand.withDescription(
    "Vendor pinned external skill sources into this repository's unified catalog.",
  ),
);

const command = CliCommand.make(executableName).pipe(
  CliCommand.withDescription("Declarative project development toolkit."),
  CliCommand.withSubcommands([
    planCommand,
    applyCommand,
    gitignoreCommand,
    tsgoCommand,
    syncCommand,
    vendorCommand,
  ] as const),
);

const program = CliCommand.run(command, { version: DEV_KIT_VERSION }).pipe(
  Effect.catch((error) =>
    Console.error(error instanceof Error ? error.message : String(error)).pipe(
      Effect.andThen(Effect.fail(error)),
    ),
  ),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
