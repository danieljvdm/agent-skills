import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { loadSkillCatalog, resolveSkillSources } from "../src/catalog.ts";
import { observePath } from "../src/path-digest.ts";
import { runCommandSuccess } from "./test-platform.ts";

describe("remote catalog resolution", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("materializes an exact approved commit in the consumer cache", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-catalog-" });
        const upstream = path.join(root, "upstream");
        const packageRoot = path.join(root, "package");
        const projectDir = path.join(root, "project");
        yield* fs.makeDirectory(path.join(upstream, "skills", "remote-skill"), { recursive: true });
        yield* fs.makeDirectory(path.join(packageRoot, "skills"), { recursive: true });
        yield* fs.makeDirectory(projectDir);
        const upstreamDocument =
          "---\nname: remote-skill\ndescription: A remote test skill.\ndisable-model-invocation: true\n---\n\nHello.\n";
        yield* fs.writeFileString(
          path.join(upstream, "skills", "remote-skill", "SKILL.md"),
          upstreamDocument,
        );
        yield* runCommandSuccess(upstream, "git", ["init", "-b", "main"]);
        yield* runCommandSuccess(upstream, "git", ["config", "user.name", "Test"]);
        yield* runCommandSuccess(upstream, "git", ["config", "user.email", "test@example.test"]);
        yield* runCommandSuccess(upstream, "git", ["add", "."]);
        yield* runCommandSuccess(upstream, "git", ["commit", "-m", "initial"]);
        const resolved = (yield* runCommandSuccess(upstream, "git", ["rev-parse", "HEAD"])).trim();
        const approved = path.join(root, "approved", "remote-skill");
        yield* fs.copy(path.join(upstream, "skills", "remote-skill"), approved, { overwrite: true });
        yield* fs.writeFileString(
          path.join(approved, "SKILL.md"),
          upstreamDocument.replace("disable-model-invocation: true\n", ""),
        );
        const approvedObservation = yield* observePath(approved);
        assert.strictEqual(approvedObservation.kind, "directory");
        if (approvedObservation.kind !== "directory") return;
        yield* fs.writeFileString(
          path.join(packageRoot, "skill-sources.lock.json"),
          `${JSON.stringify({
            version: 1,
            sources: [{
              id: "test-source",
              repository: upstream,
              ref: "main",
              resolved,
              skillsPath: "skills",
              include: ["remote-skill"],
              skills: ["remote-skill"],
              descriptions: { "remote-skill": "A remote test skill." },
              digests: { "remote-skill": approvedObservation.digest },
              stripFrontmatter: ["disable-model-invocation"],
            }],
          }, null, 2)}\n`,
        );

        const catalog = yield* loadSkillCatalog(packageRoot);
        assert.deepEqual(catalog.families["test-source"], ["remote-skill"]);
        const sources = yield* resolveSkillSources(packageRoot, projectDir, ["remote-skill"]);
        const materialized = sources.get("remote-skill");
        assert.isDefined(materialized);
        const document = yield* fs.readFileString(path.join(materialized!.path, "SKILL.md"));
        assert.include(document, "Hello.");
        assert.notInclude(document, "disable-model-invocation");
        assert.include(materialized!.path, path.join(projectDir, ".dev-kit", "cache"));
        assert.strictEqual(materialized!.catalog?.resolved, resolved);
        assert.isFalse(yield* fs.exists(path.join(packageRoot, "skills", "remote-skill")));

        yield* fs.writeFileString(path.join(materialized!.path, "SKILL.md"), "tampered\n");
        const error = yield* Effect.flip(
          resolveSkillSources(packageRoot, projectDir, ["remote-skill"]),
        );
        assert.match(error.message, /does not match the approved catalog/);
      }));
  });
});
