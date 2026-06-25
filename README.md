# Agent Skills

Portable agent skills plus a project-local sync CLI.

## Install

```bash
bun add -d github:danieljvdm/agent-skills
```

Create `agent-skills.jsonc` in a project:

```jsonc
{
  "$schema": "./node_modules/@danieljvdm/agent-skills/schema/agent-skills.schema.json",
  "include": ["effect"],
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
