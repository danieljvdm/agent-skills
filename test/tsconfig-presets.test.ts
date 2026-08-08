import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import packageMetadata from "../package.json" with { type: "json" };
import base from "../tsconfig/base.json" with { type: "json" };
import bundler from "../tsconfig/bundler.json" with { type: "json" };
import react from "../tsconfig/react.json" with { type: "json" };
import worker from "../tsconfig/worker.json" with { type: "json" };
import { repositoryRoot, runCommand } from "./test-platform.ts";

describe("TypeScript config presets", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("publishes every preset through an explicit package export", () =>
      Effect.sync(() => {
        assert.include(packageMetadata.files, "tsconfig/");
        assert.deepInclude(packageMetadata.exports, {
          "./tsconfig/base.json": "./tsconfig/base.json",
          "./tsconfig/bundler.json": "./tsconfig/bundler.json",
          "./tsconfig/react.json": "./tsconfig/react.json",
          "./tsconfig/worker.json": "./tsconfig/worker.json",
        });
      }),
    );

    it.effect("keeps runtime assumptions in composable overlays", () =>
      Effect.sync(() => {
        assert.deepInclude(base.compilerOptions, {
          noEmit: true,
          strict: true,
          types: [],
        });
        assert.notProperty(base.compilerOptions, "lib");
        assert.notProperty(base.compilerOptions, "module");
        assert.notProperty(base.compilerOptions, "target");
        assert.deepInclude(bundler, {
          extends: "./base.json",
          compilerOptions: {
            isolatedModules: true,
            lib: ["ES2022"],
            module: "ESNext",
            moduleResolution: "Bundler",
            target: "ES2022",
          },
        });
        assert.deepInclude(react, {
          extends: "./bundler.json",
          compilerOptions: {
            jsx: "react-jsx",
            lib: ["ES2022", "DOM", "DOM.Iterable"],
          },
        });
        assert.deepInclude(worker, {
          extends: "./bundler.json",
          compilerOptions: { lib: ["ES2022", "WebWorker"] },
        });
      }),
    );

    it.effect("resolves a published preset from an installed package path", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* repositoryRoot();
        const project = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-tsconfig-consumer-",
        });
        const packageDirectory = path.join(project, "node_modules", "@danieljvdm", "dev-kit");

        yield* fs.makeDirectory(path.dirname(packageDirectory), { recursive: true });
        yield* fs.symlink(root, packageDirectory);
        yield* fs.makeDirectory(path.join(project, "src"), { recursive: true });
        yield* fs.writeFileString(
          path.join(project, "tsconfig.json"),
          `${JSON.stringify(
            {
              extends: "@danieljvdm/dev-kit/tsconfig/worker.json",
              include: ["src/**/*.ts"],
            },
            null,
            2,
          )}\n`,
        );
        yield* fs.writeFileString(
          path.join(project, "src", "index.ts"),
          "export const workerScope: WorkerGlobalScope = self;\n",
        );

        const result = yield* runCommand(project, path.join(root, "node_modules", ".bin", "tsc"), [
          "--noEmit",
          "--project",
          "tsconfig.json",
        ]);

        assert.strictEqual(result.exitCode, 0, result.output);
      }),
    );

    it.effect("preserves an inherited Effect plugin when adding a runtime preset", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* repositoryRoot();
        const project = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-tsconfig-effect-consumer-",
        });
        const nodeModules = path.join(project, "node_modules");
        const packageDirectory = path.join(nodeModules, "@danieljvdm", "dev-kit");

        yield* fs.makeDirectory(path.dirname(packageDirectory), { recursive: true });
        yield* fs.symlink(root, packageDirectory);
        yield* fs.symlink(
          path.join(root, "node_modules", "effect"),
          path.join(nodeModules, "effect"),
        );
        yield* fs.makeDirectory(path.join(project, "src"), { recursive: true });
        yield* fs.writeFileString(
          path.join(project, "tsconfig.root.json"),
          `${JSON.stringify(
            {
              extends: "@danieljvdm/dev-kit/tsconfig/base.json",
              compilerOptions: {
                plugins: [
                  {
                    name: "@effect/language-service",
                    diagnosticSeverity: { anyUnknownInErrorContext: "error" },
                  },
                ],
              },
              files: [],
            },
            null,
            2,
          )}\n`,
        );
        yield* fs.writeFileString(
          path.join(project, "tsconfig.json"),
          `${JSON.stringify(
            {
              extends: ["./tsconfig.root.json", "@danieljvdm/dev-kit/tsconfig/worker.json"],
              include: ["src/**/*.ts"],
            },
            null,
            2,
          )}\n`,
        );
        yield* fs.writeFileString(
          path.join(project, "src", "index.ts"),
          'import { Effect } from "effect";\n\nconst program: Effect.Effect<void, any> = Effect.void;\n\nexport const running = Effect.runPromise(program);\n',
        );

        const result = yield* runCommand(project, path.join(root, "node_modules", ".bin", "tsc"), [
          "--noEmit",
          "--project",
          "tsconfig.json",
        ]);

        assert.notStrictEqual(result.exitCode, 0);
        assert.include(result.output, "effect(anyUnknownInErrorContext)");
      }),
    );
  });
});
