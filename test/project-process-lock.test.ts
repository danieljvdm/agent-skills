import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import { acquireProjectProcessLock } from "../src/project-process-lock.ts";

const ProcessLockOwnerSchema = Schema.Struct({
  version: Schema.Literal(1),
  toolVersion: Schema.String,
  token: Schema.String,
  startedAt: Schema.String,
});

describe("project process lock", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("uses Effect-owned metadata and releases only its own lock", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "dev-kit-process-lock-test-",
        });
        const lockDir = path.join(projectDir, ".dev-kit", "apply.lock");
        const ownerPath = path.join(lockDir, "owner.json");

        yield* Effect.scoped(
          Effect.gen(function* () {
            assert.strictEqual(yield* acquireProjectProcessLock(projectDir), lockDir);
            const owner = yield* Schema.decodeEffect(Schema.fromJsonString(ProcessLockOwnerSchema))(
              yield* fs.readFileString(ownerPath),
            );

            assert.isString(owner.token);
            assert.isString(owner.startedAt);
            assert.notProperty(owner, "pid");
            assert.notProperty(owner, "host");

            yield* fs.writeFileString(ownerPath, "replacement owner\n");
          }),
        );

        assert.isTrue(yield* fs.exists(lockDir));
        assert.strictEqual(yield* fs.readFileString(ownerPath), "replacement owner\n");
      }),
    );
  });
});
