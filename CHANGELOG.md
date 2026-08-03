# @danieljvdm/dev-kit

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
