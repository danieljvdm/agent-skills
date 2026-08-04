import { Config, Console, Effect, Option, Terminal } from "effect";

const ANSI = {
  clearLine: "\r\u001b[2K",
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  reset: "\u001b[0m",
  yellow: "\u001b[33m",
} as const;

type StatusKind = "success" | "info" | "plan" | "error";

const statusAppearance: Readonly<Record<StatusKind, readonly [string, string]>> = {
  success: ["✓", ANSI.green],
  info: ["•", ANSI.cyan],
  plan: ["→", ANSI.yellow],
  error: ["✗", ANSI.red],
};

const terminalCapabilities = Effect.fn("terminalCapabilities")(function* () {
  const terminal = yield* Terminal.Terminal;
  const columns = yield* terminal.columns;
  const noColor = yield* Config.string("NO_COLOR").pipe(Config.option, Effect.orDie);
  const term = yield* Config.string("TERM").pipe(Config.withDefault(""), Effect.orDie);
  const ci = yield* Config.string("CI").pipe(Config.withDefault(""), Effect.orDie);
  const interactive = columns > 0 && term !== "dumb" && ci !== "true" && ci !== "1";

  return {
    color: interactive && Option.isNone(noColor),
    interactive,
    terminal,
  };
});

export const isInteractiveTerminal = terminalCapabilities().pipe(
  Effect.map((capabilities) => capabilities.interactive),
);

const formatDetail = (detail: string | undefined, color: boolean): string =>
  detail === undefined || detail.length === 0
    ? ""
    : color
      ? ` ${ANSI.dim}${detail}${ANSI.reset}`
      : ` ${detail}`;

export const printStatus = Effect.fn("printCliStatus")(function* (
  kind: StatusKind,
  label: string,
  detail?: string,
) {
  const capabilities = yield* terminalCapabilities();
  const [symbol, color] = statusAppearance[kind];
  const prefix = capabilities.color ? `${color}${symbol}${ANSI.reset}` : symbol;

  yield* capabilities.terminal
    .display(`${prefix} ${label}${formatDetail(detail, capabilities.color)}\n`)
    .pipe(Effect.orDie);
});

export const printDetail = Effect.fn("printCliDetail")(function* (text: string) {
  const capabilities = yield* terminalCapabilities();

  yield* capabilities.terminal
    .display(capabilities.color ? `  ${ANSI.dim}${text}${ANSI.reset}\n` : `  ${text}\n`)
    .pipe(Effect.orDie);
});

export const printLine = Effect.fn("printCliLine")(function* (text = "") {
  const capabilities = yield* terminalCapabilities();

  yield* capabilities.terminal.display(`${text}\n`).pipe(Effect.orDie);
});

export const withSpinner = <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Terminal.Terminal> =>
  Effect.gen(function* () {
    const capabilities = yield* terminalCapabilities();

    if (!capabilities.interactive) return yield* effect;

    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let index = 0;
    const animate = Effect.forever(
      Effect.suspend(() => {
        const frame = frames[index++ % frames.length];
        const symbol = capabilities.color ? `${ANSI.cyan}${frame}${ANSI.reset}` : frame;

        return capabilities.terminal
          .display(`${ANSI.clearLine}${symbol} ${label}`)
          .pipe(Effect.orDie, Effect.andThen(Effect.sleep("80 millis")));
      }),
    );
    const fiber = yield* Effect.forkChild(animate);

    return yield* effect.pipe(
      Effect.ensuring(
        Effect.sync(() => fiber.interruptUnsafe()).pipe(
          Effect.andThen(capabilities.terminal.display(ANSI.clearLine).pipe(Effect.orDie)),
        ),
      ),
    );
  });

export const printError = Effect.fn("printCliError")(function* (message: string) {
  const capabilities = yield* terminalCapabilities();
  const [symbol, color] = statusAppearance.error;
  const prefix = capabilities.color ? `${color}${symbol}${ANSI.reset}` : symbol;

  yield* Console.error(`${prefix} ${message}`);
});
