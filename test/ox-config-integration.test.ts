import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { repositoryRoot, runCommand } from "./test-platform.ts";

describe("shared Oxlint and Oxfmt configuration", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("loads in standalone tools and Vite+", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* repositoryRoot();
        const fixture = path.join(root, "test", "fixtures", "ox-config-consumer");
        const oxlint = path.join(root, "node_modules", ".bin", "oxlint");
        const oxfmt = path.join(root, "node_modules", ".bin", "oxfmt");
        const vitePlus = path.join(root, "node_modules", ".bin", "vp");
        const standaloneEnv = { VP_VERSION: "" };

        const standaloneLint = yield* runCommand(
          fixture,
          oxlint,
          ["--config", "oxlint.config.mjs", "valid.ts"],
          standaloneEnv,
        );

        assert.strictEqual(standaloneLint.exitCode, 0, standaloneLint.output);

        const effectLint = yield* runCommand(
          fixture,
          oxlint,
          ["--config", "oxlint.config.mjs", "invalid.js"],
          standaloneEnv,
        );

        assert.notStrictEqual(effectLint.exitCode, 0);
        assert.include(effectLint.output, "effect(no-effect-run)");

        const standaloneFormat = yield* runCommand(
          fixture,
          oxfmt,
          ["--config", "oxfmt.config.mjs", "valid.ts", "--check"],
          standaloneEnv,
        );

        assert.strictEqual(standaloneFormat.exitCode, 0, standaloneFormat.output);

        const vitePlusLint = yield* runCommand(fixture, vitePlus, ["lint", "valid.ts"]);

        assert.strictEqual(vitePlusLint.exitCode, 0, vitePlusLint.output);

        const vitePlusFormat = yield* runCommand(fixture, vitePlus, ["fmt", "valid.ts", "--check"]);

        assert.strictEqual(vitePlusFormat.exitCode, 0, vitePlusFormat.output);

        const spacingDir = yield* fs.makeTempDirectoryScoped({
          directory: fixture,
          prefix: ".spacing-test-",
        });
        const spacingFile = path.join(spacingDir, "spacing.ts");

        yield* fs.writeFileString(
          spacingFile,
          "const load = () => {\n  const value = 1;\n  return value;\n};\n",
        );
        const spacingLint = yield* runCommand(
          fixture,
          oxlint,
          ["--config", "oxlint.config.mjs", spacingFile],
          standaloneEnv,
        );

        assert.notStrictEqual(spacingLint.exitCode, 0);
        assert.include(spacingLint.output, "stylistic(padding-line-between-statements)");

        const fixedSpacing = yield* runCommand(
          fixture,
          oxlint,
          ["--fix", "--config", "oxlint.config.mjs", spacingFile],
          standaloneEnv,
        );

        assert.strictEqual(fixedSpacing.exitCode, 0, fixedSpacing.output);
        assert.include(
          yield* fs.readFileString(spacingFile),
          "  const value = 1;\n\n  return value;",
        );

        const importsDir = yield* fs.makeTempDirectoryScoped({
          directory: fixture,
          prefix: ".imports-test-",
        });
        const importsFile = path.join(importsDir, "imports.ts");

        yield* fs.writeFileString(
          path.join(importsDir, "types.ts"),
          "export class RuntimeValue {}\nexport interface TypeOnly {}\n",
        );
        yield* fs.writeFileString(
          path.join(importsDir, "tsconfig.json"),
          `${JSON.stringify(
            {
              compilerOptions: {
                module: "NodeNext",
                moduleResolution: "NodeNext",
                strict: true,
                target: "ES2024",
              },
              include: ["*.ts"],
            },
            null,
            2,
          )}\n`,
        );
        yield* fs.writeFileString(
          importsFile,
          'import { RuntimeValue, TypeOnly } from "./types.ts";\n\nconst value = new RuntimeValue();\ntype Shape = TypeOnly;\n\nvoid value;\nvoid (null as unknown as Shape);\n',
        );

        const fixedImports = yield* runCommand(
          fixture,
          oxlint,
          ["--fix", "--type-aware", "--config", "oxlint.config.mjs", importsFile],
          standaloneEnv,
        );

        assert.strictEqual(fixedImports.exitCode, 0, fixedImports.output);
        assert.include(
          yield* fs.readFileString(importsFile),
          'import { RuntimeValue, type TypeOnly } from "./types.ts";',
        );

        const schemaAliasFile = path.join(importsDir, "schema-alias.ts");

        yield* fs.writeFileString(
          schemaAliasFile,
          'import { Schema } from "effect";\n\nexport const Name = Schema.String;\nexport const namespace = { Schema };\nexport { Schema };\n',
        );
        const schemaAliasLint = yield* runCommand(
          fixture,
          oxlint,
          ["--config", "oxlint.config.mjs", schemaAliasFile],
          standaloneEnv,
        );

        assert.notStrictEqual(schemaAliasLint.exitCode, 0);
        assert.include(schemaAliasLint.output, "effect(prefer-schema-alias)");

        const fixedSchemaAlias = yield* runCommand(
          fixture,
          oxlint,
          ["--fix", "--config", "oxlint.config.mjs", schemaAliasFile],
          standaloneEnv,
        );

        assert.strictEqual(fixedSchemaAlias.exitCode, 0, fixedSchemaAlias.output);
        assert.strictEqual(
          yield* fs.readFileString(schemaAliasFile),
          'import { Schema as S } from "effect";\n\nexport const Name = S.String;\nexport const namespace = { Schema: S };\nexport { S as Schema };\n',
        );
      }),
    );
  });
});
