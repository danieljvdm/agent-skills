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

Sync selected skills:

```bash
bunx agent-skills sync
```

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
`effect`, which expands to `effect-cli` and `effect-patterns`.

By default, the sync command copies selected skills into `.agents/skills`.
Symlink targets, such as `.claude/skills`, point at those project-local copies.

## Commands

```bash
agent-skills sync
agent-skills sync --dry-run
agent-skills sync --manifest agent-skills.jsonc --project-dir .
```

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
