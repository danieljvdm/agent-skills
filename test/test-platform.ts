import { Effect, Path, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

export type TestCommandResult = {
  readonly exitCode: number;
  readonly output: string;
};

export const repositoryRoot = Effect.fn("testRepositoryRoot")(function* () {
  const path = yield* Path.Path;
  const helperPath = yield* path.fromFileUrl(new URL(import.meta.url));
  return path.resolve(path.dirname(helperPath), "..");
});

export const runCommand = Effect.fn("runTestCommand")(function* (
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
) {
  const child = yield* ChildProcess.make(command, args, {
    cwd,
    ...(env === undefined ? {} : { env, extendEnv: true }),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [output, exitCode] = yield* Effect.all([
    Stream.mkString(Stream.decodeText(child.all)),
    child.exitCode,
  ]);
  return { exitCode, output } satisfies TestCommandResult;
});

export const runCommandSuccess = Effect.fn("runSuccessfulTestCommand")(function* (
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const result = yield* runCommand(cwd, command, args);
  if (result.exitCode !== 0) {
    return yield* Effect.die(
      new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.output}`),
    );
  }
  return result.output;
});

export const runDevKit = Effect.fn("runTestDevKit")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
) {
  const path = yield* Path.Path;
  const root = yield* repositoryRoot();
  const tsx = yield* path.fromFileUrl(new URL(import.meta.resolve("tsx")));
  return yield* runCommand(cwd, "node", [
    "--import",
    tsx,
    path.join(root, "src", "bin", "dev-kit.ts"),
    ...args,
  ], env);
});
