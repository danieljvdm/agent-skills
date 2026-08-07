# Dev Kit

Portable agent skills and reproducible project setup, managed from one manifest.

Dev Kit gives every project the same development conventions without requiring a
collection of unrelated postinstall scripts. It can:

- install selected skills for Codex, Claude, and OpenCode;
- run explicit setup tasks such as version-matched Effect source checkout and
  Effect TypeScript-Go patching;
- preview changes before writing them;
- lock resolved outputs for reproducible installs; and
- detect ownership conflicts without overwriting user files.

## Quick start

Install the published Dev Kit package:

```bash
bun add -d @danieljvdm/dev-kit
```

Dev Kit requires Bun 1.3 or newer. Its published executable runs TypeScript
natively with Bun and rejects direct Node.js execution.

Initialize the project, browse available built-in, approved Git, and installed
package skills, then add the ones you want:

```bash
bun x dev-kit init
bun x dev-kit list --all
bun x dev-kit add dev-kit effect
```

Before adding external skills, have the agent inspect repository instructions,
workspace dependencies, framework and tool configuration, representative
source boundaries, and CI workflows. It should compare that concrete capability
inventory with catalog descriptions and select the narrowest useful set. Broad
umbrella skills and source families belong only when their full breadth is
intentional; explicit creative or advisory requests remain valid even without a
mechanical dependency signal. Treat lazy reference folders inside one skill as
progressive-disclosure content, not as separately triggered skills; a repository
using several covered products may reasonably select that umbrella while still
excluding unrelated top-level skills.

Search and inspect candidates, then add the matching skills individually:

```bash
bun x dev-kit search cloudflare
bun x dev-kit info workers-best-practices
bun x dev-kit add workers-best-practices wrangler
```

`add` updates `dev-kit.jsonc` and applies the selection immediately. The
resulting manifest is ordinary JSONC:

In an interactive terminal, `dev-kit add` and `dev-kit remove` with no names
open a multi-select picker. Pass several names to change them in one command,
or use `--no-apply` to edit the manifest without syncing yet.

```jsonc
{
  "$schema": "./node_modules/@danieljvdm/dev-kit/schema/dev-kit.schema.json",
  "include": ["dev-kit", "effect"],
  "targets": {
    "agents": { "enabled": true, "mode": "copy" },
    "claude": { "enabled": true, "mode": "symlink" },
  },
}
```

For review-first workflows, edit the manifest or pass `--no-apply`, then:

```bash
bun x dev-kit plan
bun x dev-kit apply
```

Commit the generated `dev-kit.lock.json`, then let the package lifecycle
converge owned outputs automatically when installed packages change:

```jsonc
{
  "scripts": {
    "postinstall": "dev-kit apply",
  },
}
```

That single postinstall applies every task enabled in `dev-kit.jsonc` and
regenerates `dev-kit.lock.json` when an intentional package upgrade changes a
bundled or package-provided skill. Ownership and conflict checks still prevent
unreviewed overwrites.

Keep strict verification in CI. Either install with lifecycle scripts disabled
before running locked mode:

```bash
bun install --ignore-scripts
bun ./node_modules/@danieljvdm/dev-kit/bin/dev-kit.mjs apply --locked
```

Or allow the normal postinstall and fail CI when it leaves tracked changes.
Do not run an unlocked apply before a locked verification because that would
regenerate the drift being checked.
The package-qualified path cannot be shadowed by a consumer script named
`dev-kit`.

This repository dogfoods the same flow with its committed `dev-kit.jsonc` and
`dev-kit.lock.json`. From this source checkout, invoke the local CLI with:

```bash
bun run dev-kit plan
bun run dev-kit apply --locked
```

`bun x dev-kit` is for consuming projects where installation has created the
`node_modules/.bin/dev-kit` link; package managers do not create that link for
the root package itself.

## Commands

| Command                                    | Purpose                                                   |
| ------------------------------------------ | --------------------------------------------------------- |
| `dev-kit`                                  | Show selected skills and the four common next actions.    |
| `dev-kit init`                             | Create a minimal `dev-kit.jsonc`.                         |
| `dev-kit add <skill...>`                   | Select and immediately install skills.                    |
| `dev-kit remove <skill...>`                | Deselect and uninstall skills safely.                     |
| `dev-kit list [--all]`                     | List selected skills or browse the catalog.               |
| `dev-kit search <words...>`                | Search names and descriptions.                            |
| `dev-kit info <skill>`                     | Show description and Git or installed-package provenance. |
| `dev-kit status`                           | Check whether the project matches its selection.          |
| `dev-kit sync`                             | Apply the current manifest.                               |
| `dev-kit plan`                             | Preview project changes without writing files.            |
| `dev-kit apply`                            | Apply the manifest and update `dev-kit.lock.json`.        |
| `dev-kit apply --locked`                   | Reproduce the committed lock or fail on drift.            |
| `dev-kit gitignore`                        | Add `.repos/` and `.dev-kit/` to `.gitignore`.            |
| `dev-kit effect sync`                      | Sync `.repos/effect` to the installed Effect version.     |
| `dev-kit tsgo patch`                       | Validate and patch Effect TypeScript-Go directly.         |
| `dev-kit catalog refresh`                  | Maintainer command to approve current upstream refs.      |
| `dev-kit catalog add <repository>`         | Inspect a repository and approve selected skills.         |
| `dev-kit catalog remove <source-or-skill>` | Revoke an approval (`--yes` outside a terminal).          |
| `dev-kit catalog list`                     | List approved upstream repositories.                      |
| `dev-kit catalog info <source>`            | Show a source, commit, and approved skills.               |
| `dev-kit catalog verify`                   | Verify the committed snapshot without advancing refs.     |

Options vary by command and include `--dry-run`, `--manifest`, `--lockfile`,
and `--project-dir`. Run any command with `--help` for its complete usage.

## How it works

Dev Kit uses three project-local files:

| Path                  | Role                                                    | Commit it? |
| --------------------- | ------------------------------------------------------- | ---------- |
| `dev-kit.jsonc`       | Desired skills, targets, and setup tasks.               | Yes        |
| `dev-kit.lock.json`   | Resolved content digests and setup-tool versions.       | Yes        |
| `.dev-kit/state.json` | Local ownership receipts used during apply and cleanup. | No         |

Skills are copied into `.agents/skills` by default. Other harness targets can
copy or symlink those project-local skills.

Dev Kit only changes paths represented by the manifest. Existing unknown files,
modified managed files, and unsafe symlink paths are reported as conflicts and
left untouched. Cleanup removes only unchanged outputs with a matching local
ownership receipt.

Locked mode rejects changes to the manifest, packaged skill content, or setup
tool versions. A project-local process lock also prevents concurrent applies.

## Manifest

`include` accepts static skill names, skill families, and explicit
`<package>#<skill>` selectors:

```jsonc
{
  "$schema": "./node_modules/@danieljvdm/dev-kit/schema/dev-kit.schema.json",
  "include": [
    "dev-kit",
    "effect",
    "workers-best-practices",
    "wrangler",
    "serve-sim",
    "@tanstack/ai#ai-core",
  ],
  "exclude": ["animation-vocabulary"],
  "setup": {
    "agentInstructions": { "enabled": true },
    "claudeInstructions": { "enabled": true },
  },
  "targets": {
    "agents": { "enabled": true, "mode": "copy" },
    "claude": { "enabled": true, "mode": "symlink" },
    "opencode": { "enabled": false, "mode": "symlink" },
  },
}
```

- `dev-kit` installs guidance for operating the toolkit itself.
- `effect` expands to the package-guidance `effect-ts` bootstrap, the
  opinionated `effect-architecture-audit`, and `build-effect-apis` for shared
  HTTP contracts, Effect Atom clients, TanStack Start, and Cloudflare Workers.
- Prefer individual external skills such as `workers-best-practices` and
  `wrangler`, selected after scanning the project for relevant technologies.
- `serve-sim` selects the approved Evan Bacon simulator skill directly.
- `@tanstack/ai#ai-core` explicitly selects a skill discovered in that direct
  project dependency; discovery alone never selects it.
- An approved source ID is broad shorthand that selects every skill from that
  source. Use it only when the scan confirms that every member applies.

Dev Kit reserves `.repos/<source-id>` for project-local source checkouts. Run
`dev-kit gitignore` to add `.repos/` and `.dev-kit/` to the project ignore file.
The patch is idempotent, preserves existing lines, and refuses symlinked
`.gitignore` files.

## Agent instructions

Enable managed project-root instruction sections and a portable Claude Code
bridge in the manifest:

```jsonc
{
  "include": ["dev-kit"],
  "setup": {
    "agentInstructions": { "enabled": true },
    "claudeInstructions": { "enabled": true },
  },
}
```

`setup.agentInstructions` manages marked sections in the project-root
`AGENTS.md`, preserving handwritten project guidance around them. The Dev Kit
section contains a short description and a pointer to the installed `dev-kit`
skill. When the root `package.json` declares `vite-plus` directly, Dev Kit
renders its own repository-specific Vite+ guidance, including the unified
toolchain overview, help and documentation entry points, and `vp env doctor`
troubleshooting. It does not import Vite+'s generic `AGENTS.md`, which can
conflict with the repository's exact commands; transitive installations do not
opt a project in. Previously managed Vite+ sections are removed during a safe
owned update. Ambiguous or malformed managed markers fail closed.

The Dev Kit section also renders an opinionated project command policy. A
direct Vite+ dependency makes `vp` the only supported front door: built-in
format, lint, and test commands use `vp`, while repository tasks and package
scripts use `vp run`. When Dev Kit manages the quality config, the canonical
full validation and typecheck commands are `vp run check` and
`vp run typecheck`; `vp check` alone is only the Vite+ static-check command.
Without Vite+, Bun is the required package-script runner and Dev Kit lists only
quality scripts the root package actually declares. The package manager named
by `package.json#packageManager`, or inferred from a single recognized root
lockfile, is used only for dependency-install guidance. The policy forbids
switching script runners or bypassing project entry points with raw `tsc`,
test-runner, linter, or formatter commands.

`setup.claudeInstructions` manages `CLAUDE.md` as the relative symlink
`CLAUDE.md → AGENTS.md`. It can link to the section-managed file in the same apply,
or retain the older behavior of linking to an existing regular `AGENTS.md` when
the section task is disabled. Both outputs are recorded independently in the
lockfile and local ownership state. Disabling agent instructions removes only
unchanged managed sections and deletes `AGENTS.md` only when no handwritten
content remains.

## Vite+ Git hooks

Enable Vite+'s project-local Git hook dispatcher in the manifest:

```jsonc
{
  "include": ["dev-kit"],
  "setup": {
    "vitePlus": { "hooks": { "enabled": true } },
  },
}
```

`dev-kit apply` requires `vite-plus` as an installed direct dependency and runs
its project-local `vp config --no-agent` command when hook setup is missing. The
generated `.vite-hooks/_` dispatcher is ignored by Git, so every linked
worktree converges its own copy during install while the project-owned
`.vite-hooks/pre-commit` hook remains portable. Dev Kit preserves an unrelated
`core.hooksPath` instead of replacing another hook manager. Set
`VITE_GIT_HOOKS=0` (or `HUSKY=0`) to skip the task for that invocation.

## Vite+ quality setup

The repository always owns `vite.config.ts`. Compose Dev Kit's quality defaults
from that project-owned config, then opt into the hardened GitHub Actions
workflow independently:

```ts
import { createRecommendedVitePlusConfig } from "@danieljvdm/dev-kit/vite-plus";
import { defineConfig } from "vite-plus";

const recommended = createRecommendedVitePlusConfig({
  ignorePatterns: ["apps/api/worker-configuration.d.ts", "apps/web/src/routeTree.gen.ts"],
});

export default defineConfig({
  ...recommended,
  // Project-owned Vite, test, build, and framework options stay local.
  server: { port: 5173 },
});
```

Spread the returned top-level config before local options. When overriding a
`fmt`, `lint`, `run`, or `staged` block, spread that returned block as well so
its defaults remain composed.

The factory configures `vp staged`, matching Oxlint/Oxfmt ignores for Dev Kit's
tool-owned paths, and separate `vp run check` and pure `vp run typecheck` tasks.
Project and framework-generated paths belong in `ignorePatterns` as shown;
custom harness target paths belong there too. Dev Kit does not grow a global
framework ignore list.

```jsonc
{
  "include": ["dev-kit", "effect"],
  "setup": {
    "effectTsgo": { "enabled": true },
    "vitePlus": {
      "hooks": { "enabled": true },
      "quality": {
        "workflow": { "enabled": true },
      },
    },
  },
}
```

`quality.workflow.enabled` owns `.github/workflows/check.yml` but never reads,
rewrites, adopts, or removes `vite.config.ts`. Workflow setup requires direct
`@danieljvdm/dev-kit`, `vite-plus`, `effect`, `@effect/tsgo`, and native
TypeScript dependencies with `setup.effectTsgo.enabled`. The installed Vite+
must satisfy Dev Kit's peer range.

Workspaces select bounded, dependency-ordered typechecking in their config:

```ts
export default defineConfig(
  createRecommendedVitePlusConfig({
    typecheck: {
      strategy: "workspace",
      concurrency: 4,
      packages: ["apps/web", "packages/core"],
    },
  }),
);
```

Each listed package must expose a pure `typecheck` script. Repositories can
also declare workflow-specific preparation and typecheck commands:

```jsonc
{
  "setup": {
    "effectTsgo": { "enabled": true },
    "vitePlus": {
      "quality": {
        "workflow": {
          "enabled": true,
          "beforeChecks": [
            {
              "name": "Install media tools",
              "run": ["sudo apt-get update", "sudo apt-get install --yes ffmpeg"],
            },
          ],
          "typecheck": [
            "vp run -F './apps/*' -F './packages/*' check",
            "vp exec tsc --noEmit -p scripts/tsconfig.json",
          ],
        },
      },
    },
  },
}
```

The workflow performs one frozen, script-suppressed install, runs
`dev-kit apply --locked`, and only then runs preparation, formatting, linting,
tests, and typechecking. Its default typecheck command is `vp run typecheck`;
`workflow.typecheck` replaces it. Existing workflows remain user-owned until
their rendered content matches exactly—Dev Kit never merges YAML. See the
primary
[`setup-vp` versioning guidance](https://github.com/voidzero-dev/setup-vp#versioning),
[Vite+ install guide](https://viteplus.dev/guide/install), and
[Vite Task run guide](https://viteplus.dev/guide/run) when maintaining the
templates.

## Effect source checkout

Enable a local checkout of the exact installed Effect release in the manifest:

```jsonc
{
  "include": ["effect"],
  "setup": {
    "effectSource": { "enabled": true },
  },
}
```

`dev-kit apply` reads `node_modules/effect/package.json`, then shallow-clones or
updates `.repos/effect` to the detached `effect@<version>` tag. It skips the
checkout in CI, leaves the repository in place when the task is disabled, and
refuses to switch a checkout with local changes or an unexpected origin.

The path, package name, and repository URL may be overridden for compatible
Effect package layouts. Use `dev-kit effect sync --dry-run` to inspect this
task directly.

## Effect TypeScript-Go

Enable Effect TypeScript-Go in the same manifest:

```jsonc
{
  "include": ["effect"],
  "setup": {
    "effectSource": { "enabled": true },
    "effectTsgo": { "enabled": true },
  },
}
```

Pin the compatible packages in the consuming project:

```jsonc
{
  "devDependencies": {
    "@danieljvdm/dev-kit": "^0.2.0",
    "@effect/tsgo": "0.33.0",
    "typescript": "7.0.2",
  },
}
```

```jsonc
{
  "$schema": "./node_modules/@effect/tsgo/schema.json",
  "compilerOptions": {
    "plugins": [{ "name": "@effect/language-service" }],
  },
}
```

`dev-kit apply` validates both exact version pins and patches the project-local
native TypeScript compiler. It does not download dependencies and skips an
installation that is already patched. Use `dev-kit tsgo patch --dry-run` when
troubleshooting the task directly.

Dependency and `tsconfig.json` edits remain explicit.

## Installed package skills

Dev Kit generically discovers agent skills bundled by the project's installed
JavaScript packages. It reads the project's direct dependencies, checks the
package's Intent v1 discovery metadata (or Intent's repository-metadata
fallback), then looks for the layout
`node_modules/<package>/skills/<skill>/SKILL.md`.
TanStack is one publisher of this layout; no TanStack package names or skill
paths are hard-coded into Dev Kit.

Discovery is browse-only. These commands show an installed package skill but do
not select, copy, symlink, lock, or otherwise install it:

```bash
bun x dev-kit list --all
bun x dev-kit search tanstack
bun x dev-kit info @tanstack/ai#ai-core
```

Selection is explicit and package-qualified:

```bash
bun x dev-kit add @tanstack/ai#ai-core
```

That writes `@tanstack/ai#ai-core` to `dev-kit.jsonc` and, unless
`--no-apply` is passed, installs it through the normal ownership-safe sync
path. The qualifier prevents ambiguity when two dependencies publish the same
skill name, and the installed output carries it too: the copied directory is
named by flattening the package name (drop `@`, turn every other
non-alphanumeric run into one dash) and appending the skill name, so
`@tanstack/ai#ai-core` installs as `tanstack-ai-ai-core`. Agent harnesses
identify a project skill by its directory name, so the copied `SKILL.md`
frontmatter `name:` is rewritten to that same install name; all other content
is copied verbatim. Symlink-mode targets link straight into `node_modules`, so
only the link itself carries the qualified name while the linked frontmatter
keeps the upstream bare name. Two selected skills that would both write the
same destination are rejected before any output is changed.

The initial compatibility boundary is intentionally small and deterministic:

- only packages named in the root project's `dependencies`,
  `devDependencies`, `optionalDependencies`, or `peerDependencies` are
  scanned;
- package code is never imported or executed;
- npm-style and pnpm/workspace symlinks under `node_modules` are supported;
- Yarn Plug'n'Play and transitive dependency traversal are not scanned; and
- immediate `skills/<name>/SKILL.md` roots are listed. Nested topic skills and
  references remain part of that root and are copied with it.

The last rule adapts Intent's routed, nested skill trees to the immediate folder
and frontmatter-name invariants expected by Agent Skills targets. Dev Kit does
not rewrite nested names or ask Intent to manage agent configuration.

The project `dev-kit.lock.json` records the selected package name, installed
version, original bare skill name, and the `node_modules` content digest.
`apply --locked` therefore rejects package-version or skill-content drift.
Dev Kit never downloads a missing package or substitutes a registry version.

See TanStack's
[Agent Skills documentation](https://tanstack.com/ai/latest/docs/getting-started/agent-skills)
for a real package suite that uses this convention.

## Approved external Git skills

This repository remains an opinionated catalog for Git-hosted skills.
`skill-sources.jsonc` contains only reviewed Git sources:

```jsonc
{
  "$schema": "./schema/skill-sources.schema.json",
  "sources": [
    {
      "id": "emilkowalski-skills",
      "repository": "https://github.com/emilkowalski/skills.git",
      "ref": "main",
      "skillsPath": "skills",
      "include": ["*"],
      "licensePath": "LICENSE",
    },
  ],
}
```

Maintainers approve a new upstream snapshot with:

```bash
bun run catalog:refresh
bun run catalog:check
```

Adding a Git source does not require editing JSONC:

```bash
dev-kit catalog add https://github.com/owner/repository
dev-kit catalog add https://github.com/owner/repository \
  --skill one --skill two
dev-kit catalog add https://github.com/owner/repository --all
```

GitHub tree URLs are accepted. `--all` expands to the skills found at that
exact snapshot; it never writes a wildcard that could silently approve a future
upstream addition. Catalog refresh resolves refs to exact commits, validates
names and paths, rejects symlinks and collisions, extracts descriptions, and
updates `skill-sources.lock.json`.

When a project selects one of these Git-backed skills, Dev Kit fetches the
approved commit into the ignored `.dev-kit/cache` and installs it through the
same ownership-safe sync path. Only a reviewed catalog refresh changes the
approved Git content.

## Oxlint and Oxfmt configurations

Dev Kit exports typed Oxlint/Oxfmt presets for standalone Oxc projects. The
Vite+ factory composes both presets and keeps their tool-path ignores aligned:

```ts
import { createRecommendedVitePlusConfig } from "@danieljvdm/dev-kit/vite-plus";
import { defineConfig } from "vite-plus";

export default defineConfig(createRecommendedVitePlusConfig());
```

The shared lint preset enables `typeAware` for semantic lint rules but leaves
`typeCheck` disabled. Effect TypeScript-Go projects run:

```sh
vp fmt --check
vp lint
vp test
vp run typecheck
```

Standalone projects import the same objects from their native config files:

```ts
// oxlint.config.ts
import { recommendedOxlintConfig } from "@danieljvdm/dev-kit/oxlint";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [recommendedOxlintConfig],
});
```

```ts
// oxfmt.config.ts
import { recommendedOxfmtConfig } from "@danieljvdm/dev-kit/oxfmt";
import { defineConfig } from "oxfmt";

export default defineConfig({
  ...recommendedOxfmtConfig,
});
```

The Oxlint preset enables `stylistic/padding-line-between-statements`: adjacent
variable declarations remain grouped, while the next logical statement and
all `return` statements require a separating blank line. The rule is fixable,
so `vp lint --fix` repairs missing spacing automatically.

The preset also registers the shared `effect` JavaScript plugin. Effect
projects opt into its rules in path-specific overrides, for example
`effect/no-effect-run`, `effect/no-unsafe-promise`, and
`effect/no-untyped-throw`. The package exports the plugin directly from
`@danieljvdm/dev-kit/oxlint-plugin-effect` for configurations that do not
extend the recommended preset. Strict workflow, Atom, and boundary rules remain
consumer-scoped because application and host boundaries differ by repository.

## Development

```bash
vp install
vp run check
```
