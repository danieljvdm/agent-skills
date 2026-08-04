---
name: dev-kit
description: Dev-kit operations for projects that configure dev-kit.jsonc, sync portable skills, run plan/apply or automatic postinstalls, perform locked CI checks, maintain dev-kit.lock.json, resolve ownership conflicts, patch managed ignores, or enable Effect TypeScript-Go.
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

1. Establish the Git root. Read project agent instructions, the current
   manifest and lock, package and workspace manifests, framework and tool
   configuration, representative source boundaries, and CI workflows. Build a
   concrete inventory of the platforms, frameworks, tools, and workflows the
   repository actually uses; do not infer capabilities from a product or
   company name alone.
2. Run `dev-kit list --all`, then use `dev-kit search <terms>` and `dev-kit info
<skill>` for each capability in the inventory. Compare every candidate's
   trigger description with concrete repository evidence. Keep explicitly
   requested creative or advisory skills even when they have no mechanical
   dependency signal.
3. Choose the narrowest useful set. Prefer focused external skills over a
   generic umbrella when they cover the repository's work. Select an umbrella
   or external source family only when its full breadth is intentionally useful;
   never select one merely because one member or product matches. Explain any
   uncertain inclusion before applying it. Distinguish separately triggered
   skills from lazy `references/` bundled inside one skill: unused reference
   folders cost repository space but are not loaded into agent context unless
   the skill routes to them. A multi-product repository can therefore justify
   an umbrella while still excluding unrelated top-level skills.
4. Update `dev-kit.jsonc`. Preserve JSONC comments and validate against the
   package schema. Finish with each desired resource represented once and every
   external selection supported by repository evidence or an explicit request.
5. Run `dev-kit plan`. Use `--manifest`, `--project-dir`, or `--lockfile` when
   the project overrides their defaults. Planning is read-only; inspect every
   create, update, remove, adoption, and conflict before proceeding. Finish
   when the plan contains only intended actions and understood conflicts.
6. Resolve conflicts, then run `dev-kit apply`. Commit the manifest and
   regenerated `dev-kit.lock.json`; keep `.dev-kit/` local. Finish when a second
   plan reports only unchanged resources and setup tasks.
7. Use `dev-kit apply` in the package lifecycle so intentional dependency
   upgrades regenerate owned outputs and `dev-kit.lock.json`. For strict CI,
   either disable lifecycle scripts before `dev-kit apply --locked`, or run the
   normal lifecycle and require the tracked working tree to remain clean. Never
   run an unlocked apply before locked verification. Finish when a clean install
   converges from the committed manifest and lock.

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
  "setup": {
    "agentInstructions": { "enabled": true },
    "claudeInstructions": { "enabled": true },
    "vitePlus": { "hooks": { "enabled": true } },
  },
  "targets": {
    "agents": { "enabled": true, "mode": "copy" },
    "claude": { "enabled": true, "mode": "symlink" },
    "opencode": { "enabled": false, "mode": "symlink" },
  },
}
```

Prefer a copied `.agents/skills` target as the project-local source of truth;
use symlinks for additional harness discovery paths. Keep every target path
project-relative and separate from the manifest, lock, state, and process-lock
paths.

Enable `setup.agentInstructions` to manage a project-root `AGENTS.md` wrapper
that points agents back to this skill. When `vite-plus` is a declared direct
dependency, dev-kit includes its installed agent instructions in the wrapper.
Enable `setup.claudeInstructions` when Claude Code should consume the same
project-root instructions; it manages `CLAUDE.md` as a relative symlink to the
wrapper or to an existing regular `AGENTS.md`. Preserve conflicting paths;
when disabled, dev-kit removes only unchanged outputs recorded in local
ownership state.

Enable `setup.vitePlus.hooks` when an installed direct `vite-plus` dependency
should manage Git hooks. Each apply checks the local `.vite-hooks/_` dispatcher,
the portable `.vite-hooks/pre-commit` hook, and `core.hooksPath`, then runs the
project-local `vp config --no-agent` when they need convergence. This recreates
ignored dispatchers in linked worktrees. Preserve other hook managers; Dev Kit
refuses to replace an unrelated `core.hooksPath`. Use `VITE_GIT_HOOKS=0` or
`HUSKY=0` to skip hook setup for an invocation.

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
    "postinstall": "dev-kit apply",
  },
}
```

This intentionally refreshes the committed lock and owned outputs when the
package manager installs a new Dev Kit or selected package-skill version.
Review and commit those changes with the dependency update. Keep
`dev-kit apply --locked` as a verification command, not the normal local
lifecycle; in CI, run it only before any unlocked apply.

## Effect source checkout

Enable the source task when agents should have canonical source matching the
installed Effect package:

```jsonc
{
  "setup": {
    "effectSource": { "enabled": true },
  },
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
    "effectTsgo": { "enabled": true },
  },
}
```

Install the exact `@effect/tsgo` and native `typescript` versions required by
the installed dev-kit. Point `tsconfig.json` at
`./node_modules/@effect/tsgo/schema.json` and configure the
`@effect/language-service` compiler plugin. `dev-kit plan` validates these local
dependencies; `dev-kit apply` patches once and then converges.

Use `dev-kit tsgo patch --dry-run` for focused diagnosis. Use `--force` only
after the user accepts a potentially commit-incompatible TypeScript binary.

## Oxlint and Oxfmt configurations

Use Dev Kit's canonical Oxlint and Oxfmt objects in Vite+ projects:

```ts
import { recommendedOxlintConfig } from "@danieljvdm/dev-kit/oxlint";
import { recommendedOxfmtConfig } from "@danieljvdm/dev-kit/oxfmt";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ...recommendedOxfmtConfig,
  },
  lint: {
    extends: [recommendedOxlintConfig],
    rules: {
      // Project-specific rules apply after the shared preset.
    },
  },
});
```

Use `lint.extends` instead of spreading the object so Vite+ composes nested
rule maps correctly. Oxfmt has no inheritance mechanism, so spread its object
before project-local options. Standalone `oxlint.config.ts` uses the same
`extends: [recommendedOxlintConfig]`; standalone `oxfmt.config.ts` spreads the
same `recommendedOxfmtConfig`.

The Oxlint preset registers Dev Kit's shared Effect plugin as `effect`, but
does not enable its scope-sensitive rules globally. Effect projects should
enable rules such as `effect/no-effect-run`, `effect/no-unsafe-promise`, and
`effect/no-untyped-throw` only in Effect-owned code, with explicit exceptions
for tests and host boundaries. The stricter `effect/no-async-workflow`,
`effect/no-promise-atom-mode`, and `effect/no-sync-boundary-decode` rules also
need consumer-owned scopes. Keep repository-specific paths and platform rules
in the consuming project.

## Current boundary

Manage skill outputs, the `setup.agentInstructions` wrapper, the
`setup.claudeInstructions` link, the `setup.vitePlus.hooks` dispatcher,
the `setup.effectSource` checkout, and the explicit `setup.effectTsgo` task. Edit
shared `package.json` and `tsconfig.json`
contributions deliberately. The Oxlint and Oxfmt configurations are composable
package exports, not manifest-managed outputs. Treat broader setup tasks as
future manifest capabilities until the installed CLI exposes them.
