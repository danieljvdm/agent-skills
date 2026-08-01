---
name: dev-kit
description: Dev-kit operations for projects that configure dev-kit.jsonc, sync portable skills, run plan/apply or locked postinstalls, maintain dev-kit.lock.json, resolve ownership conflicts, patch managed ignores, or enable Effect TypeScript-Go.
---

# Dev Kit

Treat `dev-kit.jsonc` as desired state, `dev-kit.lock.json` as the committed
resolution, and `.dev-kit/state.json` as local ownership receipts.

Use the high-level commands for routine changes: `dev-kit init`, `dev-kit add
<skill...>`, `dev-kit remove <skill...>`, `dev-kit list --all`, `dev-kit search
<words...>`, and `dev-kit info <skill>`. Add and remove apply immediately unless
passed `--no-apply`; `dev-kit sync` applies an already-edited manifest.

For distro maintenance, use `dev-kit catalog add <repository>` to inspect and
approve upstream skills, `catalog list`/`catalog info` to review provenance,
`catalog remove <source-or-skill>` to revoke approval, and `catalog verify` in
CI. Pass repeated `--skill` flags or `--all` outside a terminal. Approval always
stores explicit skill names and exact commit/content digests.

## Apply loop

1. Establish the Git root. Read project agent instructions, `dev-kit.jsonc`,
   `dev-kit.lock.json` when present, package and lock files, framework or tool
   configuration, CI workflows, and the configured target paths. Derive the
   capabilities the project actually uses from those signals.
2. Use `dev-kit search <terms>` and `dev-kit info <skill>` to inspect matching
   catalog entries. Prefer individual external skills; select an external
   source family only when every approved skill from it applies. Update
   `dev-kit.jsonc`, preserve JSONC comments, and validate against the package
   schema. Finish with each desired resource represented once.
3. Run `dev-kit plan`. Use `--manifest`, `--project-dir`, or `--lockfile` when
   the project overrides their defaults. Planning is read-only; inspect every
   create, update, remove, adoption, and conflict before proceeding. Finish
   when the plan contains only intended actions and understood conflicts.
4. Resolve conflicts, then run `dev-kit apply`. Commit the manifest and
   regenerated `dev-kit.lock.json`; keep `.dev-kit/` local. Finish when a second
   plan reports only unchanged resources and setup tasks.
5. Use `dev-kit apply --locked` in CI and the package lifecycle. Finish when a
   clean install converges from the committed manifest and lock.

## Manifest

Use skill names or family names in `include`; subtract selections with
`exclude`. Built-in families such as `effect` are intentional bundles. An
external source ID is also a family, but expands to every approved skill from
that source, so prefer individually relevant external skills. Include this
skill as `dev-kit` when project agents should carry the toolkit procedure.

```jsonc
{
  "$schema": "./node_modules/@danieljvdm/dev-kit/schema/dev-kit.schema.json",
  "include": ["dev-kit", "effect"],
  "exclude": [],
  "targets": {
    "agents": { "enabled": true, "mode": "copy" },
    "claude": { "enabled": true, "mode": "symlink" },
    "opencode": { "enabled": false, "mode": "symlink" }
  }
}
```

Prefer a copied `.agents/skills` target as the project-local source of truth;
use symlinks for additional harness discovery paths. Keep every target path
project-relative and separate from the manifest, lock, state, and process-lock
paths.

## Ownership and conflicts

Dev-kit adopts an existing destination only when its digest exactly matches a
committed lock entry. Local receipts authorize later updates and cleanup only
while the managed output still matches its recorded digest.

Preserve a conflicting path and inspect it:

- For an unknown destination, choose a different target or deliberately move
  the user-owned content before applying.
- For a modified managed destination, reconcile the local edits or restore its
  recorded content before applying.
- For a locked-plan mismatch, run an unlocked apply only when intentionally
  updating desired state, review the new lock, and commit it.

Retain `.dev-kit/state.json` across routine applies and branch changes so its
receipts can update or remove previously applied outputs safely.

## Project plumbing

Run `dev-kit gitignore` to add `.repos/` and `.dev-kit/` additively. Preview with
`dev-kit gitignore --dry-run`. Treat `.repos/<source-id>` as the reserved source
checkout root.

For one lifecycle entry point, configure:

```jsonc
{
  "scripts": {
    "postinstall": "dev-kit apply --locked"
  }
}
```

## Effect source checkout

Enable the source task when agents should have canonical source matching the
installed Effect package:

```jsonc
{
  "setup": {
    "effectSource": { "enabled": true }
  }
}
```

The task reads the exact installed `effect` version and converges the ignored
`.repos/effect` checkout on the corresponding `effect@<version>` tag. It skips
CI, preserves a dirty or unrelated destination, and never deletes the checkout
when disabled. Use `dev-kit effect sync --dry-run` for focused diagnosis.

Override `packageName`, `path`, or `repository` only for a compatible Effect
distribution or a deliberate mirror.

## Effect TypeScript-Go

Enable the setup task in the same manifest:

```jsonc
{
  "setup": {
    "effectTsgo": { "enabled": true }
  }
}
```

Install the exact `@effect/tsgo` and native `typescript` versions required by
the installed dev-kit. Point `tsconfig.json` at
`./node_modules/@effect/tsgo/schema.json` and configure the
`@effect/language-service` compiler plugin. `dev-kit plan` validates these local
dependencies; `dev-kit apply` patches once and then converges.

Use `dev-kit tsgo patch --dry-run` for focused diagnosis. Use `--force` only
after the user accepts a potentially commit-incompatible TypeScript binary.

## Current boundary

Manage skill outputs, the `setup.effectSource` checkout, and the explicit
`setup.effectTsgo` task. Edit shared `package.json` and `tsconfig.json`
contributions deliberately. Treat named bundles, Oxlint/Oxfmt presets, and
broader setup tasks as future manifest capabilities until the installed CLI
exposes them.
