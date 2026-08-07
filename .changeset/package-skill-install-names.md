---
"@danieljvdm/dev-kit": minor
---

Install package-bundled skills under package-qualified directory names. A selected `<package>#<skill>` now installs by flattening the package name (drop `@`, turn every other non-alphanumeric run into one dash) and appending the skill name, so `@tanstack/table-core#core` installs as `tanstack-table-core-core` instead of the collision-prone bare `core`. The copied `SKILL.md` frontmatter `name:` is rewritten to the same install name; manifest selectors, CLI listings, and the lock's catalog provenance keep the original `<package>#<skill>` identity, bare skill name, and `node_modules` content digest. Symlink-mode targets still link into `node_modules`, so only the link name carries the qualifier. On the next apply, previously installed bare-name package-skill directories are renamed through the normal plan and the lock regenerates.
