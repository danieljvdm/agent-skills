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
