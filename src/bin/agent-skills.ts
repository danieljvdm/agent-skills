import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Command as CliCommand, Flag } from "effect/unstable/cli";
import { Effect } from "effect";

import { syncProjectSkills } from "../sync.ts";

const syncCommand = CliCommand.make(
  "sync",
  {
    dryRun: Flag.boolean("dry-run"),
    manifest: Flag.string("manifest").pipe(Flag.withDefault("agent-skills.jsonc")),
    projectDir: Flag.string("project-dir").pipe(Flag.withDefault(".")),
  },
  ({ dryRun, manifest, projectDir }) =>
    syncProjectSkills({
      dryRun,
      manifestPath: manifest,
      projectDir,
    }),
).pipe(CliCommand.withDescription("Sync selected agent skills into project-local harness paths."));

const command = CliCommand.make("agent-skills").pipe(
  CliCommand.withDescription("Portable agent skill sync tools."),
  CliCommand.withSubcommands([syncCommand]),
);

const program = CliCommand.run(command, { version: "0.1.0" }).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
