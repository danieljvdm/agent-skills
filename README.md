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

Initialize the project, browse the approved catalog, and add skills:

```bash
bun x dev-kit init
bun x dev-kit list --all
bun x dev-kit add dev-kit effect
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
    "claude": { "enabled": true, "mode": "symlink" }
  }
}
```

For review-first workflows, edit the manifest or pass `--no-apply`, then:

```bash
bun x dev-kit plan
bun x dev-kit apply
```

Commit the generated `dev-kit.lock.json`, then use locked mode in your package
lifecycle:

```jsonc
{
  "scripts": {
    "postinstall": "dev-kit apply --locked"
  }
}
```

That single postinstall applies every task enabled in `dev-kit.jsonc`.

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

| Command | Purpose |
| --- | --- |
| `dev-kit` | Show selected skills and the four common next actions. |
| `dev-kit init` | Create a minimal `dev-kit.jsonc`. |
| `dev-kit add <skill...>` | Select and immediately install skills. |
| `dev-kit remove <skill...>` | Deselect and uninstall skills safely. |
| `dev-kit list [--all]` | List selected skills or browse the catalog. |
| `dev-kit search <words...>` | Search names and descriptions. |
| `dev-kit info <skill>` | Show description, source, and approved commit. |
| `dev-kit status` | Check whether the project matches its selection. |
| `dev-kit sync` | Apply the current manifest. |
| `dev-kit plan` | Preview project changes without writing files. |
| `dev-kit apply` | Apply the manifest and update `dev-kit.lock.json`. |
| `dev-kit apply --locked` | Reproduce the committed lock or fail on drift. |
| `dev-kit gitignore` | Add `.repos/` and `.dev-kit/` to `.gitignore`. |
| `dev-kit effect sync` | Sync `.repos/effect` to the installed Effect version. |
| `dev-kit tsgo patch` | Validate and patch Effect TypeScript-Go directly. |
| `dev-kit catalog refresh` | Maintainer command to approve current upstream refs. |
| `dev-kit catalog add <repository>` | Inspect a repository and approve selected skills. |
| `dev-kit catalog remove <source-or-skill>` | Revoke an approval (`--yes` outside a terminal). |
| `dev-kit catalog list` | List approved upstream repositories. |
| `dev-kit catalog info <source>` | Show a source, commit, and approved skills. |
| `dev-kit catalog verify` | Verify the committed snapshot without advancing refs. |

Options vary by command and include `--dry-run`, `--manifest`, `--lockfile`,
and `--project-dir`. Run any command with `--help` for its complete usage.

## How it works

Dev Kit uses three project-local files:

| Path | Role | Commit it? |
| --- | --- | --- |
| `dev-kit.jsonc` | Desired skills, targets, and setup tasks. | Yes |
| `dev-kit.lock.json` | Resolved content digests and setup-tool versions. | Yes |
| `.dev-kit/state.json` | Local ownership receipts used during apply and cleanup. | No |

Skills are copied into `.agents/skills` by default. Other harness targets can
copy or symlink those project-local skills.

Dev Kit only changes paths represented by the manifest. Existing unknown files,
modified managed files, and unsafe symlink paths are reported as conflicts and
left untouched. Cleanup removes only unchanged outputs with a matching local
ownership receipt.

Locked mode rejects changes to the manifest, packaged skill content, or setup
tool versions. A project-local process lock also prevents concurrent applies.

## Manifest

`include` accepts individual skill names and skill families:

```jsonc
{
  "$schema": "./node_modules/@danieljvdm/dev-kit/schema/dev-kit.schema.json",
  "include": [
    "dev-kit",
    "effect",
    "cloudflare-skills",
    "serve-sim",
    "emilkowalski-skills"
  ],
  "exclude": ["animation-vocabulary"],
  "targets": {
    "agents": { "enabled": true, "mode": "copy" },
    "claude": { "enabled": true, "mode": "symlink" },
    "opencode": { "enabled": false, "mode": "symlink" }
  }
}
```

- `dev-kit` installs guidance for operating the toolkit itself.
- `effect` expands to the consolidated `effect-ts` skill.
- `cloudflare-skills` and `emilkowalski-skills` select every skill approved from
  those catalog sources.
- `serve-sim` selects the approved Evan Bacon simulator skill directly.
- Any approved source ID selects every skill from that catalog source.
- An individual catalog skill can be selected directly.

Dev Kit reserves `.repos/<source-id>` for project-local source checkouts. Run
`dev-kit gitignore` to add `.repos/` and `.dev-kit/` to the project ignore file.
The patch is idempotent, preserves existing lines, and refuses symlinked
`.gitignore` files.

## Effect source checkout

Enable a local checkout of the exact installed Effect release in the manifest:

```jsonc
{
  "include": ["effect"],
  "setup": {
    "effectSource": { "enabled": true }
  }
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
    "effectTsgo": { "enabled": true }
  }
}
```

Pin the compatible packages in the consuming project:

```jsonc
{
  "devDependencies": {
    "@danieljvdm/dev-kit": "0.2.0",
    "@effect/tsgo": "0.24.3",
    "typescript": "7.0.2"
  }
}
```

```jsonc
{
  "$schema": "./node_modules/@effect/tsgo/schema.json",
  "compilerOptions": {
    "plugins": [{ "name": "@effect/language-service" }]
  }
}
```

`dev-kit apply` validates both exact version pins and patches the project-local
native TypeScript compiler. It does not download dependencies and skips an
installation that is already patched. Use `dev-kit tsgo patch --dry-run` when
troubleshooting the task directly.

Package and tsconfig edits remain explicit until Dev Kit can safely own parts
of shared JSONC files.

## Approved external skills

This repository is an opinionated catalog, not a mirror of every upstream skill
tree. `skill-sources.jsonc` declares sources Dan has approved:

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
      "licensePath": "LICENSE"
    }
  ]
}
```

Maintainers approve a new upstream snapshot with:

```bash
bun run catalog:refresh
bun run catalog:check
```

Adding a source does not require editing JSONC:

```bash
# Opens a skill picker in a terminal
dev-kit catalog add https://github.com/owner/repository

# Explicit and automation-friendly
dev-kit catalog add https://github.com/owner/repository \
  --skill one --skill two
dev-kit catalog add https://github.com/owner/repository --all
```

GitHub tree URLs are accepted, so a URL such as
`https://github.com/owner/repository/tree/main/skills` supplies the repository,
ref, and skills path together. `--all` expands to the skills discovered at that
exact snapshot; it never writes a wildcard that could silently approve a future
upstream addition.

The current catalog includes approved snapshots from Emil Kowalski,
Cloudflare, and Evan Bacon. Inspect them with `dev-kit catalog list` and
`dev-kit catalog info <source>`.

The refresh resolves refs to exact commits, validates names and paths, rejects
symlinks and collisions, extracts short descriptions, and updates
`skill-sources.lock.json`. It does not copy upstream skill trees into this
repository.

When a consuming project selects an external skill, Dev Kit fetches that exact
approved commit into the ignored `.dev-kit/cache`, applies declared compatibility
transforms, and installs the result through the ownership-safe sync path. Normal
installs never float to a newer upstream commit; only a reviewed catalog refresh
changes what is approved.

## Development

```bash
bun install
bun run check
vitest run --config vitest.config.ts
```
