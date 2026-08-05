# @danieljvdm/dev-kit

## 0.10.0

### Minor Changes

- b445126: Approve Expo's official framework and EAS skills from `expo/skills` in the external skill catalog.

## 0.9.0

### Minor Changes

- 569ddd4: Add a high-bar `testing` skill and approve the upstream `tdd` and `improve-codebase-architecture` skills.

## 0.8.0

### Minor Changes

- fddf528: Expand the `effect-ts` umbrella with lazy Effect DateTime and Effect Atom references. The DateTime guidance prefers Effect DateTime over JavaScript Date for domain logic and covers parsing, schemas, time zones, arithmetic, formatting, interoperability, and deterministic `TestClock` tests. The existing `effect-atom-data-fetching` selector remains as a compatibility alias.

### Patch Changes

- 2c51b1d: Let Vite+ quality consumers independently opt into managed config or workflow resources, including repository-specific workflow preparation and typecheck commands.

## 0.7.2

### Patch Changes

- d50151b: Make opt-in Vite+ quality CI deterministic with one frozen install, locked Dev Kit convergence, compatible consumer Vite+ validation, and explicit single-project or workspace typechecking.

## 0.7.1

### Patch Changes

- 28c7338: Allow a committed lock to re-establish ownership and update unchanged managed outputs when local state is absent, including locks written before file-mode digest normalization.

## 0.7.0

### Minor Changes

- 8fd5e6f: Add opt-in Vite+ Git hook and quality convergence, including worktree-local dispatcher setup, digest-owned canonical config and GitHub Actions files for supported Effect repositories, and readable statement spacing in the shared Oxlint preset.

### Patch Changes

- a43887e: Make Effect TypeScript-Go patch detection converge across npm, pnpm, and Bun installs.
- 091a24e: Normalize regular file permissions to Git executable semantics when digesting managed paths, preventing catalog integrity false positives across different umasks.

## 0.6.0

### Minor Changes

- c67a1e9: Add an opt-in managed `AGENTS.md` wrapper with dev-kit guidance, conditional
  Vite+ instructions for direct dependencies, and atomic `CLAUDE.md` symlink
  support.
- 6dae6a3: Add a bundled `effect-atom-data-fetching` skill for React cache lifecycle, HTTP queries and mutations, invalidation, SSR boundaries, framework integration, and deterministic testing.

### Patch Changes

- 355ca42: Recommend automatic lifecycle applies for dependency upgrades while reserving locked mode for strict CI verification.

## 0.5.0

### Minor Changes

- c484992: Add a manifest-managed `CLAUDE.md` symlink to project-root `AGENTS.md` with lockfile ownership and conflict-safe cleanup.
- f57b12d: Discover Intent-style skills in installed direct dependencies and expose them
  through package-qualified selectors. Package skills remain browse-only until
  the user explicitly adds one, and selected package versions and content are
  recorded in the project lock.

## 0.4.0

### Minor Changes

- 2864a3c: Add canonical Oxlint and Oxfmt configurations that work with both standalone Oxc tools and Vite+, and publish Egte's reusable Effect lint rules as a shared Oxlint JavaScript plugin.

## 0.3.3

### Patch Changes

- 221eab6: Remove the obsolete `check:scripts` command from the generated Effect CLI guide.

## 0.3.2

### Patch Changes

- 17950fe: Keep the recommended type-aware preset focused by disabling incidental default warnings and allowing test assertions to use non-null narrowing.

## 0.3.1

### Patch Changes

- deb451c: Ship the Oxlint preset as JavaScript at runtime so Vite+ can load it from node_modules.

## 0.3.0

### Minor Changes

- 736aa78: Add a typed, composable recommended Oxlint preset for Vite+ projects.

## 0.2.3

### Patch Changes

- 835fb15: Teach project agents to derive a capability inventory from repository evidence
  and choose focused skills instead of generic umbrellas or whole source families.

## 0.2.2

### Patch Changes

- 3180d85: Regenerate the dogfood lock whenever Changesets bumps the package version. Guide
  consumers toward individually relevant external skills, show source provenance
  while browsing, and warn when source-family shorthand selects an entire source.

## 0.2.1

### Patch Changes

- 60bdf42: Add Changesets-based versioning and automated npm releases.
- 9100138: Harden project initialization, catalog refresh locking, and late apply race detection.
