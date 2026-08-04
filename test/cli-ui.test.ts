import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { ConfigProvider, Effect, Ref, Terminal } from "effect";

import { printStatus, withSpinner } from "../src/cli-ui.ts";
import { runDevKit } from "./test-platform.ts";

const captureStatus = Effect.fn("captureCliStatus")(function* (
  columns: number,
  environment: Record<string, string> = {},
) {
  const output = yield* Ref.make("");
  const terminal = Terminal.make({
    columns: Effect.succeed(columns),
    rows: Effect.succeed(24),
    readInput: Effect.never,
    readLine: Effect.never,
    display: (text) => Ref.update(output, (current) => current + text),
  });
  const provider = ConfigProvider.fromEnv({ env: environment });

  yield* printStatus("success", "Dev kit ready", "2 changes").pipe(
    Effect.provideService(Terminal.Terminal, terminal),
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
  );

  return yield* Ref.get(output);
});

const captureSpinner = Effect.fn("captureCliSpinner")(function* () {
  const output = yield* Ref.make("");
  const terminal = Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.never,
    readLine: Effect.never,
    display: (text) => Ref.update(output, (current) => current + text),
  });
  const provider = ConfigProvider.fromEnv({ env: { TERM: "xterm-256color" } });

  yield* withSpinner("Working", Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow))).pipe(
    Effect.provideService(Terminal.Terminal, terminal),
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
  );

  return yield* Ref.get(output);
});

describe("CLI presentation", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("keeps piped output compact and free of ANSI escapes", () =>
      Effect.gen(function* () {
        const output = yield* captureStatus(0);

        assert.strictEqual(output, "✓ Dev kit ready 2 changes\n");
        assert.notInclude(output, "\u001b[");
      }),
    );

    it.effect("uses restrained color only for interactive terminals", () =>
      Effect.gen(function* () {
        const colored = yield* captureStatus(80, { TERM: "xterm-256color" });

        assert.include(colored, "\u001b[32m✓\u001b[0m");
        assert.include(colored, "\u001b[2m2 changes\u001b[0m");

        const disabled = yield* captureStatus(80, {
          NO_COLOR: "1",
          TERM: "xterm-256color",
        });

        assert.strictEqual(disabled, "✓ Dev kit ready 2 changes\n");
      }),
    );

    it.effect("animates transient work and clears the progress line", () =>
      Effect.gen(function* () {
        const output = yield* captureSpinner();

        assert.include(output, "Working");
        assert.match(output, /⠋|⠙|⠹/);
        assert.isTrue(output.endsWith("\r\u001b[2K"));
      }),
    );

    it.effect("treats subcommand help as normal control flow", () =>
      Effect.gen(function* () {
        const result = yield* runDevKit(".", ["tsgo"]);

        assert.strictEqual(result.exitCode, 0, result.output);
        assert.match(result.output, /SUBCOMMANDS[\s\S]*patch/);
        assert.notInclude(result.output, "Help requested");
      }),
    );
  });
});
