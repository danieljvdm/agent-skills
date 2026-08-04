import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { repositoryRoot } from "./test-platform.ts";

describe("Effect platform boundaries", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("keeps authored TypeScript free of direct Node APIs", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* repositoryRoot();
        const files = (yield* Effect.forEach(
          [path.join(root, "src"), path.join(root, "test")],
          (directory) =>
            fs
              .glob("**/*.ts", { root: directory })
              .pipe(Effect.map((entries) => entries.map((entry) => path.join(directory, entry)))),
        )).flat();
        const nodeScheme = `node${":"}`;
        const directNodeApi = new RegExp(
          `(?:from\\s+["']${nodeScheme}|require\\(["']${nodeScheme}|\\bprocess\\.)`,
        );

        for (const file of files) {
          const source = yield* fs.readFileString(file);
          assert.notMatch(
            source,
            directNodeApi,
            `${path.relative(root, file)} bypasses Effect platform services`,
          );
        }
      }),
    );
  });
});
