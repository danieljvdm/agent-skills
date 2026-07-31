---
name: update-deps
description: Update or audit dependencies in this agent-skills/dev-kit repository with compatibility-aware handling for the Effect v4 package family, @effect/vitest and Vitest, @effect/tsgo and its commit-matched native TypeScript compiler, Bun, and ordinary npm packages. Use when asked to update, refresh, audit, check, or pin dependency versions, regenerate bun.lock, refresh local upstream source checkouts, or resolve dependency/toolchain drift in this repository.
---

# Update Dependencies

Update dependencies as coupled toolchain groups, not as an undifferentiated
`latest` operation. Treat all target versions as live data and verify them from
primary sources at execution time.

## Establish the baseline

1. Read `package.json`, `bun.lock`, `tsconfig.json`, and the working-tree status.
2. Run the current `bun run check` and the narrowest relevant tests before
   changing versions. Record any pre-existing failures.
3. Inventory direct dependencies with `bun outdated` and exact registry data
   with `npm view`. Do not infer current versions from this skill.
4. Search every current version string with `rg` before editing. Version pins
   also live in source constants, tests, README examples, and the Effect skill.
5. Preserve unrelated user changes. Do not use destructive Git commands.

Before mutation, summarize the proposed groups, current versions, target
versions, compatibility evidence, and any release-line migration.

## Upgrade groups

### Effect v4 family

Keep these packages on one exact Effect v4 version:

- `effect`
- `@effect/platform-node`
- `@effect/vitest`

Resolve the current v4 release line with registry dist-tags. This repository is
intentionally on Effect v4; never fall back to the v3 `latest` tag. Treat a
beta-to-stable transition as a migration that requires release-note and source
review, not as a mechanical bump.

For an Effect upgrade:

1. Verify that every required `@effect/*` package exists at the same exact
   version.
2. Check the matching canonical tag in `Effect-TS/effect` and update the
   ignored `.repos/effect` checkout to that exact tag. Never use `main` as
   evidence for installed behavior.
3. Inspect changed declarations and migration notes for APIs used under `src/`
   and `test/` before editing application code.
4. Update the review baseline and source command in:
   - `skills/effect-ts/SKILL.md`
   - `skills/effect-ts/references/version-and-source.md`
   - `skills/effect-ts/UPSTREAM.md`
5. Keep `@effect/vitest` aligned with Effect, then verify its supported Vitest
   range and the version used by the matching Effect source checkout before
   changing `vitest`.

Use exact versions. Install the whole group in one package-manager operation so
the lockfile cannot represent a mixed beta set.

### Effect TypeScript-Go pair

`@effect/tsgo` and native `typescript` are a commit-compatible pair. A matching
major or semver range is insufficient.

For a tsgo upgrade:

1. Resolve the latest published `@effect/tsgo` release from GitHub releases and
   npm. Do not take the unreleased version from repository `main`.
2. Inspect the published platform package's `lib/tsc.json` and
   `lib/tsc-next.json`. Prefer the `tsc.json` stable profile unless the user
   explicitly requests TypeScript next. The release tag's
   `_packages/tsgo/upstream.json` may describe the setup default or preview
   profile only; never use it alone to select the stable compiler.
3. Verify both `version` and `gitHead`: the chosen profile's `tsVersion` and
   `tsGitHead` must equal the metadata from the exact published `typescript`
   package. If the platform package is not installed yet, inspect its npm
   tarball in a temporary directory.
4. Update both exact dev-dependency pins together.
5. Update the coupled constants in `src/effect-tsgo.ts`:
   - `EFFECT_TSGO_VERSION`
   - `EFFECT_TSGO_TYPESCRIPT_VERSION`
6. Update README examples and tests that contain either pin.
7. Refresh `.repos/tsgo` to the published release tag when source-level
   verification is needed. Keep the checkout under `.repos/`, never `repos/`.
8. Install first, then run `bun run tsgo:patch`. Do not use upstream `--force`
   for a normal update.
9. Confirm `bun run tsgo:patch` converges on a second run without creating a
   numbered backup.

Keep the `@effect/language-service` plugin and tsgo schema in `tsconfig.json`.
Run the normal `tsc`-based check after patching; the patched compiler emits the
Effect diagnostics in that same pass.

### Other packages

Update independent packages separately from the coupled groups:

- `jsonc-parser`
- `tsx`
- `@types/node`
- `vitest`, subject to the `@effect/vitest` compatibility check above
- the `packageManager` Bun pin, only after confirming the intended Bun release

Read changelogs for major-version or runtime/tooling changes. Do not use
`bun update` as a substitute for deciding whether a release-line migration is
safe. Keep direct dependencies exact unless the repository policy changes.

## Apply changes

1. Upgrade one coupled group at a time with Bun and let Bun update `bun.lock`.
2. Make required source migrations immediately after each group so failures
   remain attributable.
3. Update all duplicated pins found by the initial `rg` search.
4. Do not manually rewrite lockfile entries.
5. Do not add lifecycle hooks per tool. Repository consumers have one
   manifest-driven `dev-kit apply --locked` postinstall; new setup behavior
   belongs under manifest `setup` tasks.
6. Keep this skill repository-local under `.agents/skills/update-deps`. Never
   add it to `skills/`, the distributed skill catalog, package `files`, or a
   vendored source manifest.

## Validate

Run all of the following after the final group:

```bash
bun run tsgo:patch
bun run check
bun run test
./bin/dev-kit.mjs tsgo patch --dry-run --project-dir .
npm pack --dry-run --json
git diff --check
```

Also verify:

- `src/` still has no direct `node:*` imports outside an explicit runtime
  adapter or CLI composition boundary.
- all Effect v4 package versions are identical.
- installed TypeScript matches the toolkit tsgo pin and the patched compiler is
  recognized as already patched.
- the npm package contains the runtime implementation but does not contain
  `.agents/skills/update-deps`.
- `docs/dev-kit-plan.md` remains absent from staged and PR files.

Report the old and new versions by group, migrations made, source tags used,
validation results, and any dependency intentionally left unchanged with its
reason.
