import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { discoverPackageSkills, resolvePackageSkillSelector } from "../src/package-skill-source.ts";

const writePackage = Effect.fn("writePackageSkillFixturePackage")(function* (
  project: string,
  packageName: string,
  version: string,
  skill: string,
  body = "Nested.",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(project, "node_modules", ...packageName.split("/"));

  yield* fs.makeDirectory(path.join(root, "skills", skill, "nested"), { recursive: true });
  yield* fs.writeFileString(
    path.join(root, "package.json"),
    JSON.stringify({
      name: packageName,
      version,
      intent: {
        version: 1,
        repo: `https://example.test/${packageName}`,
        docs: "https://example.test/docs",
      },
    }),
  );
  yield* fs.writeFileString(
    path.join(root, "skills", skill, "SKILL.md"),
    `---\nname: ${skill}\ndescription: ${packageName} ${skill}.\n---\n`,
  );
  yield* fs.writeFileString(path.join(root, "skills", skill, "nested", "note.md"), body);

  return root;
});

const fixture = Effect.fn("packageSkillFixture")(function* (
  dependencies: Readonly<Record<string, string>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-package-discovery-" });

  yield* fs.writeFileString(path.join(project, "package.json"), JSON.stringify({ dependencies }));

  return project;
});

describe("installed package skill discovery", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("discovers scoped and unscoped direct dependencies, retaining nested files", () =>
      Effect.gen(function* () {
        const project = yield* fixture({ "plain-skills": "1", "@scope/skills": "1" });

        yield* writePackage(project, "plain-skills", "1.0.0", "alpha");
        yield* writePackage(project, "@scope/skills", "2.0.0", "beta");
        const found = yield* discoverPackageSkills(project);

        assert.deepEqual(
          found.candidates.map((skill) => skill.selector),
          ["@scope/skills#beta", "plain-skills#alpha"],
        );
        const exact = yield* resolvePackageSkillSelector(project, "plain-skills#alpha");

        assert.strictEqual(exact.version, "1.0.0");
        assert.isTrue(
          yield* (yield* FileSystem.FileSystem).exists(
            (yield* Path.Path).join(exact.path, "nested", "note.md"),
          ),
        );
      }),
    );

    it.effect("does not browse installed packages that are not direct dependencies", () =>
      Effect.gen(function* () {
        const project = yield* fixture({ "direct-skills": "1" });

        yield* writePackage(project, "direct-skills", "1.0.0", "alpha");
        yield* writePackage(project, "transitive-skills", "1.0.0", "hidden");
        const found = yield* discoverPackageSkills(project);

        assert.deepEqual(
          found.candidates.map((skill) => skill.selector),
          ["direct-skills#alpha"],
        );
      }),
    );

    it.effect("accepts quoted or commented names and multiline descriptions", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const project = yield* fixture({ documented: "1" });
        const root = yield* writePackage(project, "documented", "1.0.0", "alpha");

        yield* writePackage(project, "documented", "1.0.0", "literal");
        yield* fs.writeFileString(
          path.join(root, "skills", "alpha", "SKILL.md"),
          "---\nname: 'alpha' # canonical entry\ndescription: >-\n  First line.\n  Second line.\n---\n",
        );
        yield* fs.writeFileString(
          path.join(root, "skills", "literal", "SKILL.md"),
          "---\nname: literal\ndescription: |+\n  First line.\n  Second line.\n---\n",
        );
        const found = yield* discoverPackageSkills(project);

        assert.strictEqual(found.candidates[0]?.description, "First line. Second line.");
        assert.strictEqual(found.candidates[1]?.description, "First line.\nSecond line.");
      }),
    );

    it.effect("includes development, optional, and peer direct dependencies", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const project = yield* fixture({});

        yield* fs.writeFileString(
          path.join(project, "package.json"),
          JSON.stringify({
            devDependencies: { development: "1" },
            optionalDependencies: { optional: "1" },
            peerDependencies: { peer: "1" },
          }),
        );
        yield* writePackage(project, "development", "1.0.0", "dev");
        yield* writePackage(project, "optional", "1.0.0", "optional");
        yield* writePackage(project, "peer", "1.0.0", "peer");
        const found = yield* discoverPackageSkills(project);

        assert.deepEqual(
          found.candidates.map((skill) => skill.selector),
          ["development#dev", "optional#optional", "peer#peer"],
        );
      }),
    );

    it.effect(
      "uses stable node_modules link paths while canonicalizing pnpm-style package links",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* fixture({ "@scope/skills": "1" });
          const linked = yield* writePackage(project, "@scope/skills", "1.0.0", "alpha");
          const store = path.join(project, ".store", "skills");

          yield* fs.makeDirectory(path.dirname(store), { recursive: true });
          yield* fs.rename(linked, store);
          yield* fs.symlink(store, linked);
          const first = yield* resolvePackageSkillSelector(project, "@scope/skills#alpha");

          assert.strictEqual(
            first.linkPath,
            path.join(project, "node_modules", "@scope", "skills", "skills", "alpha"),
          );
          assert.strictEqual(first.path, path.join(yield* fs.realPath(store), "skills", "alpha"));
        }),
    );

    it.effect(
      "skips malformed packages in discovery and reports diagnostics, while exact selection fails",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* fixture({
            good: "1",
            broken: "1",
            missing: "1",
            nodescription: "1",
            unmarked: "1",
          });

          yield* writePackage(project, "good", "1.0.0", "alpha");
          const broken = yield* writePackage(project, "broken", "1.0.0", "beta");

          yield* writePackage(project, "broken", "1.0.0", "valid");
          const unmarked = yield* writePackage(project, "unmarked", "1.0.0", "gamma");
          const nodescription = yield* writePackage(project, "nodescription", "1.0.0", "delta");

          yield* fs.writeFileString(
            path.join(nodescription, "skills", "delta", "SKILL.md"),
            "---\nname: delta\n---\n",
          );
          yield* fs.writeFileString(
            path.join(unmarked, "package.json"),
            '{"name":"unmarked","version":"1.0.0"}',
          );
          yield* fs.writeFileString(
            path.join(broken, "skills", "beta", "SKILL.md"),
            "---\nname: nope\n---\n",
          );
          const found = yield* discoverPackageSkills(project);

          assert.deepEqual(
            found.candidates.map((skill) => skill.selector),
            ["broken#valid", "good#alpha"],
          );
          assert.deepEqual(
            found.diagnostics.map((diagnostic) => diagnostic.package),
            ["broken", "nodescription", "unmarked"],
          );
          const missing = yield* Effect.flip(resolvePackageSkillSelector(project, "missing#none"));

          assert.match(missing.message, /not installed/);
          const malformed = yield* Effect.flip(resolvePackageSkillSelector(project, "broken#beta"));

          assert.match(malformed.message, /name must match/);
        }),
    );

    it.effect(
      "rejects symlinked skill trees and keeps duplicate skill names distinct by selector",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* fixture({ one: "1", two: "1", linked: "1" });

          yield* writePackage(project, "one", "1.0.0", "same");
          yield* writePackage(project, "two", "1.0.0", "same");
          const linked = yield* writePackage(project, "linked", "1.0.0", "bad");
          const outside = path.join(project, "outside");

          yield* fs.writeFileString(outside, "no");
          yield* fs.symlink(outside, path.join(linked, "skills", "bad", "escape"));
          const found = yield* discoverPackageSkills(project);

          assert.deepEqual(
            found.candidates.map((skill) => skill.selector),
            ["one#same", "two#same"],
          );
          const rejected = yield* Effect.flip(resolvePackageSkillSelector(project, "linked#bad"));

          assert.match(rejected.message, /contains a symlink/);
        }),
    );
  });
});
