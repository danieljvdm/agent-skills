# Changesets

This folder contains release notes consumed by Changesets. Add one for each
pull request that changes the published package:

```sh
bun run changeset
```

Choose the release type, describe the user-facing change, and commit the new
Markdown file with the rest of the pull request.

Changes merged to `main` are collected into a version pull request. Merging
that pull request publishes the package and creates the corresponding GitHub
release.
