# Dev Kit

Portable agent skills and reproducible project setup, managed from one manifest.

Dev Kit gives every project the same development conventions without requiring a
collection of unrelated postinstall scripts. It can:

- install selected skills for Codex, Claude, and OpenCode;
- run explicit setup tasks such as Effect TypeScript-Go patching;
- preview changes before writing them;
- lock resolved outputs for reproducible installs; and
- detect ownership conflicts without overwriting user files.

## Quick start

Install Dev Kit from GitHub:

```bash
bun add -d github:danieljvdm/agent-skills
```

Create `dev-kit.jsonc`:

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

Preview and apply the configuration:

```bash
bunx dev-kit plan
bunx dev-kit apply
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

## Commands

| Command | Purpose |
| --- | --- |
| `dev-kit plan` | Preview project changes without writing files. |
| `dev-kit apply` | Apply the manifest and update `dev-kit.lock.json`. |
| `dev-kit apply --locked` | Reproduce the committed lock or fail on drift. |
| `dev-kit gitignore` | Add `.repos/` and `.dev-kit/` to `.gitignore`. |
| `dev-kit tsgo patch` | Validate and patch Effect TypeScript-Go directly. |
| `dev-kit vendor` | Update this repository's pinned external skills. |

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
  "include": ["dev-kit", "effect", "emilkowalski-skills"],
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
- A vendored source ID selects all skills imported from that source.
- An individual imported skill can be selected directly.

Dev Kit reserves `.repos/<source-id>` for project-local source checkouts. Run
`dev-kit gitignore` to add `.repos/` and `.dev-kit/` to the project ignore file.
The patch is idempotent, preserves existing lines, and refuses symlinked
`.gitignore` files.

## Effect TypeScript-Go

Enable Effect TypeScript-Go in the same manifest:

```jsonc
{
  "include": ["effect"],
  "setup": {
    "effectTsgo": { "enabled": true }
  }
}
```

Pin the compatible packages in the consuming project:

```jsonc
{
  "devDependencies": {
    "@danieljvdm/dev-kit": "github:danieljvdm/agent-skills",
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

## Vendored skills

This repository can distribute skills maintained elsewhere without contacting
their source repositories during downstream installs. Sources are declared in
`skill-sources.jsonc`:

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

Update or reproduce the vendored catalog with:

```bash
bun run vendor
bun run vendor:locked
```

`vendor` resolves refs to commits, validates selected skills, rejects name
collisions, copies declared licenses, and updates `skill-sources.lock.json`.
Review and commit the manifest, lockfile, skills, and licenses together.

## Development

```bash
bun install
bun run check
vitest run --config vitest.config.ts
```
