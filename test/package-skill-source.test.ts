import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { resolvePackageSkillSource } from "../src/package-skill-source.ts";

const source = {
  id: "test-package",
  package: "@scope/skills",
  skillsPath: "skills",
  skills: ["alpha"],
};

const writeFixture = Effect.fn("writePackageSkillFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-package-skills-" });
  const project = path.join(root, "project");
  const packageRoot = path.join(root, "store", "skills");
  yield* fs.makeDirectory(path.join(project, "node_modules", "@scope"), { recursive: true });
  yield* fs.makeDirectory(path.join(packageRoot, "skills", "alpha"), { recursive: true });
  yield* fs.writeFileString(
    path.join(packageRoot, "package.json"),
    '{"name":"@scope/skills","version":"1.2.3"}\n',
  );
  yield* fs.writeFileString(
    path.join(packageRoot, "skills", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: Test skill.\n---\n\nHello.\n",
  );
  yield* fs.symlink(packageRoot, path.join(project, "node_modules", "@scope", "skills"));
  return { packageRoot, project, root };
});

describe("package skill sources", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("canonicalizes a pnpm-style package-root link and returns selected paths and version", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* writeFixture();

        const resolved = yield* resolvePackageSkillSource(fixture.project, source, ["alpha"]);

        assert.deepEqual(resolved.get("alpha"), {
          path: path.join(yield* fs.realPath(fixture.packageRoot), "skills", "alpha"),
          linkPath: path.join(
            fixture.project,
            "node_modules",
            "@scope",
            "skills",
            "skills",
            "alpha",
          ),
          version: "1.2.3",
        });
        assert.isTrue(yield* fs.exists(path.join(fixture.packageRoot, "skills", "alpha", "SKILL.md")));
      }));

    it.effect("rejects missing or malformed package metadata before returning skill paths", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* writeFixture();
        yield* fs.writeFileString(path.join(fixture.packageRoot, "package.json"), "not json\n");

        const malformed = yield* Effect.flip(resolvePackageSkillSource(fixture.project, source, ["alpha"]));
        assert.match(malformed.message, /invalid package\.json/);

        const missing = yield* Effect.flip(resolvePackageSkillSource(fixture.project, {
          ...source,
          package: "@scope/missing",
        }, ["alpha"]));
        assert.match(missing.message, /not installed/);
      }));

    it.effect("rejects traversal and a skill root that resolves outside the canonical package", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* writeFixture();
        const outside = path.join(fixture.root, "outside");
        yield* fs.makeDirectory(outside);
        yield* fs.symlink(outside, path.join(fixture.packageRoot, "escape"));

        const invalidPackage = yield* Effect.flip(resolvePackageSkillSource(fixture.project, {
          ...source,
          package: "../outside",
        }, ["alpha"]));
        assert.match(invalidPackage.message, /invalid package/);

        const escapedPath = yield* Effect.flip(resolvePackageSkillSource(fixture.project, {
          ...source,
          skillsPath: "../outside",
        }, ["alpha"]));
        assert.match(escapedPath.message, /invalid package skill source skills path/);

        const escapedSkill = yield* Effect.flip(resolvePackageSkillSource(fixture.project, {
          ...source,
          skillsPath: "escape",
        }, ["alpha"]));
        assert.match(escapedSkill.message, /skills path contains a symlink/);

        yield* fs.symlink(".", path.join(fixture.packageRoot, "nested"));
        const nestedLink = yield* Effect.flip(resolvePackageSkillSource(fixture.project, {
          ...source,
          skillsPath: "nested/skills",
        }, ["alpha"]));
        assert.match(nestedLink.message, /skills path contains a symlink/);
      }));

    it.effect("rejects missing skills, malformed frontmatter, and mismatched names", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* writeFixture();
        const unapproved = yield* Effect.flip(resolvePackageSkillSource(
          fixture.project,
          source,
          ["not-approved"],
        ));
        assert.match(unapproved.message, /not approved/);
        const missing = yield* Effect.flip(resolvePackageSkillSource(fixture.project, {
          ...source,
          skills: ["missing"],
        }, ["missing"]));
        assert.match(missing.message, /does not exist/);

        yield* fs.writeFileString(path.join(fixture.packageRoot, "skills", "alpha", "SKILL.md"), "no frontmatter\n");
        const malformed = yield* Effect.flip(resolvePackageSkillSource(fixture.project, source, ["alpha"]));
        assert.match(malformed.message, /name must match/);

        yield* fs.writeFileString(path.join(fixture.packageRoot, "skills", "alpha", "SKILL.md"), "---\nname: beta\n---\n");
        const mismatched = yield* Effect.flip(resolvePackageSkillSource(fixture.project, source, ["alpha"]));
        assert.match(mismatched.message, /name must match/);
      }));

    it.effect("recursively rejects symlinks within a selected skill tree", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* writeFixture();
        const outside = path.join(fixture.root, "outside.txt");
        yield* fs.writeFileString(outside, "do not read\n");
        yield* fs.symlink(outside, path.join(fixture.packageRoot, "skills", "alpha", "nested-link"));

        const error = yield* Effect.flip(resolvePackageSkillSource(fixture.project, source, ["alpha"]));
        assert.match(error.message, /contains a symlink/);
        assert.strictEqual(yield* fs.readFileString(outside), "do not read\n");
      }));
  });
});
