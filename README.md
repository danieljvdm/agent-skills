# Agent Skills

Portable agent skills plus a project-local sync CLI. This repository is the
distribution boundary: projects install skills from here even when some of
them are maintained elsewhere.

## Install

```bash
bun add -d github:danieljvdm/agent-skills
```

Create `agent-skills.jsonc` in a project:

```jsonc
{
  "$schema": "./node_modules/@danieljvdm/agent-skills/schema/agent-skills.schema.json",
  "include": ["effect", "emilkowalski-skills"],
  "targets": {
    "agents": { "enabled": true, "mode": "copy" },
    "claude": { "enabled": true, "mode": "symlink" }
  }
}
```

Preview and apply selected skills:

```bash
bunx dev-kit plan
bunx dev-kit apply
```

`agent-skills sync` remains available as a compatibility alias for
`dev-kit apply`.

## Manifest

`agent-skills.jsonc` is intentionally project-local. A repo opts into only the
skills it wants:

```jsonc
{
  "$schema": "./node_modules/@danieljvdm/agent-skills/schema/agent-skills.schema.json",
  "include": ["effect"],
  "exclude": [],
  "targets": {
    "agents": { "enabled": true, "mode": "copy" },
    "claude": { "enabled": true, "mode": "symlink" },
    "opencode": { "enabled": false, "mode": "symlink" }
  }
}
```

`include` accepts family names or individual skill names. The first family is
`effect`, which expands to the consolidated `effect-ts` skill. Its focused
references cover core Effect, schemas, errors, services and layers,
observability, retries, schedules, SQL, testing, HTTP boundaries, service
audits, type safety, and Effect-powered CLI tooling. Vendored source ids are
families too, so `emilkowalski-skills` expands to every skill imported from that
source. A project can instead select an individual imported skill, such as
`animation-vocabulary`.

By default, the sync command copies selected skills into `.agents/skills`.
Symlink targets, such as `.claude/skills`, point at those project-local copies.

## Commands

```bash
dev-kit plan
dev-kit apply
dev-kit apply --locked
dev-kit gitignore
dev-kit gitignore --dry-run
dev-kit tsgo patch --dry-run
dev-kit tsgo patch
dev-kit apply --manifest agent-skills.jsonc --project-dir .

# compatibility commands
agent-skills sync
agent-skills sync --dry-run
```

`plan` is read-only. `apply` writes only destinations selected by the manifest,
then records the resolved output digests in `dev-kit.lock.json` and local
ownership receipts in `.dev-kit/state.json`. Commit `dev-kit.lock.json`; do not
commit `.dev-kit/`.

An existing destination is never adopted merely because it currently matches.
It must either have a matching local ownership receipt or exactly match a
committed lockfile entry. Modified owned outputs and unknown destinations are
reported as conflicts and preserved. Cleanup follows the same rule: dev-kit
removes only outputs that its local receipt owns and that still have their
recorded digest.

Use `--locked` in CI or postinstall automation. It refuses to apply when the
manifest or packaged skill content differs from `dev-kit.lock.json`. Apply also
uses a project-local process lock at `.dev-kit/apply.lock` to prevent concurrent
writes.

Dev-kit reserves `.repos/<source-id>` as the canonical location for
project-local source checkouts. It does not use `repos/`. Run
`dev-kit gitignore` to idempotently add `.repos/` and the local `.dev-kit/`
state directory to the project `.gitignore`; use `--dry-run` to preview the
patch. Existing lines are preserved, and symlinked `.gitignore` files are
refused rather than followed.

## Effect TypeScript-Go

This repository and toolkit pin `@effect/tsgo` and its commit-compatible native
TypeScript release together. Enable the task in the same manifest that selects
skills:

```jsonc
// agent-skills.jsonc
{
  "include": ["effect"],
  "setup": {
    "effectTsgo": { "enabled": true }
  }
}
```

The consuming project has one lifecycle hook for every configured dev-kit task,
not one hook per tool. After generating and committing `dev-kit.lock.json`, use:

```jsonc
// package.json
{
  "scripts": { "postinstall": "dev-kit apply --locked" },
  "devDependencies": {
    "@danieljvdm/agent-skills": "github:danieljvdm/agent-skills",
    "@effect/tsgo": "0.24.3",
    "typescript": "7.0.2"
  }
}
```

```jsonc
// tsconfig.json
{
  "$schema": "./node_modules/@effect/tsgo/schema.json",
  "compilerOptions": {
    "plugins": [{ "name": "@effect/language-service" }]
  }
}
```

`dev-kit plan` now previews the setup task, and `dev-kit apply` runs it together
with the rest of the manifest. The task uses only the project-local
`effect-tsgo` binary, validates both exact version pins, and patches the native
TypeScript compiler under `node_modules`. It never downloads dependencies and
skips an installation that is already patched, so repeated applies converge.

`dev-kit tsgo patch` remains available for focused troubleshooting, with
`--dry-run` for validation. The upstream `--force` escape hatch is exposed but
intentionally opt-in because it can select a binary built from a different
TypeScript commit.

Package and tsconfig edits are documented explicitly for now. They will move
into the manifest once dev-kit has contribution-level ownership for shared JSONC
files; treating either shared file as wholly owned would make cleanup unsafe.

## External sources

Declare upstream collections once in `skill-sources.jsonc`:

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
      "stripFrontmatter": ["disable-model-invocation"]
    }
  ]
}
```

Then update the vendored catalog:

```bash
bun run vendor
git diff
```

`vendor` resolves each branch or tag to a commit, validates the selected skill
folders, rejects name collisions, copies them into `skills/`, copies declared
licenses into `third-party/`, and records the exact commits in
`skill-sources.lock.json`. Commit the manifest, lockfile, vendored skills, and
licenses together.

`stripFrontmatter` is an explicit compatibility transform for upstream metadata
that a local harness does not accept. The Emil source uses it because Codex
does not recognize `disable-model-invocation`; the affected descriptions still
say that those skills require explicit invocation.

Use explicit names in `include` when new upstream skills should require an
opt-in review. Use `["*"]` when every skill in the collection should be picked
up on the next update.

To reproduce the locked snapshot without advancing upstream refs:

```bash
bun run vendor:locked
```

Locked mode also requires every output-affecting source setting to match the
lockfile, so changing selection, paths, licenses, or transforms requires a
normal `bun run vendor` update.

Downstream `agent-skills sync` never contacts the external repositories. It
only copies from this package, keeping installs centralized and reproducible.
Review vendored diffs before committing: skills are instructions your agents
will execute.
