import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { repositoryRoot, runCommand } from "./test-platform.ts";

describe("published CLI", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("runs with Bun outside the package tree", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* repositoryRoot();
        const consumerDir = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-bin-consumer-" });
        const result = yield* runCommand(consumerDir, path.join(root, "bin", "dev-kit.mjs"), [
          "--help",
        ]);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.include(result.output, "Your approved skill catalog for coding agents.");
      }),
    );

    it.effect("rejects direct Node execution", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* repositoryRoot();
        const consumerDir = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-bin-consumer-" });
        const result = yield* runCommand(consumerDir, "node", [
          path.join(root, "bin", "dev-kit.mjs"),
          "--help",
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.include(result.output, "Dev Kit requires the Bun runtime");
      }),
    );

    it.effect("rejects an unsupported Bun version before importing the CLI", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* repositoryRoot();
        const consumerDir = yield* fs.makeTempDirectoryScoped({ prefix: "dev-kit-bin-consumer-" });
        const bootstrap = path.join(root, "bin", "dev-kit.mjs");
        const result = yield* runCommand(consumerDir, "node", [
          "--input-type=module",
          "--eval",
          `globalThis.Bun = { version: "1.2.99" }; await import(${JSON.stringify(bootstrap)});`,
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.include(result.output, "Dev Kit requires Bun 1.3.0 or newer; found 1.2.99");
      }),
    );
  });
});
